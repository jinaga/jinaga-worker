# Starting a worker

**Read this before deploying a worker.**

`start()` is the first line a caller writes against this library, and the boot
path around it is the one place a wrong choice takes the whole process down.
This page is about that boot path: which shape to write, and what each one
costs.

What `start()` resolves and rejects with is stated where you call it, on
`Worker.start` and `WorkerOptions.startTimeoutMs`, and in
[§3.1 of the specification](https://github.com/jinaga/jinaga-worker/blob/main/design/durable-consumer-spec.md#31-start).
This page does not repeat it. It decides what your boot path does with it.

## Three axes

Your boot path answers three questions, and the shape follows from the answers.
There is no list of named recipes to find yourself in.

1. **Does the boot path await `start()` before it serves anything?**
2. **Is `startTimeoutMs` set?**
3. **What does the boot path do with a rejection?** Exit, record it and keep
   serving, or retry in process.

## Where the axes bend

They are not independent, and this is the paragraph worth reading twice.

**With no bound, an unresponsive replicator never reaches the third axis.** The
subscribe stays pending, and that same pending call is answered when the
replicator returns. The waiting *is* the retry, and it beats a loop, because
nothing is torn down and nothing is rebuilt. Only a structural denial reaches
the third axis in that column; setting a bound is what populates the rest of it.

**A boot path that does not await has already answered the third question.** It
is serving. It cannot exit on a rejection without taking down routes that are
answering, so what is left to it is to record the failure and let readiness
carry the news.

## A service with routes of its own

If the process serves anything that reads its own local mirror — an API,
`/health`, a page — do not await `start()`. Keep the handle, gate readiness on
it, and set no bound.

```ts
const worker = createWorker(j, { consumers });

let started = false;
const starting = worker.start().then(
    () => { started = true; },
    error => { logger.error({ error }, "the worker did not start"); }
);

// Answer these from the routes you already serve, and listen before either.
const live = () => true;
const ready = () => started;

process.on("SIGTERM", async () => {
    await starting;
    await worker.stop();
});
```

The process is alive and serving from its first request. Readiness stays false
until every consumer's stream is running, so a load balancer sends it nothing in
the meantime and an operator can see which half is down.

The handle is kept rather than discarded. It gives the rejection a home, and
shutdown waits on the start instead of racing it.

No bound is set, because for this shape the unbounded wait is the recovery. A
replicator that comes back an hour later answers the same call, and nothing is
rebuilt.

## A worker-only process

If nothing about the process is useful without the replicator — no routes, no
mirror to read, it exists to drain a queue — set the bound, await it, and exit.
The orchestrator's restart with backoff is the retry loop you would otherwise
write, and it gets a fresh process, which is what a spent worker needs anyway.

```ts
async function main(): Promise<void> {
    const worker = createWorker(j, { consumers, startTimeoutMs: 30_000 });

    try {
        await worker.start();
    }
    catch (error) {
        logger.error(
            { error },
            error instanceof DistributionDeniedError
                ? "not authorized for its own specification: a restart repeats this"
                : "the replicator did not answer inside startTimeoutMs"
        );
        process.exit(1);
    }

    process.on("SIGTERM", async () => { await worker.stop(); });
}
```

Take `startTimeoutMs` from what the orchestrator waits for before it calls the
container unhealthy, less whatever the rest of the boot spends. A cold start
against a large candidate set can legitimately take minutes, so a bound of a few
seconds turns a slow first boot into a crash loop.

## Branch on the rejection

A `DistributionDeniedError` repeats until somebody changes a distribution rule.
A `FeedTimeoutError` usually resolves on its own, and it is the one worth
retrying.

Both shapes above tell the two apart even though neither retries in process. The
service records which one it got, so an operator reading a 503 knows whether to
wait or to go change a rule. The worker-only process exits either way, but a
denial is a crash loop that restarting cannot end, and that log line is the only
place saying so.

## The cell to avoid: a bound and a retry loop

```ts
async function startWithRetry(build: () => Worker): Promise<Worker> {
    for (;;) {
        const worker = build();
        try {
            await worker.start();
            return worker;
        }
        catch (error) {
            if (error instanceof DistributionDeniedError) {
                throw error;
            }
            logger.warn({ error }, "the replicator did not answer; building another worker");
            await delay(5_000);
        }
    }
}
```

Two costs fall on this cell and on no other.

The loop tears down a working pending call to issue an identical one. The
unbounded wait it replaced would have been answered by the replicator's return,
with nothing rebuilt in between.

And because a rejected `start()` spends the worker, the loop cannot hold one. It
needs a factory that rebuilds the worker and every consumer on each pass, which
is why `startWithRetry` takes `build` rather than a worker. Every shape this
page recommends is served by one worker, built once.

## What each choice costs

- **Not awaiting** costs knowing, at the moment you begin serving, whether the
  worker ever started. Readiness buys it back, one request at a time.
- **Awaiting** costs every route behind the call, `/health` included, for as
  long as the call takes.
- **No bound** costs a boot that may never finish. It buys a recovery that
  rebuilds nothing.
- **A bound** costs that recovery: the pending call is gone and the worker is
  spent. It buys a boot that settles.
- **Retrying in process** costs a factory, and it burns on the one rejection
  that retrying cannot fix.

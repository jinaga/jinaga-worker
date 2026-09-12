const test = require("node:test");
const assert = require("node:assert/strict");

const { Trace } = require("jinaga");
const {
  DEFAULT_HANDLER_TIMEOUT_MS,
  DEFAULT_RETRY_POLICY,
  defineConsumer,
  Limiter
} = require("../dist/index.js");
const { WorkerHost } = require("../dist/worker.js");
const { backoffMs } = require("../dist/retry.js");
const {
  Mirrored,
  Quarantined,
  Subject,
  Tenant,
  completionsOf,
  driving,
  gatedStore,
  hashesOf,
  outstanding,
  outstandingRow,
  world
} = require("./outstanding-model.js");

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

// Every wait here is for an event, not for a delay. This is only the deadline
// at which an event that is never coming is reported as a failure, so a broken
// dispatch path fails the run instead of hanging it.
const DEADLINE_MS = 10_000;

/**
 * A row stream a test drives. `push` resolves once the change has been applied:
 * the generator acknowledges after the `yield` resumes, which is the moment the
 * consumer's loop body has run for that change.
 */
function controllableStream() {
  const queued = [];
  let wake;
  let ended = false;
  const stream = {
    dropped: 0,
    pending: 0,
    stopped: 0,
    stop() {
      stream.stopped += 1;
      ended = true;
      wake?.();
    },
    push(change) {
      return new Promise(applied => {
        queued.push({ change, applied });
        wake?.();
      });
    },
    [Symbol.asyncIterator]: async function* () {
      while (true) {
        while (queued.length > 0) {
          const { change, applied } = queued.shift();
          yield change;
          applied();
        }
        if (ended) {
          return;
        }
        await new Promise(resolve => {
          wake = resolve;
        });
      }
    }
  };
  return stream;
}

function deferred() {
  let settle;
  const promise = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  return { promise, ...settle };
}

/**
 * A handler that records every row it saw and answers each call from `respond`.
 * `reaching` waits for the nth call, so a test waits for the dispatch it is
 * about rather than for a delay.
 *
 * A handler returns the completion fact, so `respond` does too, and the default
 * one returns the fact for the row it was given.
 */
function recordingHandler(respond = async rowValue => new Mirrored(rowValue.result)) {
  const waiters = [];
  const handle = async rowValue => {
    handle.handled.push(rowValue.rowHash);
    for (const waiter of waiters.splice(0)) {
      waiter();
    }
    return await respond(rowValue, handle.handled.length);
  };
  handle.handled = [];
  handle.reaching = count => new Promise(resolve => {
    const check = () => {
      if (handle.handled.length >= count) {
        resolve();
      }
      else {
        waiters.push(check);
      }
    };
    check();
  });
  return handle;
}

/** Let every pending turn run, so a dispatch that will not happen has not. */
async function quiesce() {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

/** Wait for a state the dispatcher reaches on its own turns. */
async function until(condition, what) {
  for (let turn = 0; turn < 10_000; turn += 1) {
    if (await condition()) {
      return;
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(what);
}

/**
 * A worker over one consumer per entry, each reading its own tenant's
 * outstanding set. The sweep is left at a minute, so every row in these tests
 * arrives on the stream.
 */
function workerOver(t, j, consumers, options = {}) {
  const defined = consumers.map(({ name, tenant, handle, ...rest }) => defineConsumer({
    name,
    specification: outstanding,
    givens: [tenant],
    completes: Mirrored,
    handle,
    sweepIntervalMs: 60_000,
    ...rest
  }));
  const worker = new WorkerHost(j, {
    consumers: defined,
    shutdownTimeoutMs: 10,
    logger: silentLogger,
    ...(options.worker ?? {})
  });
  // Unconditional, so an assertion that fails still releases the timers and the
  // run ends in a failure rather than in a hang.
  t.after(() => worker.stop());
  return {
    worker,
    rowsOf: name => worker.runtimes[consumers.findIndex(c => c.name === name)].rows
  };
}

const phaseOf = (rows, rowHash) => rows.get(rowHash)?.phase;

/** Rules that admit every type but the one named, which is refused where it is asserted. */
const refusing = refused => a => [Tenant, Subject, Mirrored, Quarantined].reduce(
  (rules, type) => type === refused ? rules.no(type) : rules.any(type),
  a
);

/**
 * A change carrying a row the store answered with, for the tests that deliver
 * one themselves.
 */
const change = (row, operation) => ({ result: row.result, rowHash: row.rowHash, operation });

// ---------------------------------------------------------------------------
// Off the notification turn.
// ---------------------------------------------------------------------------

test("does not dispatch from inside the notification", { timeout: DEADLINE_MS }, async t => {
  const { j, acme } = await world();
  const handle = recordingHandler();
  const { worker, rowsOf } = workerOver(t, j, [{ name: "items", tenant: acme, handle }]);
  const r1 = await outstandingRow(j, acme, "r1");

  await worker.start();

  // The row is admitted where the change is delivered, and the handler runs on
  // a turn of its own after that.
  await until(() => phaseOf(rowsOf("items"), r1.rowHash) === "dispatching", "the row was never admitted");
  assert.deepEqual(handle.handled, [], "the handler ran on the turn that delivered the change");

  await handle.reaching(1);
  assert.deepEqual(handle.handled, [r1.rowHash], "the row was dispatched on a later turn");

  await worker.stop();
});

test("the library asserts the fact the handler returns, and does not re-enter notify", { timeout: DEADLINE_MS }, async t => {
  const counters = [];
  Trace.configure({
    info: () => {},
    warn: () => {},
    error: () => {},
    dependency: (name, data, operation) => operation(),
    metric: () => {},
    counter: name => counters.push(name)
  });
  t.after(() => Trace.off());

  const { j, acme } = await world();
  const handle = recordingHandler();
  const { worker } = workerOver(t, j, [{ name: "items", tenant: acme, handle }]);

  await worker.start();
  await j.fact(new Subject(acme, "one"));
  await handle.reaching(1);
  await quiesce();

  // The handler wrote nothing: it returned the fact and the library asserted
  // it, so the row has left its own outstanding set.
  assert.deepEqual(
    await j.queryRows(outstanding, acme),
    [],
    "the completion fact the handler returned never reached the store"
  );
  assert.deepEqual(
    counters.filter(name => name === "observable_notify_reentrant"),
    [],
    "the assertion ran from inside the row's own notification"
  );

  await worker.stop();
});

test("a row reaches completed only once the assertion resolves", { timeout: DEADLINE_MS }, async t => {
  // The store holds the completion fact's write open, so the only thing
  // standing between the handler returning and the row completing is the
  // assertion. Discovery is the test's, so the removal that fact will produce
  // does not release the row before the phase can be read.
  const stored = deferred();
  const { j, acme } = await world({
    store: () => gatedStore(async envelopes => {
      if (envelopes.some(envelope => envelope.fact.type === Mirrored.Type)) {
        await stored.promise;
      }
    })
  });
  const r1 = await outstandingRow(j, acme, "r1");
  const stream = controllableStream();
  const handle = recordingHandler();
  const { worker, rowsOf } = workerOver(
    t,
    driving(j, { subscribeRows: async () => stream, queryRows: async () => [] }),
    [{ name: "items", tenant: acme, handle }]
  );

  await worker.start();
  await stream.push(change(r1, "added"));
  await handle.reaching(1);
  await quiesce();

  assert.equal(
    phaseOf(rowsOf("items"), r1.rowHash),
    "dispatching",
    "the row completed when the handler returned, before its fact was stored"
  );
  assert.deepEqual(
    await hashesOf(j, completionsOf, acme),
    [],
    "the write settled while it was still held open"
  );

  stored.resolve();
  await until(
    () => phaseOf(rowsOf("items"), r1.rowHash) === "completed",
    "the row never completed once its fact was stored"
  );
  assert.deepEqual(await hashesOf(j, completionsOf, acme), [j.hash(new Mirrored(r1.result))]);

  await worker.stop();
});

test("an assertion the store refuses takes the retry path", { timeout: DEADLINE_MS }, async t => {
  // The handler resolves every time; only the write fails, because the store's
  // rules refuse the completion type. The row is re-attempted and exhausts, so
  // a refused fact is a rejected attempt.
  const { j, acme } = await world({ authorization: refusing(Mirrored) });
  const handle = recordingHandler();
  const { worker, rowsOf } = workerOver(t, j, [{
    name: "items",
    tenant: acme,
    handle,
    retry: { maxAttempts: 3, baseMs: 0, capMs: 0 }
  }]);
  const r1 = await outstandingRow(j, acme, "r1");

  await worker.start();
  await handle.reaching(3);
  await quiesce();

  assert.deepEqual(
    handle.handled,
    [r1.rowHash, r1.rowHash, r1.rowHash],
    "the row was re-attempted after the refusal"
  );
  assert.deepEqual(await hashesOf(j, completionsOf, acme), [], "a refused write reached the store");
  assert.equal(phaseOf(rowsOf("items"), r1.rowHash), "quarantined");
  assert.equal(worker.status().consumers[0].completed, 0, "a row completed on a fact the store refused");

  await worker.stop();
});

// ---------------------------------------------------------------------------
// Retry, as a policy value the loop reads.
// ---------------------------------------------------------------------------

test("re-attempts a rejected row on backoff and stops at retry.maxAttempts", { timeout: DEADLINE_MS }, async t => {
  const { j, acme } = await world();
  const handle = recordingHandler(async () => {
    throw new Error("nope");
  });
  const { worker, rowsOf } = workerOver(t, j, [{
    name: "items",
    tenant: acme,
    handle,
    retry: { maxAttempts: 3, baseMs: 0, capMs: 0 }
  }]);
  const r1 = await outstandingRow(j, acme, "r1");

  await worker.start();
  await handle.reaching(3);
  await quiesce();

  assert.deepEqual(
    handle.handled,
    [r1.rowHash, r1.rowHash, r1.rowHash],
    "the row was attempted its three times"
  );
  assert.equal(phaseOf(rowsOf("items"), r1.rowHash), "quarantined");
  assert.equal(worker.status().consumers[0].quarantined, 1);
  assert.equal(worker.status().consumers[0].completed, 0);

  await worker.stop();
});

test("releases the limiter slot while waiting to retry", { timeout: DEADLINE_MS }, async t => {
  const { j, acme } = await world();
  const limiter = new Limiter(1);
  const blocked = deferred();
  const handle = recordingHandler(async rowValue => {
    if (rowValue.result.key === "r1") {
      throw new Error("nope");
    }
    await blocked.promise;
    return new Mirrored(rowValue.result);
  });
  const { worker, rowsOf } = workerOver(t, j, [{
    name: "items",
    tenant: acme,
    handle,
    // Long enough that the retry cannot be what lets the second row through.
    retry: { maxAttempts: 5, baseMs: 60_000, capMs: 60_000 }
  }], { worker: { limiter } });
  const r1 = await outstandingRow(j, acme, "r1");

  await worker.start();
  await until(() => phaseOf(rowsOf("items"), r1.rowHash) === "waiting", "the rejected row never waited");

  assert.equal(limiter.inFlight, 0, "the slot was held across the backoff wait");

  // A consumer at its limit still makes progress on other rows.
  const r2 = await outstandingRow(j, acme, "r2");
  await handle.reaching(2);

  assert.deepEqual(handle.handled, [r1.rowHash, r2.rowHash]);
  assert.equal(limiter.inFlight, 1);
  assert.equal(phaseOf(rowsOf("items"), r1.rowHash), "waiting");

  blocked.resolve();
  await worker.stop();
});

test("the backoff is exponential from baseMs, capped at capMs, and jittered into the lower half", () => {
  const policy = { maxAttempts: 5, baseMs: 1_000, capMs: 30_000 };
  const drawn = new Set();
  for (const attempts of [1, 2, 3, 4, 5, 6]) {
    const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** (attempts - 1));
    for (let draw = 0; draw < 50; draw += 1) {
      const delay = backoffMs(policy, attempts);
      drawn.add(delay);
      assert.ok(delay <= ceiling, `${delay} exceeded ${ceiling} on attempt ${attempts}`);
      assert.ok(delay >= ceiling * 0.5, `${delay} fell below half of ${ceiling} on attempt ${attempts}`);
    }
  }
  assert.ok(drawn.size > 1, "the wait is not jittered");
  assert.deepEqual(DEFAULT_RETRY_POLICY, { maxAttempts: 5, baseMs: 1_000, capMs: 30_000 });
});

test("a timed-out handler counts as a rejection, not as progress", { timeout: DEADLINE_MS }, async t => {
  const { j, acme } = await world();
  const wedged = deferred();
  let settled = false;
  const handle = recordingHandler(async rowValue => {
    await wedged.promise;
    settled = true;
    return new Mirrored(rowValue.result);
  });
  const { worker, rowsOf } = workerOver(t, j, [{
    name: "items",
    tenant: acme,
    handle,
    handlerTimeoutMs: 1,
    retry: { maxAttempts: 1, baseMs: 0, capMs: 0 }
  }]);
  const r1 = await outstandingRow(j, acme, "r1");

  await worker.start();
  await until(
    () => phaseOf(rowsOf("items"), r1.rowHash) === "quarantined",
    "the timed-out attempt was not counted as a rejection"
  );

  assert.equal(worker.status().consumers[0].completed, 0, "a timeout was counted as progress");
  assert.equal(settled, false, "the abandoned handler is still running");

  wedged.resolve();
  await worker.stop();
});

// ---------------------------------------------------------------------------
// The concurrency budget.
// ---------------------------------------------------------------------------

test("total in-flight work across several consumers is bounded by one shared limiter", { timeout: DEADLINE_MS }, async t => {
  const { j, acme } = await world();
  const attendeesTenant = await j.fact(new Tenant("attendees"));
  const blocked = deferred();
  const respond = () => blocked.promise;
  const invitations = recordingHandler(respond);
  const attendees = recordingHandler(respond);
  const limiter = new Limiter(2);
  const { worker } = workerOver(t, j, [
    { name: "invitations", tenant: acme, handle: invitations },
    { name: "attendees", tenant: attendeesTenant, handle: attendees }
  ], { worker: { limiter, shutdownTimeoutMs: 1 } });
  for (const [name, tenant] of [["invitations", acme], ["attendees", attendeesTenant]]) {
    await outstandingRow(j, tenant, `${name}-1`);
    await outstandingRow(j, tenant, `${name}-2`);
  }

  await worker.start();
  // Every row has reached the limiter, so what runs now is what the budget
  // allows rather than what has been dispatched so far.
  await until(() => limiter.waiting === 2, "the rows over the budget never queued for a slot");

  assert.equal(
    invitations.handled.length + attendees.handled.length,
    2,
    "more than the shared budget was in flight at once"
  );
  assert.equal(limiter.inFlight, 2);

  blocked.resolve();
  await until(
    () => invitations.handled.length + attendees.handled.length === 4,
    "the queued rows never got a slot"
  );

  await worker.stop();
});

test("a consumer with its own limiter is bounded by that one instead", { timeout: DEADLINE_MS }, async t => {
  const { j, acme } = await world();
  const attendeesTenant = await j.fact(new Tenant("attendees"));
  const blocked = deferred();
  const respond = () => blocked.promise;
  const invitations = recordingHandler(respond);
  const attendees = recordingHandler(respond);
  const shared = new Limiter(4);
  const own = new Limiter(1);
  const { worker } = workerOver(t, j, [
    { name: "invitations", tenant: acme, handle: invitations, limiter: own },
    { name: "attendees", tenant: attendeesTenant, handle: attendees }
  ], { worker: { limiter: shared, shutdownTimeoutMs: 1 } });
  for (const [name, tenant] of [["invitations", acme], ["attendees", attendeesTenant]]) {
    await outstandingRow(j, tenant, `${name}-1`);
    await outstandingRow(j, tenant, `${name}-2`);
  }

  await worker.start();
  await until(
    () => own.waiting === 1 && attendees.handled.length === 2,
    "the shared budget did not admit both rows while the private one queued its second"
  );

  assert.equal(invitations.handled.length, 1, "the private budget did not bound the consumer");
  assert.equal(own.inFlight, 1);
  assert.equal(shared.inFlight, 2, "the private budget's work was charged to the shared one");

  blocked.resolve();
  await until(() => invitations.handled.length === 2, "the queued row never got a slot");

  await worker.stop();
});

test("a consumer resolves its retry policy, its handler deadline, and no budget of its own", () => {
  const consumer = defineConsumer({
    name: "items",
    specification: outstanding,
    givens: [new Tenant("items")],
    completes: Mirrored,
    handle: async row => new Mirrored(row.result)
  });

  assert.deepEqual(consumer.retry, DEFAULT_RETRY_POLICY);
  assert.equal(consumer.handlerTimeoutMs, DEFAULT_HANDLER_TIMEOUT_MS);
  assert.equal(DEFAULT_HANDLER_TIMEOUT_MS, 30_000);
  assert.equal(consumer.limiter, undefined, "a consumer holds a budget only when it declares one");
});

// ---------------------------------------------------------------------------
// A row that has already left the set.
// ---------------------------------------------------------------------------

// A fact retires a row for good, so the store cannot deliver an addition behind
// the removal that retired it. The stream can, and these two are what the loop
// does with it. The rows are the store's own — written, then read back through
// the specification — so the fact each attempt returns is the one that row is
// owed, and its hash is the store's.

test("dispatching a row that has already left the set is harmless", { timeout: DEADLINE_MS }, async t => {
  const { j, acme } = await world();
  const r1 = await outstandingRow(j, acme, "r1");
  const stream = controllableStream();
  const attempts = [deferred(), deferred()];
  const handle = recordingHandler((rowValue, call) => attempts[call - 1].promise);
  const { worker, rowsOf } = workerOver(
    t,
    driving(j, { subscribeRows: async () => stream, queryRows: async () => [] }),
    [{ name: "items", tenant: acme, handle }]
  );

  await worker.start();
  await stream.push(change(r1, "added"));
  await handle.reaching(1);

  // The row leaves the set while its handler is still running, and a stale
  // addition behind the removal finds no entry and is admitted again.
  await stream.push(change(r1, "removed"));
  assert.equal(rowsOf("items").size, 0);
  await stream.push(change(r1, "added"));
  await handle.reaching(2);

  assert.deepEqual(handle.handled, [r1.rowHash, r1.rowHash], "the second attempt did not run the handler");

  // The first attempt is no longer the one the map is about, so its outcome
  // leaves the row to the attempt that replaced it. Each attempt resolves with
  // the completion fact its handler owes, which is what the library asserts and
  // reads the row's `completionHash` off.
  attempts[0].resolve(new Mirrored(r1.result));
  await quiesce();
  assert.equal(phaseOf(rowsOf("items"), r1.rowHash), "dispatching", "a superseded attempt moved the row");
  assert.equal(worker.status().consumers[0].completed, 0);

  attempts[1].resolve(new Mirrored(r1.result));
  await quiesce();

  assert.equal(rowsOf("items").size, 1, "the two attempts left more than one entry");
  assert.equal(phaseOf(rowsOf("items"), r1.rowHash), "completed");
  assert.deepEqual(
    worker.status().consumers[0],
    {
      name: "items",
      givenHash: j.hash(acme),
      dispatching: 0,
      waiting: 0,
      completed: 1,
      quarantined: 0,
      dropped: 0,
      sweepFailures: 0
    },
    "the counts disagree with the map"
  );

  await worker.stop();
});

test("a superseded attempt neither retries nor drains in place of the one that replaced it", { timeout: DEADLINE_MS }, async t => {
  const { j, acme } = await world();
  const r1 = await outstandingRow(j, acme, "r1");
  const stream = controllableStream();
  const attempts = [deferred(), deferred()];
  const handle = recordingHandler((rowValue, call) => attempts[call - 1].promise);
  const { worker, rowsOf } = workerOver(
    t,
    driving(j, { subscribeRows: async () => stream, queryRows: async () => [] }),
    [{
      name: "items",
      tenant: acme,
      handle,
      // Long enough that a retry scheduled here would be visible as `waiting`.
      retry: { maxAttempts: 5, baseMs: 60_000, capMs: 60_000 }
    }],
    { worker: { shutdownTimeoutMs: 5_000 } }
  );

  await worker.start();
  await stream.push(change(r1, "added"));
  await handle.reaching(1);
  await stream.push(change(r1, "removed"));
  await stream.push(change(r1, "added"));
  await handle.reaching(2);

  attempts[0].reject(new Error("nope"));
  await quiesce();

  assert.equal(
    phaseOf(rowsOf("items"), r1.rowHash),
    "dispatching",
    "the superseded rejection paced a row whose handler is still running"
  );
  assert.equal(worker.status().consumers[0].waiting, 0);

  // The drain awaits the attempt that is running, not the one it replaced.
  const stopping = worker.stop();
  attempts[1].resolve(new Mirrored(r1.result));

  assert.deepEqual(await stopping, { drained: 1, abandoned: 0 });
});

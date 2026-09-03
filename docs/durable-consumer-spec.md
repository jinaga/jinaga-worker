# jinaga-worker: durable consumer specification

Status: accepted, unimplemented. Supersedes the placeholder surface on `main`.

This is the implementation contract for the package proposed in
[jinaga/jinaga.js#251][251]. It assumes the design argument in that RFC and its
third comment ("The contract as merged") rather than restating it, and records
the decisions that were left open there.

Requires `jinaga` ^6.12.0, the first release carrying the row-stream seam from
[#250][250].

Every structure here is answerable to
[the constitution](constitution/degrees-of-freedom-constitution.md). Section 10
records the evaluation and the compromises.

[251]: https://github.com/jinaga/jinaga.js/issues/251
[250]: https://github.com/jinaga/jinaga.js/issues/250

---

## 1. What this package is

A durable consumer runs a reconciliation loop, not a queue. Its outstanding work
is a specification:

```
invitations where not exists InvitationMirrored
              and not exists InvitationQuarantined
```

Progress lives in the fact graph. A row leaves the outstanding set when the
application writes a fact about it — a completion on the happy path, a
quarantine on the failure path. There is no cursor, no offset, and no state
outside the graph that a restart has to recover.

### Division of responsibility

| The library owns | The application owns |
| --- | --- |
| Discovery: the stream and the backstop sweep, deduplicated on `rowHash` | The specification, including both `notExists` conditions |
| Dispatch: off the notification turn, under a concurrency limit and a timeout | The handler, and the completion fact it writes |
| Retry pacing and attempt accounting | The quarantine fact type, and writing it |
| Diagnosing non-progress and reporting it | Deciding what non-progress means operationally |
| Draining on shutdown | Process supervision |

The library never writes a fact. Every write is the application's, through its
own model, under its own authorization rules.

### Non-goals

- **Not a queue.** No ordering, no offsets, no exactly-once.
- **No in-process supervision.** `withTimeout` abandons a wait but cannot cancel
  work, so a restarting supervisor would accumulate a zombie handler per
  restart. Supervision belongs to the orchestrator (RFC, "Supervision").
- **No nested consumers.** One consumer per layer; a parent's completion fact is
  what makes a child's stage eligible (RFC, "One consumer per layer").

---

## 2. API

Two rules shape this surface, both from the constitution:

- **Every option has exactly one home.** No setting appears on both the worker
  and a consumer, so there is no precedence rule to remember and no pair of
  values to keep consistent by hand (Art. 4, 8).
- **The consumer set is fixed at construction.** Consumers are passed to
  `createWorker`, so the set is complete before the worker exists and the
  lifecycle has one shape (Art. 3).

```ts
import { Jinaga, SpecificationOf, SpecificationRow } from "jinaga";

export function defineConsumer<T extends unknown[], U>(
    options: ConsumerOptions<T, U>
): Consumer;

export function createWorker(j: Jinaga, options: WorkerOptions): Worker;

export interface Worker {
    /** Subscribe, sweep, and begin dispatching. */
    start(): Promise<void>;
    /** Stop discovery, drain in-flight work to a deadline, release feeds. */
    stop(): Promise<StopReport>;
    /** A snapshot for a health or metrics endpoint. Entirely derived. */
    status(): WorkerStatus;
}
```

### 2.1 Worker options — what is shared across consumers

```ts
export interface WorkerOptions {
    consumers: readonly Consumer[];
    limiter?: Limiter;             // default new Limiter(8), shared by every consumer
    shutdownTimeoutMs?: number;    // 30_000
    onNoProgress?: (event: NoProgressEvent) => void | Promise<void>;
    logger?: Logger;
}
```

Nothing here can be set per consumer. `onNoProgress` is the worker's alone, and
the event names the consumer it came from, so a per-consumer reaction is a
`switch` in one handler.

### 2.2 Consumer options — what genuinely varies per consumer

```ts
export interface ConsumerOptions<T extends unknown[], U> {
    name: string;
    specification: SpecificationOf<T, U>;
    givens: T;
    handle: (row: SpecificationRow<U>) => Promise<void>;
    quarantine?: (row: SpecificationRow<U>, event: NoProgressEvent<U>) => Promise<void>;

    limiter?: Limiter;             // a private budget instead of the worker's shared one
    retry?: RetryPolicy;           // default { maxAttempts: 5, baseMs: 1_000, capMs: 30_000 }
    sweepIntervalMs?: number;      // 60_000
    handlerTimeoutMs?: number;     // 30_000
    capacity?: number;             // 1024 (DEFAULT_ROW_STREAM_CAPACITY)
}

/** Retry policy is a value the loop reads, not branches inside it. */
export interface RetryPolicy {
    maxAttempts: number;
    baseMs: number;
    capMs: number;
}
```

`givens` is a tuple, not a rest parameter, because it sits in an options object;
its type is the specification's own `T`, so passing too few givens is a compile
error. `subscribeRows` and `queryRows` take them variadically, and the library
spreads.

A consumer's `limiter` is not another spelling of the worker's. The worker's is
the shared budget; a consumer's replaces it with a private one. They mean
different things, so both are kept.

### 2.3 Events

`kind` and `error` are one axis, not two. A `failed` event always carries the
rejection; a `stalled` event has no error to carry, because the handler
resolved. Modelled as a union, neither `{ kind: "stalled", error }` nor
`{ kind: "failed" }` can be constructed (Art. 3).

```ts
export type NoProgressEvent<U = unknown> = FailedEvent<U> | StalledEvent<U>;

interface NoProgress<U> {
    consumer: string;
    result: U;                     // the row's projection, as the handler saw it
    rowHash: string;
    attempts: number;
    elapsedMs: number;             // first attempt to exhaustion
    quarantineDepth: number;       // rows this consumer holds quarantined, including this one
}

export interface FailedEvent<U = unknown> extends NoProgress<U> {
    kind: "failed";
    error: unknown;                // the last rejection
}

export interface StalledEvent<U = unknown> extends NoProgress<U> {
    kind: "stalled";
}
```

### 2.4 Reporting

```ts
export interface StopReport {
    drained: number;               // handlers that settled within the deadline
    abandoned: number;             // still running when stop() resolved
}

export interface WorkerStatus {
    consumers: readonly ConsumerStatus[];
}

export interface ConsumerStatus {
    name: string;
    givenHash: string;
    dispatching: number;
    waiting: number;
    completed: number;
    quarantined: number;
    dropped: number;               // RowStream.dropped — read through, never copied
    lastSweep?: { at: Date; size: number };
}

/** Shared concurrency budget. One instance bounds several consumers together. */
export class Limiter {
    constructor(max: number);
    run<T>(fn: () => Promise<T>): Promise<T>;
    readonly inFlight: number;
    readonly waiting: number;
}
```

Every count in `ConsumerStatus` is computed on call by tallying the row-state
map in §3.3. None is maintained incrementally, so none can drift from the state
it describes (Art. 2). `lastSweep` is one optional, because an `at` without a
`size` is not a state the problem contains.

### 2.5 The shape of a worker

```ts
const invitations = defineConsumer({
    name: "invitation-mirror",
    specification: outstandingInvitations,
    givens: [tenant],
    handle: async row => {
        await repo.upsertInvitation(pool, row.result, j.hash(row.result));
        await j.fact(new InvitationMirrored(row.result));
    },
    quarantine: async (row, e) => {
        await j.fact(new InvitationQuarantined(row.result, describe(e), new Date()));
    },
});

const attendees = defineConsumer({ name: "attendee-mirror", /* the next layer */ });

const worker = createWorker(j, {
    consumers: [invitations, attendees],
    limiter: new Limiter(8),                   // below Pool({ max: 10 })
    onNoProgress: e => {
        if (e.kind === "stalled") health.fail(`${e.consumer} stalled on ${e.rowHash}`);
        else logger.warn({ ...e, error: e.error }, "quarantined");
    },
});

await worker.start();
process.on("SIGTERM", async () => { await worker.stop(); await pool.end(); });
```

---

## 3. The loop

### 3.1 Start

Per consumer, in order:

1. Compute the given hash (`j.hash` of each given, joined) and **log it**. A
   given that differs by any field after a restart sends both discovery paths
   silently empty; this line is the only way an operator sees it.
2. `await j.subscribeRows(specification, ...givens, { capacity })`. The library
   installs listeners before it reads, delivers the current rows and every later
   change through one iterator, and dedupes the startup window itself. There is
   no second call to order correctly.
3. Begin iterating the stream, and schedule the backstop sweep.

`start()` resolves when every consumer's stream is running. It rejects if any
`subscribeRows` rejects, which is the correct behavior for a structural
distribution denial: a worker not authorized for its own specification should
fail to start rather than idle.

### 3.2 Discovery

Two paths, one execution path, deduplicated on `rowHash`:

- **The stream** — `operation: "added"` offers a row; `operation: "removed"`
  retracts one.
- **The sweep** — `queryRows` every `sweepIntervalMs`, offering every row it
  returns.

Neither executes anything. Both funnel into one admission gate.

### 3.3 Row state

One map per consumer, `Map<rowHash, RowState>`. A row is admitted for dispatch
if and only if the map holds no entry for its `rowHash` — one lookup, not an
intersection of several sets.

```ts
type RowState<U> =
    | { phase: "dispatching"; row: SpecificationRow<U>; attempts: number; firstAttemptAt: number }
    | { phase: "waiting";     row: SpecificationRow<U>; attempts: number; firstAttemptAt: number; retryAt: number }
    | { phase: "completed";   row: SpecificationRow<U>; attempts: number }
    | { phase: "quarantined"; row: SpecificationRow<U> };
```

Four phases for four situations (Art. 1, 3). `attempts` is absent from
`quarantined` because a quarantined row is never attempted again, so the count
has nothing left to govern.

| From | Event | To |
| --- | --- | --- |
| *absent* | admitted from either discovery path | `dispatching` |
| `dispatching` | handler resolves | `completed` |
| `dispatching` | handler rejects or times out, `attempts < maxAttempts` | `waiting` |
| `dispatching` | handler rejects or times out, `attempts = maxAttempts` | `quarantined`, after `quarantine()` and one `failed` event |
| `waiting` | `retryAt` reached | `dispatching` |
| `completed` | a sweep still returns the row, `attempts < maxAttempts` | `dispatching` |
| `completed` | a sweep still returns the row, `attempts = maxAttempts` | `quarantined`, after `quarantine()` and one `stalled` event |
| *any* | `removed` change, or a sweep omits the row | *absent* |

Memory is bounded by the outstanding set, not by throughput: every entry is
keyed by a row that is still outstanding, and the last row of the table releases
it when the row leaves. A `removed` change is the exact acknowledgement — but an
advisory one, since removals dispatch through the same abandonable listener path
as additions. Nothing waits on it.

It is advisory in a second way. Notifications are unordered (§5), so one save
that carries both a row's source fact and its completion fact produces an
`added` and a `removed` whose arrival order is undefined; a feed catch-up after
a restart delivers exactly that graph. When the `removed` arrives first it
clears the entry, and the `added` behind it finds no entry and is admitted.
Handler idempotence is what makes that safe, and this is the second source of
duplicate dispatch alongside the abandoned timeout of §3.4. The same sequence
can re-admit a `quarantined` row, because `removed` clears from any phase:
suppression holds against the sweep, which is the operational path, and a stale
addition costs one further attempt.

### 3.4 Dispatch

Dispatch never happens on the notification turn. The stream's listener only
enqueues (the library owns it), and the consumer's own turn does the work:

```
acquire a slot from the limiter
  attempt = withTimeout(handle(row), handlerTimeoutMs)
release the slot            // released before any backoff wait, not held across it
```

A timeout counts as a rejection. The abandoned handler keeps running —
JavaScript offers no way to cancel it — which is one of the two reasons the
handler contract demands idempotence. The other is the stale addition of §3.3.

### 3.5 Retry

The loop reads the policy; it does not embed one. Given `RetryPolicy`, the wait
before the next dispatch is

```
delay = min(policy.capMs, policy.baseMs * 2 ** (attempts - 1)) * jitter(0.5 … 1.0)
```

The slot is released during the wait. With the default policy a row exhausts
five attempts in roughly 15–30 seconds, so a transient outage does not wait a
full sweep interval and time-to-quarantine stays predictable.

### 3.6 Exhaustion

On either transition into `quarantined`, in this order:

1. `await withTimeout(quarantine(row, event), handlerTimeoutMs)`, when supplied.
2. Move the row to `quarantined`, **whether or not step 1 succeeded**. A
   quarantine callback that throws must not put the row back in circulation; the
   failure is logged and the event still fires.
3. Emit `onNoProgress` once, bounded by `handlerTimeoutMs`, so the callback
   cannot wedge the loop it exists to report on.

Thereafter the row is skipped on every sweep, and on every addition but the
stale one of §3.3. Nothing durable is written by the library, so a restart clears the map and retries — consistent with the rest of
the design, where nothing lives outside the graph.

### 3.7 Non-progress

Two diagnoses, opposite responses:

- **`failed`** — the handler rejected `maxAttempts` times. Operational, usually
  transient. Quarantine and let a restart retry.
- **`stalled`** — the handler *resolved* `maxAttempts` times and a subsequent
  `queryRows` still contains the `rowHash`. A programming error that will not
  resolve on its own: a missing `notExists`, a completion fact of the wrong
  type, a handler that silently no-ops, or a completion fact the replicator's
  authorization rules reject. SIGTERM is an honest response.

`stalled` is decided by the sweep, never by the absence of a removal
notification — the `completed` rows of §3.3's table. The event names the
consumer, so an operator can find the completion fact type from the consumer's
declaration. Diagnostics should quote it.

### 3.8 Stop

```
1. stop() every stream and cancel every sweep timer   — discovery ends
2. admit nothing new; drop every `waiting` row
3. await `dispatching` handlers, up to shutdownTimeoutMs
4. resolve with { drained, abandoned }
```

Rows that finish write their completion facts and are clean. Rows past the
deadline are abandoned, still running, and redelivered after a restart —
at-least-once holds either way. A wedged handler cannot hold the process open
past the deadline.

---

## 4. The quarantine pattern

**Read this before deploying a worker.** The library calls back when a row has
exhausted its attempts; it does not write anything. The fact type, the
specification condition, and the write are the application's. Without them a
poison row is suppressed in memory for the life of one process and re-attempted
by the next one, forever. That is the documented consequence of declining the
pattern, not a defect.

### 4.1 Define the fact

```ts
class InvitationQuarantined {
    static Type = "Blog.Invitation.Quarantined" as const;
    type = InvitationQuarantined.Type;
    constructor(
        public invitation: Invitation,
        public reason: string,
        public quarantinedAt: Date
    ) {}
}
```

### 4.2 Put it in the specification

The outstanding set must exclude it, or the row never leaves and the consumer
reports `stalled` about its own quarantine:

```ts
const outstandingInvitations = model.given(Tenant).match((tenant, facts) =>
    facts.ofType(Invitation)
        .join(i => i.tenant, tenant)
        .notExists(i => facts.ofType(InvitationMirrored)
            .join(m => m.invitation, i))
        .notExists(i => facts.ofType(InvitationQuarantined)
            .join(q => q.invitation, i))
);
```

### 4.3 Write it from the callback

```ts
quarantine: async (row, e) => {
    await j.fact(new InvitationQuarantined(row.result, describe(e), new Date()));
}
```

### 4.4 Model release as a successor

Quarantine records a decision about a possibly transient failure in immutable
storage, so releasing one is its own fact, and the condition becomes "no
*unreleased* quarantine":

```ts
class InvitationQuarantineReleased {
    static Type = "Blog.Invitation.Quarantined.Released" as const;
    type = InvitationQuarantineReleased.Type;
    constructor(public quarantined: InvitationQuarantined) {}
}

.notExists(i => facts.ofType(InvitationQuarantined)
    .join(q => q.invitation, i)
    .notExists(q => facts.ofType(InvitationQuarantineReleased)
        .join(r => r.quarantined, q)))
```

The operator needs a way to write that fact. Building one is part of adopting
the pattern.

### 4.5 What it buys

- A poison row leaves the outstanding set **permanently**, so the head of the
  backlog is never blocked.
- Quarantine survives restart instead of being retried forever.
- A second worker does not re-attempt what this one gave up on.

### 4.6 Authorization

The worker's principal must be authorized to write both the completion fact and
the quarantine fact. A denial on either throws at the client, leaves the row
outstanding, and surfaces as `stalled` — correct, but only legible if the
diagnostics name the fact type.

---

## 5. Constraints inherited from jinaga

These are not this package's choices. They are properties of the platform that
its documentation must carry, because every one of them is silent when violated.

- **The given must be byte-stable across restarts.** `RowObserver` hashes it once
  and filters every notification against it; a drifting given goes silently
  empty. A given derived from `beginSingleUse` will not work. Log the hash.
- **Purge conditions are checked on every read and subscribe.** A specification
  over a purgeable fact type must carry the purge condition's `notExists`, or
  every sweep throws.
- **Notifications are unordered, and the store is complete before any of them
  runs.** `ObservableSource.notify` fans out with `Promise.all` and discards the
  topological order the envelopes arrive in (a KNOWN GAP comment in
  `observable.js`). Two facts about where it sits make that safe here.
  `FactManager.save` persists the whole batch before it calls `notify`, and each
  listener re-reads storage — `store.read([givenReference], specification)` — so
  every notification sees every fact of the batch whatever the delivery order.
  A row therefore reaches the stream complete, at the moment its last
  constituent fact is saved, and the order decides only which of two redundant
  deliveries lands first. This loop is order-insensitive by construction rather
  than by compensation. Still, never infer "the parent completed before this
  child appeared" from delivery order, and see §3.3 for the one place the
  absence of order is visible to the row-state map.
- **Nested projections are not observed.** Only root-path inverses are
  registered, so a projected collection is a snapshot from when the row's own
  notification fired. Do not project a collection a handler needs current; make
  it a layer with its own consumer. This, with a parent's completion fact being
  what makes a child's stage eligible, is the mechanical reason for one consumer
  per layer.
- **Distribution splits loud and silent.** A structural denial throws
  (`DistributionDeniedError`, `reactive: false`), and the worker should fail to
  start. A `reactive: true` diagnostic is the subscription race and self-heals
  once the authorizing fact arrives — it must never be treated as fatal, but it
  should be logged, or a worker that is not yet authorized looks exactly like a
  worker with no work. Register `j.onDistributionDiagnostic` at startup and
  deduplicate per `(feed, code)`.
- **Two known gaps in 6.12.0**, both marked in the source:
  `subscribeRows` does not apply the distribution-rule intersection that
  `j.subscribe` does (`observer/row-stream.js:176`), so a specification
  authorized only through an intersected rule reports `reactive` and delivers
  nothing — declare a rule matching the consumer specification exactly. And
  `subscribeRows` awaits the feed's first response, so an unresponsive
  replicator leaves `start()` pending; bound it with the orchestrator's startup
  probe.

---

## 6. Defaults

| Option | Home | Default | Why |
| --- | --- | --- | --- |
| `limiter` | worker | `new Limiter(8)` | One budget for the whole worker, sized just under the process's real connection pool. Adding a consumer must not raise total pressure. |
| `shutdownTimeoutMs` | worker | 30_000 | Typically the orchestrator's grace period before SIGKILL. |
| `retry.maxAttempts` | consumer | 5 | |
| `retry.baseMs` | consumer | 1_000 | |
| `retry.capMs` | consumer | 30_000 | Five attempts land in 15–30s, well inside one sweep. |
| `sweepIntervalMs` | consumer | 60_000 | The backstop is cheap against a near-empty set and is only a latency floor for dropped notifications. |
| `handlerTimeoutMs` | consumer | 30_000 | Matches `listenerTimeoutMs` from #249. |
| `capacity` | consumer | 1024 | `DEFAULT_ROW_STREAM_CAPACITY`. Only the hint path is bounded; rows from a read are never dropped. |

No option appears in two rows of the *Home* column. That is the property to
preserve when this table grows.

---

## 7. Tests

`JinagaTest.create({ model })` exercises the same seam and the same read, so no
replicator is needed. Two rules from jinaga.js's `contributing.md` apply: no
arbitrary timeouts, and test at the level of the mechanism — a green end-to-end
run does not establish that a feed decomposition or a distribution rule works
against a real replicator.

Each of these pins a decision above, and should fail if that decision is
reverted:

- delivers the backlog and later arrivals exactly once
- does not dispatch from inside the notification (no `observable_notify_reentrant`)
- re-attempts a rejected row on backoff and stops at `retry.maxAttempts`
- releases the limiter slot while waiting to retry
- calls `quarantine` exactly once when attempts are exhausted
- quarantines even when the `quarantine` callback throws
- skips a quarantined row on every later sweep, and emits `onNoProgress` once
- reports `stalled` when the handler resolves and a later sweep still returns the row
- clears row state when a row leaves the set by either path
- dispatches a row once when its `added` arrives after its `removed`
- bounds total in-flight work across several consumers by one shared limiter
- `stop()` drains settled handlers and reports the abandoned count
- a timed-out handler counts as a rejection, not as progress
- `status()` counts agree with the row-state map after every transition above

The last one is the constitution's Article 2 as an executable check: if a count
can disagree with the map, it was being maintained rather than derived.

---

## 8. Out of scope

- **Sharding.** Bounding the outstanding set by construction is the
  application's job — one consumer per shard, each with its own given. The
  library only makes it expressible: the row methods take multiple givens.
- **A bounded read.** Withdrawn in the RFC's paging comment: a limit bounds the
  last and cheapest stage, "any N" without an order blocks the queue head, a
  cursor is unsound for `exists(parent completion)` composition, and an optional
  parameter type-checks while lying to the caller.
- **A durable local store.** A server-side client gets a `MemoryStore`, so the
  sweep is an unindexed interpretation. A SQL-backed store is the mitigation and
  it needs [#252][252] first, which is why that issue gates scale rather than
  this package.

[252]: https://github.com/jinaga/jinaga.js/issues/252

---

## 9. Decisions recorded

Settled after the RFC, in the order they were taken:

1. **Quarantine is the application's.** The library defines a callback and
   documents the pattern; the fact type, the specification condition, and the
   write belong to the application. Declining it means no dead-letter
   protection, stated plainly rather than warned about.
2. **A worker host.** `createWorker` owns the Jinaga instance, the shared
   limiter and the diagnostics. Consumers are passed to it. One lifecycle, one
   `stop()`.
3. **Backoff inside the consumer.** A transient failure recovers in seconds
   rather than waiting a sweep interval.
4. **Quarantine is remembered in memory.** The row is skipped for the life of
   the process, `onNoProgress` fires once, and a restart retries.
5. **`stop()` drains to a deadline.** Discovery stops first; `dispatching`
   handlers get `shutdownTimeoutMs`; whatever is left is abandoned and reported.
6. **One shared concurrency budget.** The worker's limiter bounds every
   consumer, matching the process-wide pool the handlers contend for. A consumer
   can pass its own to opt out.
7. **The RFC's vocabulary.** `consume`, `onNoProgress`, `failed` / `stalled`,
   so the code and three comments of design rationale use the same words. The
   verb survives as `defineConsumer`; the nouns are unchanged.

---

## 10. Constitutional conformance

Scored against
[Part IV](constitution/degrees-of-freedom-constitution.md#part-iv-evaluation-procedure).
Three tensions remain, recorded as compromises rather than left to be
rediscovered.

### 10.1 The evaluation

| # | Question | Verdict |
| --- | --- | --- |
| 1 | Can I represent a state I would then have to forbid? | No. |
| 2 | Is any value stored that could be computed? | No. Every `ConsumerStatus` count is tallied from the row-state map on call; `dropped` is read through to `RowStream`. |
| 3 | Do two distinct configurations produce identical behavior? | No. A consumer's `limiter` and the worker's are distinct meanings — private budget versus shared — not two spellings of one. |
| 4 | Does one variable's valid range depend on another's value? | No. `retry` groups the three knobs that are read together, and no knob's meaning depends on another's value. |
| 5 | Do frequently changing decisions live inside rarely changing mechanism? | No. Retry is a `RetryPolicy` value the loop reads (§3.5); the loop has no policy branches. |
| 6 | Does the top layer read as steps rather than intent? | No. A consumer is a declaration — specification, handler, quarantine — and §3.3's table is the mechanism that gives it meaning. |
| 7 | Can a well-formed specification produce a broken system? | **Yes.** Tension T2. |
| 8 | Does one intended change force coordinated changes elsewhere? | **Yes, in one place.** Tension T1. |

### 10.2 Tensions

**T1 — The quarantine condition and the quarantine callback co-vary (Art. 8).**
A consumer can supply `quarantine` and forget the `notExists` in its
specification, or add the condition and no callback. The consistency is
maintained by hand across two sites, which the constitution names as latent
redundancy. It is not accidental coupling: the project has decided the fact type
belongs to the application, and the library cannot compose a condition onto a
specification it did not build. The compromise is to express the coupling once —
in the pattern of §4 — and to detect its violation at runtime as `stalled`
rather than to leave it silent. If jinaga.js ever offers a combinator that
composes `notExists` onto an existing `SpecificationOf`, the library should
derive the condition from the declaration and this tension closes by Article 2.

**T2 — The specification language is not closed (Art. 7).** A syntactically
valid specification with no terminating `notExists` produces a consumer that
runs forever and never progresses. The RFC declined to enforce this
syntactically, on the grounds that a runtime detector catches strictly more —
an omitted condition, a completion of the wrong type, a silent no-op handler,
and an authorization denial alike. That reasoning stands, and the cost is stated
plainly: the invariant lives in the author's vigilance and in `stalled`, not in
the grammar. This library cannot close a language it does not own.

**T3 — The `completed` phase duplicates the graph (Appendix).** Whether a row
has been handled is already recorded in the fact graph by the completion fact.
Holding it in memory is redundant storage, permitted because it is a pure
function of the graph, regenerable by the next sweep, and never authoritative:
dropping the map costs a redelivery, which at-least-once already allows. The
test in §7 that `status()` agrees with the map is what keeps it non-authoritative
in practice.

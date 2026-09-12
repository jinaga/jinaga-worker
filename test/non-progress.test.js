const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const { defineConsumer } = require("../dist/index.js");
const { WorkerHost } = require("../dist/worker.js");
const { distributionDiagnostics } = require("../dist/diagnostics.js");
const {
  Mirrored,
  Quarantined,
  Subject,
  Tenant,
  completionsOf,
  driving,
  hashesOf,
  outstanding,
  outstandingRow,
  quarantinesOf,
  world
} = require("./outstanding-model.js");
const { specPath } = require("./spec-guard.js");

// Every wait here is for an event, not for a delay. `WAIT_MS` is only the
// deadline at which an event that is never coming is reported as a failure, so
// a broken path fails the run instead of hanging it. Each test is given more
// than that, so the wait that failed is what names itself.
const WAIT_MS = 5_000;
const DEADLINE_MS = WAIT_MS * 2;

// Three attempts a millisecond apart, so a row exhausts within a test rather
// than within a sweep interval. The loop reads the policy either way.
const FAST_RETRY = { maxAttempts: 3, baseMs: 1, capMs: 2 };

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

/** A logger that keeps what it was told, so a test can read the diagnostics. */
function recordingLogger() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    info: (message, data) => lines.info.push({ message, data }),
    warn: (message, data) => lines.warn.push({ message, data }),
    error: (message, data) => lines.error.push({ message, data })
  };
}

/**
 * A handler that records every row it saw and answers each call from `respond`,
 * which is given the row and the number of this call. The default mirrors the
 * row it was handed, which is the completion fact that retires it.
 */
function recordingHandler(respond = async rowValue => new Mirrored(rowValue.result)) {
  const handle = async rowValue => {
    handle.handled.push(rowValue.rowHash);
    return await respond(rowValue, handle.handled.length);
  };
  handle.handled = [];
  return handle;
}

/**
 * The quarantine group a consumer declares: the constructor and the factory
 * that returns the fact. The factory records its calls and answers from
 * `respond`, and the library asserts what it returns.
 */
function recordingQuarantine(
  respond = async (rowValue, event) => new Quarantined(rowValue.result, event.kind)
) {
  const group = {
    calls: [],
    produces: Quarantined,
    fact: async (rowValue, event) => {
      group.calls.push({ rowValue, event });
      return await respond(rowValue, event);
    }
  };
  return group;
}

/** Let every pending turn run, so a call that will not happen has not. */
async function quiesce() {
  for (let turn = 0; turn < 40; turn += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

/**
 * Wait for a state the worker reaches on its own turns.
 *
 * The bound is wall-clock rather than a count of turns, because some of these
 * waits sit behind a real backoff timer and a count of turns measures the
 * machine rather than the wait.
 */
async function until(condition, what) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(what);
}

/**
 * Wait for the next sweep to finish. `lastSweep` is written at the end of a
 * sweep, so a change in it is the sweep's own completion rather than a delay
 * chosen by the test.
 */
const sweepMark = sweep =>
  sweep === undefined ? "none" : `${sweep.at.getTime()}:${sweep.size}`;

async function nextSweep(worker) {
  const lastSweep = () => worker.status().consumers[0].lastSweep;
  const before = sweepMark(lastSweep());
  await until(() => sweepMark(lastSweep()) !== before, "no sweep completed");
}

/**
 * One consumer over the real outstanding set of `scene`. Every report the
 * worker emits is recorded, and a test that wants the callback to do something
 * of its own passes `onNoProgress` as well.
 */
function workerOver(t, scene, handle, options = {}) {
  const logger = recordingLogger();
  const events = [];
  const worker = new WorkerHost(options.j ?? scene.j, {
    consumers: [
      defineConsumer({
        name: "invitations",
        specification: outstanding,
        givens: [scene.acme],
        completes: Mirrored,
        handle,
        retry: FAST_RETRY,
        sweepIntervalMs: options.sweepIntervalMs ?? 60_000,
        ...(options.consumer ?? {})
      })
    ],
    onNoProgress: event => {
      events.push(event);
      return options.onNoProgress?.(event);
    },
    shutdownTimeoutMs: 10,
    logger
  });
  // Unconditional, so an assertion that fails still releases the timers and the
  // run ends in a failure rather than in a hang.
  t.after(() => worker.stop());
  return { worker, logger, events, rows: worker.runtimes[0].rows };
}

/** The row the consumer's own outstanding set gives a newly written subject. */
const rowOf = (scene, key) => outstandingRow(scene.j, scene.acme, key);

/**
 * A completion fact of the declared type built against another tenant's
 * subject. The store takes it, and it excludes nothing this consumer reads.
 */
const mirroringElsewhere = (scene, key) => new Mirrored(new Subject(scene.elsewhere, key));

/** Rules that admit every type but the one named, which is refused where it is asserted. */
const refusing = refused => a => [Tenant, Subject, Mirrored, Quarantined].reduce(
  (rules, type) => type === refused ? rules.no(type) : rules.any(type),
  a
);

const phaseOf = (rows, rowHash) => rows.get(rowHash)?.phase;

// ---------------------------------------------------------------------------
// Exhaustion.
// ---------------------------------------------------------------------------

test("calls the quarantine factory once when attempts are exhausted, and asserts what it returns", { timeout: DEADLINE_MS }, async t => {
  const scene = await world();
  const handle = recordingHandler(async () => {
    throw new Error("nope");
  });
  const quarantine = recordingQuarantine();
  const { worker, events, rows } = workerOver(t, scene, handle, {
    consumer: { quarantine }
  });
  const r1 = await rowOf(scene, "r1");

  await worker.start();

  await until(() => quarantine.calls.length > 0, "the quarantine factory was never called");
  await quiesce();

  assert.equal(quarantine.calls.length, 1, "the quarantine factory was called more than once");
  assert.equal(handle.handled.length, FAST_RETRY.maxAttempts, "the attempt limit was not honoured");

  const [call] = quarantine.calls;
  assert.equal(call.rowValue.rowHash, r1.rowHash, "the factory saw a different row than the handler");
  assert.equal(call.event.kind, "failed");
  assert.equal(call.event.rowHash, r1.rowHash);
  assert.equal(call.event.consumer, "invitations");
  assert.equal(events.length, 1, "onNoProgress fired more than once");

  // The handler rejected every attempt, so the only fact the store holds is the
  // one the quarantine factory returned, asserted by the library.
  assert.deepEqual(
    await hashesOf(scene.j, quarantinesOf, scene.acme),
    [scene.j.hash(new Quarantined(r1.result, "failed"))],
    "the fact the quarantine factory returned never reached the store"
  );
  assert.deepEqual(await hashesOf(scene.j, completionsOf, scene.acme), []);

  // The specification excludes that fact, so the row has left the outstanding
  // set and the stream releases it from the map.
  assert.deepEqual(await scene.j.queryRows(outstanding, scene.acme), []);
  await until(() => phaseOf(rows, r1.rowHash) === undefined, "the retired row was never released");

  await worker.stop();
});

test("quarantines the row even when the quarantine factory throws", { timeout: DEADLINE_MS }, async t => {
  const scene = await world();
  const handle = recordingHandler(async () => {
    throw new Error("nope");
  });
  const quarantine = recordingQuarantine(async () => {
    throw new Error("the factory failed");
  });
  const { worker, events, logger, rows } = workerOver(t, scene, handle, {
    consumer: { quarantine }
  });
  const r1 = await rowOf(scene, "r1");

  await worker.start();

  await until(() => events.length > 0, "the row was never reported");
  await quiesce();

  assert.equal(phaseOf(rows, r1.rowHash), "quarantined", "a failed factory put the row back in circulation");
  assert.equal(quarantine.calls.length, 1);
  assert.deepEqual(
    await hashesOf(scene.j, quarantinesOf, scene.acme),
    [],
    "a fact was stored though the factory never returned one"
  );
  assert.equal(events.length, 1, "the report was withheld because the factory failed");
  assert.equal(
    logger.lines.error.filter(line => line.message.includes("quarantine fact failed")).length,
    1,
    "the failed factory was not reported"
  );

  await worker.stop();
});

test("quarantines the row even when the store refuses the quarantine fact", { timeout: DEADLINE_MS }, async t => {
  // The factory returns its fact and the write is what fails, which is the
  // authorization denial of the pattern's own rules.
  const scene = await world({ authorization: refusing(Quarantined) });
  const handle = recordingHandler(async () => {
    throw new Error("nope");
  });
  const quarantine = recordingQuarantine();
  const { worker, events, logger, rows } = workerOver(t, scene, handle, {
    consumer: { quarantine }
  });
  const r1 = await rowOf(scene, "r1");

  await worker.start();

  await until(() => events.length > 0, "the row was never reported");
  await quiesce();

  assert.equal(phaseOf(rows, r1.rowHash), "quarantined", "a refused write put the row back in circulation");
  assert.equal(quarantine.calls.length, 1, "the factory was re-run after the refusal");
  assert.deepEqual(
    await hashesOf(scene.j, quarantinesOf, scene.acme),
    [],
    "a refused write reached the store"
  );
  assert.equal(events.length, 1, "the report was withheld because the write was refused");
  assert.equal(
    logger.lines.error.filter(line => line.message.includes("quarantine fact failed")).length,
    1,
    "the refused write was not reported"
  );

  await worker.stop();
});

test("skips a quarantined row on every later sweep, and emits onNoProgress once", { timeout: DEADLINE_MS }, async t => {
  // The rules refuse the quarantine fact, so the row is still in the
  // outstanding set and every later sweep offers it again. What holds it out of
  // circulation is the map, which is what this is about.
  const scene = await world({ authorization: refusing(Quarantined) });
  const handle = recordingHandler(async () => {
    throw new Error("nope");
  });
  const quarantine = recordingQuarantine();
  const { worker, events, rows } = workerOver(t, scene, handle, {
    consumer: { quarantine },
    sweepIntervalMs: 1
  });
  const r1 = await rowOf(scene, "r1");

  await worker.start();

  await until(() => phaseOf(rows, r1.rowHash) === "quarantined", "the row was never quarantined");
  const attempts = handle.handled.length;

  await nextSweep(worker);
  await nextSweep(worker);
  await nextSweep(worker);

  assert.equal(handle.handled.length, attempts, "a sweep re-dispatched a quarantined row");
  assert.equal(events.length, 1, "the report fired again for a row already given up on");
  assert.equal(quarantine.calls.length, 1, "quarantine was written again");
  assert.equal(phaseOf(rows, r1.rowHash), "quarantined");
  assert.equal(
    (await scene.j.queryRows(outstanding, scene.acme)).length,
    1,
    "the row this is about left the outstanding set"
  );

  await worker.stop();
});

// ---------------------------------------------------------------------------
// The two diagnoses.
// ---------------------------------------------------------------------------

test("reports stalled when the handler resolves and a later sweep still returns the row", { timeout: DEADLINE_MS }, async t => {
  // Each attempt's fact is stored and excludes nothing the specification reads,
  // so every sweep goes on returning the row.
  const scene = await world();
  const handle = recordingHandler(async () => mirroringElsewhere(scene, "r9"));
  const { worker, events, rows } = workerOver(t, scene, handle, { sweepIntervalMs: 1 });
  const r1 = await rowOf(scene, "r1");

  await worker.start();

  await until(() => events.length > 0, "the stalled row was never reported");
  await quiesce();

  const [event] = events;
  assert.equal(event.kind, "stalled");
  assert.equal(
    "error" in event,
    false,
    "a stalled event carries an error, though the handler resolved"
  );
  assert.equal(event.consumer, "invitations");
  assert.equal(event.rowHash, r1.rowHash);
  assert.equal(event.result.key, "r1", "the event did not carry the projection the handler saw");
  assert.equal(event.attempts, FAST_RETRY.maxAttempts);
  assert.equal(event.quarantineDepth, 1);
  assert.ok(event.elapsedMs >= 0, "elapsedMs did not span the attempts");
  assert.equal(handle.handled.length, FAST_RETRY.maxAttempts, "the sweep kept re-dispatching a resolved row");
  assert.equal(phaseOf(rows, r1.rowHash), "quarantined");
  assert.equal(events.length, 1, "every later sweep reported the row again");

  await worker.stop();
});

test("reports failed, with the last rejection, when the handler throws to exhaustion", { timeout: DEADLINE_MS }, async t => {
  const scene = await world();
  const handle = recordingHandler(async (rowValue, attempt) => {
    throw new Error(`attempt ${attempt} failed`);
  });
  const { worker, events } = workerOver(t, scene, handle);
  await rowOf(scene, "r1");

  await worker.start();

  await until(() => events.length > 0, "the failed row was never reported");

  const [event] = events;
  assert.equal(event.kind, "failed");
  assert.equal(event.attempts, FAST_RETRY.maxAttempts);
  assert.equal(
    event.error.message,
    `attempt ${FAST_RETRY.maxAttempts} failed`,
    "the event carried a rejection other than the last one"
  );
  assert.equal(event.quarantineDepth, 1);

  await worker.stop();
});

// ---------------------------------------------------------------------------
// What a stalled report says about the one cause that cannot be checked.
// ---------------------------------------------------------------------------

test("a completion fact built against another row reports stalled naming the fact that was written", { timeout: DEADLINE_MS }, async t => {
  // The residual case of §10.2 T2. The fact carries exactly the type the
  // consumer declared, so `defineConsumer` had nothing to refuse and the store
  // takes the write; its subject is a row other than the one the handler was
  // given, so the specification goes on returning this one.
  const scene = await world();
  const written = mirroringElsewhere(scene, "r9");
  const handle = recordingHandler(async () => written);
  const { worker, events, logger, rows } = workerOver(t, scene, handle, { sweepIntervalMs: 1 });
  const r1 = await rowOf(scene, "r1");

  await worker.start();

  await until(() => events.length > 0, "the stalled row was never reported");
  await quiesce();

  const [event] = events;
  assert.equal(event.kind, "stalled");
  assert.equal(phaseOf(rows, r1.rowHash), "quarantined");

  assert.equal(event.completionType, Mirrored.Type, "the event did not name the declared type");
  assert.deepEqual(
    [...event.retiringTypes].sort(),
    [Mirrored.Type, Quarantined.Type].sort(),
    "the event did not name the types the specification retires a row on"
  );
  // The two halves of the comparison, as the event states it: the declared type
  // is among the retiring types, so the shape of the specification is right and
  // the fact was written. Which row it points at is what is left.
  assert.ok(
    event.retiringTypes.includes(event.completionType),
    "the declared type is not among the retiring types, so this is not the residual case"
  );

  assert.equal(
    event.completionHash,
    scene.j.hash(written),
    "completionHash does not name the fact the handler returned"
  );
  assert.deepEqual(
    await hashesOf(scene.j, completionsOf, scene.elsewhere),
    [event.completionHash],
    "completionHash resolves to no fact the store holds"
  );
  assert.notEqual(
    event.completionHash,
    scene.j.hash(new Mirrored(r1.result)),
    "the event named the fact the row was owed rather than the one that was written"
  );

  // The exhaustion log carries the same members, so the diagnosis is greppable
  // from a consumer that declared no `onNoProgress`.
  const logged = logger.lines.warn.find(line => line.message.includes(`stalled on ${r1.rowHash}`));
  assert.ok(logged !== undefined, "the exhaustion was never logged");
  assert.equal(logged.data.completionType, Mirrored.Type);
  assert.equal(logged.data.completionHash, event.completionHash);
  assert.deepEqual(
    [...logged.data.retiringTypes].sort(),
    [Mirrored.Type, Quarantined.Type].sort()
  );

  await worker.stop();
});

test("a failed event carries none of the three, because the handler produced no fact", { timeout: DEADLINE_MS }, async t => {
  const scene = await world();
  const handle = recordingHandler(async () => {
    throw new Error("nope");
  });
  const { worker, events } = workerOver(t, scene, handle);
  await rowOf(scene, "r1");

  await worker.start();

  await until(() => events.length > 0, "the failed row was never reported");
  await quiesce();

  const [event] = events;
  assert.equal(event.kind, "failed");
  assert.deepEqual(
    await hashesOf(scene.j, completionsOf, scene.acme),
    [],
    "a fact was written though every attempt rejected"
  );
  for (const member of ["completionType", "retiringTypes", "completionHash"]) {
    assert.equal(
      member in event,
      false,
      `a failed event carries ${member}, though there is no completion fact to describe`
    );
  }

  await worker.stop();
});

test("completionHash names the fact of the attempt that exhausted the row, not an earlier one", { timeout: DEADLINE_MS }, async t => {
  // A different subject per attempt, so the facts are distinct and the event
  // can only be carrying one of them. None of them is the row's own, so the
  // row stays outstanding and the sweep asks again.
  const scene = await world();
  const handle = recordingHandler(async (rowValue, attempt) =>
    mirroringElsewhere(scene, `r9-${attempt}`));
  const { worker, events } = workerOver(t, scene, handle, { sweepIntervalMs: 1 });
  await rowOf(scene, "r1");

  await worker.start();

  await until(() => events.length > 0, "the stalled row was never reported");
  await quiesce();

  const [event] = events;
  assert.equal(event.kind, "stalled");
  assert.equal(handle.handled.length, FAST_RETRY.maxAttempts, "the attempt limit was not honoured");

  // Every attempt's fact is in the store, so the event is picking one of them
  // rather than naming the only one there is.
  const stored = await hashesOf(scene.j, completionsOf, scene.elsewhere);
  assert.deepEqual(
    [...stored].sort(),
    Array.from({ length: FAST_RETRY.maxAttempts }, (unused, index) =>
      scene.j.hash(mirroringElsewhere(scene, `r9-${index + 1}`))).sort(),
    "the store does not hold one distinct fact per attempt"
  );
  assert.equal(
    event.completionHash,
    scene.j.hash(mirroringElsewhere(scene, `r9-${FAST_RETRY.maxAttempts}`)),
    "the event named the fact of an earlier attempt"
  );

  await worker.stop();
});

// ---------------------------------------------------------------------------
// The specification's account of the diagnosis.
// ---------------------------------------------------------------------------

// §2.3's type block is held to `src/no-progress.ts` by the guard in
// spec-types.test.js, which compiles it. §10.2 is prose, which nothing
// compiles, and it is where the specification sends an operator for the
// residual case, so the members it names are checked here.
test("§10.2 T2 names the three members as where the residual case is diagnosed", () => {
  const tensions = fs.readFileSync(specPath, "utf8").split(/^### 10\.2 Tensions$/m)[1];
  assert.ok(tensions !== undefined, "the specification no longer has a §10.2 Tensions");

  const t2 = tensions.split("**T2 ")[1]?.split("**T3 ")[0];
  assert.ok(t2 !== undefined, "§10.2 no longer records T2");

  const paragraphs = t2.trim().split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1].replace(/\s+/g, " ");

  assert.match(last, /`stalled`/, "T2's last paragraph no longer points at the stalled event");
  for (const member of ["completionType", "retiringTypes", "completionHash"]) {
    assert.match(
      last,
      new RegExp(`\`${member}\``),
      `T2's last paragraph does not name ${member}`
    );
  }
});

// ---------------------------------------------------------------------------
// The callbacks are the application's, and bounded.
// ---------------------------------------------------------------------------

test("reports failed, carrying the refusal, when the store refuses the completion fact", { timeout: DEADLINE_MS }, async t => {
  // The handler resolves every time. Only the write fails, and the library is
  // the party that performs it, so the refusal is the attempt's own error
  // rather than a diagnosis the loop has to guess at. The row stays in the
  // outstanding set, which is the reading under which a resolved handler would
  // have been called stalled.
  const scene = await world({ authorization: refusing(Mirrored) });
  const handle = recordingHandler();
  const { worker, events, rows } = workerOver(t, scene, handle, { sweepIntervalMs: 1 });
  const r1 = await rowOf(scene, "r1");

  await worker.start();

  await until(() => events.length > 0, "the row was never reported");
  await quiesce();

  const [event] = events;
  assert.equal(event.kind, "failed", "a refused completion fact was reported as stalled");
  assert.match(
    event.error.message,
    new RegExp(Mirrored.Type.replace(/\./g, "\\.")),
    "the event did not carry the refusal"
  );
  assert.equal(event.attempts, FAST_RETRY.maxAttempts);
  assert.deepEqual(
    await hashesOf(scene.j, completionsOf, scene.acme),
    [],
    "a refused write reached the store"
  );
  assert.equal(handle.handled.length, FAST_RETRY.maxAttempts, "the attempt limit was not honoured");
  assert.equal(phaseOf(rows, r1.rowHash), "quarantined");

  await worker.stop();
});

test("an onNoProgress callback that never settles does not wedge the loop", { timeout: DEADLINE_MS }, async t => {
  const scene = await world();
  const handle = recordingHandler(async rowValue =>
    rowValue.result.key === "r1"
      ? Promise.reject(new Error("nope"))
      : new Mirrored(rowValue.result));
  const { worker, logger, rows } = workerOver(t, scene, handle, {
    consumer: { handlerTimeoutMs: 20 },
    onNoProgress: () => new Promise(() => {})
  });
  const r1 = await rowOf(scene, "r1");

  await worker.start();

  await until(() => phaseOf(rows, r1.rowHash) === "quarantined", "the row was never quarantined");

  // The loop is still discovering, so a row written now is handled and its
  // completion fact reaches the store while the report hangs.
  await scene.j.fact(new Subject(scene.acme, "r2"));
  await until(
    async () => (await hashesOf(scene.j, completionsOf, scene.acme)).length === 1,
    "the loop stopped while the report hung"
  );

  await until(
    () => logger.lines.error.some(line => line.message.includes("onNoProgress failed")),
    "the report was never bounded"
  );

  await worker.stop();
});

test("a consumer with no quarantine group still reports failed, and writes nothing", { timeout: DEADLINE_MS }, async t => {
  const scene = await world();
  const handle = recordingHandler(async () => {
    throw new Error("nope");
  });
  const { worker, events, rows } = workerOver(t, scene, handle);
  const r1 = await rowOf(scene, "r1");

  await worker.start();

  await until(() => events.length > 0, "the row was never reported");
  await quiesce();

  assert.equal(handle.handled.length, FAST_RETRY.maxAttempts, "the attempt limit was not honoured");
  assert.equal(phaseOf(rows, r1.rowHash), "quarantined");
  assert.equal(events[0].kind, "failed");
  assert.equal(events.length, 1);
  assert.deepEqual(
    await hashesOf(scene.j, completionsOf, scene.acme),
    [],
    "a consumer that declared no group still wrote something"
  );
  assert.deepEqual(await hashesOf(scene.j, quarantinesOf, scene.acme), []);

  await worker.stop();
});

test("a consumer with no quarantine group still reports stalled, and writes only its completions", { timeout: DEADLINE_MS }, async t => {
  // The handler resolves and its fact is stored every time, and the sweep goes
  // on returning the row: the fact excludes nothing the specification reads.
  const scene = await world();
  const handle = recordingHandler(async () => mirroringElsewhere(scene, "r9"));
  const { worker, events, rows } = workerOver(t, scene, handle, { sweepIntervalMs: 1 });
  const r1 = await rowOf(scene, "r1");

  await worker.start();

  await until(() => events.length > 0, "the row was never reported");
  await quiesce();

  assert.equal(handle.handled.length, FAST_RETRY.maxAttempts, "the attempt limit was not honoured");
  assert.equal(phaseOf(rows, r1.rowHash), "quarantined");
  assert.equal(events[0].kind, "stalled");
  assert.equal(events.length, 1);
  // Facts are content-addressed, so the attempts that wrote one fact hold one
  // fact. What the store gained is the completion the handler returned, and
  // nothing the consumer never declared.
  assert.deepEqual(
    await hashesOf(scene.j, completionsOf, scene.elsewhere),
    [scene.j.hash(mirroringElsewhere(scene, "r9"))],
    "the store holds something other than the completion fact"
  );
  assert.deepEqual(await hashesOf(scene.j, quarantinesOf, scene.acme), []);

  await worker.stop();
});

// ---------------------------------------------------------------------------
// Suppression, and the one addition that gets past it.
// ---------------------------------------------------------------------------

test("a quarantined row released by a stale added is re-attempted, and quarantine holds against every sweep", { timeout: DEADLINE_MS }, async t => {
  // A fact retires a row for good, so the store cannot deliver an addition
  // behind the removal that retired it. The stream can, in either order, and
  // this is what the loop does with it. The rows are the store's own: the
  // subject is written, the sweep reads it, and the stream replays that row.
  const scene = await world();
  const handle = recordingHandler(async () => {
    throw new Error("nope");
  });
  const stream = controllableStream();
  const r1 = await rowOf(scene, "r1");
  const j = driving(scene.j, {
    subscribeRows: async () => stream,
    queryRows: async () => [r1]
  });
  const { worker, rows } = workerOver(t, scene, handle, { j, sweepIntervalMs: 1 });
  const change = operation => ({ result: r1.result, rowHash: r1.rowHash, operation });

  await worker.start();

  await until(() => phaseOf(rows, r1.rowHash) === "quarantined", "the row was never quarantined");
  const attempts = handle.handled.length;

  await nextSweep(worker);
  await nextSweep(worker);
  assert.equal(handle.handled.length, attempts, "a sweep re-dispatched a quarantined row");

  // Both changes are queued before the stream's loop drains them, so they are
  // applied on one pass and no sweep lands between them. What re-admits the row
  // is therefore the addition behind the removal, and nothing else.
  const release = stream.push(change("removed"));
  const stale = stream.push(change("added"));
  await Promise.all([release, stale]);

  assert.equal(
    phaseOf(rows, r1.rowHash),
    "dispatching",
    "a removed and the added behind it did not re-admit the row"
  );
  await until(() => handle.handled.length > attempts, "the re-admitted row was never attempted");

  await worker.stop();
});

// ---------------------------------------------------------------------------
// Startup diagnostics.
// ---------------------------------------------------------------------------

const diagnostic = (overrides = {}) => ({
  operation: "subscribe",
  specification: "invitations",
  decision: "reactive",
  code: "no-matching-rule",
  reactive: true,
  reason: "no rule authorizes this feed yet",
  feed: "feed-1",
  ...overrides
});

test("a reactive decision is a warning, reported once per feed and code", async () => {
  const logger = recordingLogger();
  const report = distributionDiagnostics(logger);

  report(diagnostic());
  report(diagnostic());
  report(diagnostic({ code: "principal-excluded" }));
  report(diagnostic({ feed: "feed-2" }));

  assert.equal(logger.lines.warn.length, 3, "the same feed and code was reported more than once");
  assert.equal(logger.lines.error.length, 0, "a reactive decision was reported as an error");
  assert.deepEqual(
    logger.lines.warn.map(line => [line.data.feed, line.data.code]),
    [["feed-1", "no-matching-rule"], ["feed-1", "principal-excluded"], ["feed-2", "no-matching-rule"]]
  );
});

test("a feed that begins delivering retires its report, so a later denial is reported again", async () => {
  const logger = recordingLogger();
  const report = distributionDiagnostics(logger);

  report(diagnostic());
  report(diagnostic({ cleared: true }));
  report(diagnostic());

  assert.equal(logger.lines.warn.length, 2, "the feed's later denial was suppressed by the cleared one");
  assert.equal(logger.lines.info.length, 1, "the feed was never reported as delivering");
});

test("a structural denial is reported, and reporting one is never fatal", async () => {
  const logger = recordingLogger();
  const report = distributionDiagnostics(logger);

  report(diagnostic({ decision: "denied", reactive: false, reason: "no rule matches" }));

  assert.equal(logger.lines.error.length, 1);
  assert.equal(logger.lines.warn.length, 0);
});

test("the diagnostics channel is registered before the first subscribe", { timeout: DEADLINE_MS }, async t => {
  const scene = await world();
  const order = [];
  const j = driving(scene.j, {
    onDistributionDiagnostic: report => {
      order.push("registered");
      return scene.j.onDistributionDiagnostic(report);
    },
    subscribeRows: async (...args) => {
      order.push("subscribed");
      return await scene.j.subscribeRows(...args);
    }
  });
  const { worker } = workerOver(t, scene, recordingHandler(), { j });

  await worker.start();

  assert.deepEqual(order, ["registered", "subscribed"], "a denial before the first subscribe would be lost");

  await worker.stop();
});

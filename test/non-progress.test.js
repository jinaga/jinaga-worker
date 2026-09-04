const test = require("node:test");
const assert = require("node:assert/strict");

const { defineConsumer } = require("../dist/index.js");
const { WorkerHost } = require("../dist/worker.js");
const { distributionDiagnostics } = require("../dist/diagnostics.js");

// A given is a fact, and non-progress asks nothing of one but its hash.
const tenant = id => ({ type: "Test.Tenant", id });

const row = rowHash => ({ result: { id: rowHash }, rowHash });
const added = rowHash => ({ ...row(rowHash), operation: "added" });
const removed = rowHash => ({ ...row(rowHash), operation: "removed" });

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

/** The sweep's half of the seam: what `queryRows` returns, and how often it ran. */
function controllableQuery(rows = []) {
  const query = {
    rows,
    calls: 0,
    returns(next) {
      query.rows = next;
    },
    read: async () => {
      query.calls += 1;
      return query.rows;
    }
  };
  return query;
}

function fakeJinaga(stream, query) {
  return {
    hash: fact => `hash-of-${fact.id}`,
    onDistributionDiagnostic: () => {},
    subscribeRows: async () => stream,
    queryRows: query.read
  };
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
 * which is given the row and the number of this call.
 */
function recordingHandler(respond = async () => {}) {
  const handle = async rowValue => {
    handle.handled.push(rowValue.rowHash);
    return await respond(rowValue, handle.handled.length);
  };
  handle.handled = [];
  return handle;
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
    if (condition()) {
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
 * One consumer, its stream and its sweep. Every report the worker emits is
 * recorded, and a test that wants the callback to do something of its own
 * passes `onNoProgress` as well.
 */
function workerOver(t, handle, options = {}) {
  const stream = controllableStream();
  const query = controllableQuery(options.sweepRows ?? []);
  const logger = recordingLogger();
  const events = [];
  const worker = new WorkerHost(fakeJinaga(stream, query), {
    consumers: [
      defineConsumer({
        name: "invitations",
        specification: { name: "invitations" },
        givens: [tenant("invitations")],
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
  return { worker, stream, query, logger, events, rows: worker.runtimes[0].rows };
}

const phaseOf = (rows, rowHash) => rows.get(rowHash)?.phase;

/** A `quarantine` callback that records its calls and answers from `respond`. */
function recordingQuarantine(respond = async () => {}) {
  const quarantine = async (rowValue, event) => {
    quarantine.calls.push({ rowValue, event });
    return await respond(rowValue, event);
  };
  quarantine.calls = [];
  return quarantine;
}

// ---------------------------------------------------------------------------
// Exhaustion.
// ---------------------------------------------------------------------------

test("calls quarantine exactly once when attempts are exhausted", { timeout: DEADLINE_MS }, async t => {
  const handle = recordingHandler(async () => {
    throw new Error("nope");
  });
  const quarantine = recordingQuarantine();
  const { worker, stream, rows, events } = workerOver(t, handle, {
    consumer: { quarantine }
  });

  await worker.start();
  await stream.push(added("r1"));

  await until(() => quarantine.calls.length > 0, "quarantine was never called");
  await quiesce();

  assert.equal(quarantine.calls.length, 1, "quarantine was called more than once");
  assert.equal(handle.handled.length, FAST_RETRY.maxAttempts, "the attempt limit was not honoured");
  assert.equal(phaseOf(rows, "r1"), "quarantined");

  const [call] = quarantine.calls;
  assert.deepEqual(call.rowValue, row("r1"), "quarantine saw a different row than the handler");
  assert.equal(call.event.kind, "failed");
  assert.equal(call.event.rowHash, "r1");
  assert.equal(call.event.consumer, "invitations");
  assert.equal(events.length, 1, "onNoProgress fired more than once");

  await worker.stop();
});

test("quarantines the row even when the quarantine callback throws", { timeout: DEADLINE_MS }, async t => {
  const handle = recordingHandler(async () => {
    throw new Error("nope");
  });
  const quarantine = recordingQuarantine(async () => {
    throw new Error("the write was denied");
  });
  const { worker, stream, rows, events, logger } = workerOver(t, handle, {
    consumer: { quarantine }
  });

  await worker.start();
  await stream.push(added("r1"));

  await until(() => events.length > 0, "the row was never reported");
  await quiesce();

  assert.equal(phaseOf(rows, "r1"), "quarantined", "a failed write put the row back in circulation");
  assert.equal(quarantine.calls.length, 1);
  assert.equal(events.length, 1, "the report was withheld because the write failed");
  assert.equal(
    logger.lines.error.filter(line => line.message.includes("quarantine callback failed")).length,
    1,
    "the failed write was not reported"
  );

  await worker.stop();
});

test("skips a quarantined row on every later sweep, and emits onNoProgress once", { timeout: DEADLINE_MS }, async t => {
  const handle = recordingHandler(async () => {
    throw new Error("nope");
  });
  const quarantine = recordingQuarantine();
  const { worker, rows, events } = workerOver(t, handle, {
    consumer: { quarantine },
    sweepIntervalMs: 1,
    sweepRows: [row("r1")]
  });

  await worker.start();

  await until(() => phaseOf(rows, "r1") === "quarantined", "the row was never quarantined");
  const attempts = handle.handled.length;

  await nextSweep(worker);
  await nextSweep(worker);
  await nextSweep(worker);

  assert.equal(handle.handled.length, attempts, "a sweep re-dispatched a quarantined row");
  assert.equal(events.length, 1, "the report fired again for a row already given up on");
  assert.equal(quarantine.calls.length, 1, "quarantine was written again");
  assert.equal(phaseOf(rows, "r1"), "quarantined");

  await worker.stop();
});

// ---------------------------------------------------------------------------
// The two diagnoses.
// ---------------------------------------------------------------------------

test("reports stalled when the handler resolves and a later sweep still returns the row", { timeout: DEADLINE_MS }, async t => {
  const handle = recordingHandler();
  const { worker, rows, events } = workerOver(t, handle, {
    sweepIntervalMs: 1,
    sweepRows: [row("r1")]
  });

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
  assert.equal(event.rowHash, "r1");
  assert.deepEqual(event.result, { id: "r1" }, "the event did not carry the projection the handler saw");
  assert.equal(event.attempts, FAST_RETRY.maxAttempts);
  assert.equal(event.quarantineDepth, 1);
  assert.ok(event.elapsedMs >= 0, "elapsedMs did not span the attempts");
  assert.equal(handle.handled.length, FAST_RETRY.maxAttempts, "the sweep kept re-dispatching a resolved row");
  assert.equal(phaseOf(rows, "r1"), "quarantined");
  assert.equal(events.length, 1, "every later sweep reported the row again");

  await worker.stop();
});

test("reports failed, with the last rejection, when the handler throws to exhaustion", { timeout: DEADLINE_MS }, async t => {
  const handle = recordingHandler(async (rowValue, attempt) => {
    throw new Error(`attempt ${attempt} failed`);
  });
  const { worker, stream, events } = workerOver(t, handle);

  await worker.start();
  await stream.push(added("r1"));

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
// The callbacks are the application's, and bounded.
// ---------------------------------------------------------------------------

test("an onNoProgress callback that never settles does not wedge the loop", { timeout: DEADLINE_MS }, async t => {
  const handle = recordingHandler(async rowValue => {
    if (rowValue.rowHash === "r1") {
      throw new Error("nope");
    }
  });
  const { worker, stream, rows, logger } = workerOver(t, handle, {
    consumer: { handlerTimeoutMs: 20 },
    onNoProgress: () => new Promise(() => {})
  });

  await worker.start();
  await stream.push(added("r1"));

  await until(() => phaseOf(rows, "r1") === "quarantined", "the row was never quarantined");

  await stream.push(added("r2"));
  await until(() => phaseOf(rows, "r2") === "completed", "the loop stopped while the report hung");
  assert.deepEqual(handle.handled.slice(-1), ["r2"]);

  await until(
    () => logger.lines.error.some(line => line.message.includes("onNoProgress failed")),
    "the report was never bounded"
  );

  await worker.stop();
});

test("a consumer with no quarantine callback still caps attempts and still emits the event", { timeout: DEADLINE_MS }, async t => {
  const handle = recordingHandler(async () => {
    throw new Error("nope");
  });
  const { worker, stream, rows, events } = workerOver(t, handle);

  await worker.start();
  await stream.push(added("r1"));

  await until(() => events.length > 0, "the row was never reported");
  await quiesce();

  assert.equal(handle.handled.length, FAST_RETRY.maxAttempts, "the attempt limit was not honoured");
  assert.equal(phaseOf(rows, "r1"), "quarantined");
  assert.equal(events[0].kind, "failed");
  assert.equal(events.length, 1);

  await worker.stop();
});

// ---------------------------------------------------------------------------
// Suppression, and the one addition that gets past it.
// ---------------------------------------------------------------------------

test("a quarantined row released by a stale added is re-attempted, and quarantine holds against every sweep", { timeout: DEADLINE_MS }, async t => {
  const handle = recordingHandler(async () => {
    throw new Error("nope");
  });
  const { worker, stream, rows } = workerOver(t, handle, {
    sweepIntervalMs: 1,
    sweepRows: [row("r1")]
  });

  await worker.start();

  await until(() => phaseOf(rows, "r1") === "quarantined", "the row was never quarantined");
  const attempts = handle.handled.length;

  await nextSweep(worker);
  await nextSweep(worker);
  assert.equal(handle.handled.length, attempts, "a sweep re-dispatched a quarantined row");

  // Both changes are queued before the stream's loop drains them, so they are
  // applied on one pass and no sweep lands between them. What re-admits the row
  // is therefore the addition behind the removal, and nothing else.
  const release = stream.push(removed("r1"));
  const stale = stream.push(added("r1"));
  await Promise.all([release, stale]);

  assert.equal(phaseOf(rows, "r1"), "dispatching", "a removed and the added behind it did not re-admit the row");
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
  const order = [];
  const stream = controllableStream();
  const worker = new WorkerHost({
    hash: fact => `hash-of-${fact.id}`,
    onDistributionDiagnostic: () => order.push("registered"),
    subscribeRows: async () => {
      order.push("subscribed");
      return stream;
    },
    queryRows: async () => []
  }, {
    consumers: [
      defineConsumer({
        name: "invitations",
        specification: { name: "invitations" },
        givens: [tenant("invitations")],
        handle: async () => {}
      })
    ],
    shutdownTimeoutMs: 10,
    logger: recordingLogger()
  });
  t.after(() => worker.stop());

  await worker.start();

  assert.deepEqual(order, ["registered", "subscribed"], "a denial before the first subscribe would be lost");

  await worker.stop();
});

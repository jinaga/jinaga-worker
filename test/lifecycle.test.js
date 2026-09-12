const test = require("node:test");
const assert = require("node:assert/strict");

const { defineConsumer, createWorker } = require("../dist/index.js");
const { WorkerHost } = require("../dist/worker.js");
const {
  Mirrored,
  Tenant,
  driving,
  outstanding,
  outstandingRow,
  world
} = require("./outstanding-model.js");

/**
 * A handler that completes its row. Most of these tests are about the
 * lifecycle and never dispatch one, so this is what a consumer declares when
 * the handler itself is not what the test is about.
 */
const completing = async row => new Mirrored(row.result);

/**
 * The stage these tests run on: a real instance, a tenant per consumer, and a
 * row of each tenant's own outstanding set.
 *
 * The lifecycle is about what a worker does around the replicator, so the
 * subscribe is the test's: `streams` answers it, keyed by the consumer's given.
 * Everything else — the given hashes a worker logs, the completion fact a
 * drained attempt writes — is the instance's own.
 */
async function stage(streams = {}) {
  const { j } = await world();
  const tenants = {};
  const rows = {};
  for (const name of ["invitations", "attendees"]) {
    tenants[name] = await j.fact(new Tenant(name));
    rows[name] = await outstandingRow(j, tenants[name], "row-1");
  }
  const replicator = driving(j, {
    subscribeRows: async (specification, given) => {
      const open = streams[given.identifier];
      return open === undefined ? openStream() : await open();
    }
  });
  return { j, tenants, rows, replicator };
}

function openStream() {
  const stream = {
    stopped: 0,
    dropped: 0,
    pending: 0,
    stop: () => {
      stream.stopped += 1;
    },
    [Symbol.asyncIterator]: async function* () {}
  };
  return stream;
}

/**
 * A stream that offers a row to whatever iterates it, and reports a non-zero
 * `dropped`. Both are how a test sees that a runtime took the stream: one
 * dispatches, the other reaches `status()`.
 */
function offeringStream(row) {
  const stream = {
    stopped: 0,
    dropped: 3,
    pending: 0,
    stop: () => {
      stream.stopped += 1;
    },
    [Symbol.asyncIterator]: async function* () {
      yield { operation: "added", result: row.result, rowHash: row.rowHash };
    }
  };
  return stream;
}

function recordingLogger() {
  const entries = [];
  const record = level => (message, data) => entries.push({ level, message, data });
  return { entries, info: record("info"), warn: record("warn"), error: record("error") };
}

function deferred() {
  let settle;
  const promise = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  return { promise, ...settle };
}

const consumerOf = (stage, name, handle, options = {}) => defineConsumer({
  name,
  specification: outstanding,
  givens: [stage.tenants[name]],
  completes: Mirrored,
  handle,
  ...options
});

/**
 * A later turn of the event loop. A dispatch scheduled before this one runs
 * first, so what has not happened by here was not scheduled.
 */
const nextTurn = () => new Promise(resolve => setTimeout(resolve, 0));

const timerCount = () =>
  process.getActiveResourcesInfo().filter(resource => resource === "Timeout").length;

test("stop() before start() resolves cleanly and reports zeros", async () => {
  const set = await stage();
  const worker = createWorker(set.replicator, {
    consumers: [consumerOf(set, "invitations", completing)],
    logger: recordingLogger()
  });

  assert.deepEqual(await worker.stop(), { drained: 0, abandoned: 0 });
});

test("stop() drains a settled handler and counts it in drained", async () => {
  const set = await stage();
  const handler = deferred();
  const worker = new WorkerHost(set.replicator, {
    consumers: [consumerOf(set, "invitations", () => handler.promise)],
    logger: recordingLogger()
  });
  await worker.start();

  const row = set.rows.invitations;
  const running = worker.runtimes[0].attempt(row.rowHash, row);
  assert.equal(worker.status().consumers[0].dispatching, 1);

  const stopping = worker.stop();
  handler.resolve(new Mirrored(row.result));
  await running;

  assert.deepEqual(await stopping, { drained: 1, abandoned: 0 });
  assert.equal(worker.status().consumers[0].completed, 1);
});

test("a handler still running at the deadline is abandoned without delaying stop()", async () => {
  const set = await stage();
  const handler = deferred();
  const worker = new WorkerHost(set.replicator, {
    consumers: [consumerOf(set, "invitations", () => handler.promise)],
    shutdownTimeoutMs: 20,
    logger: recordingLogger()
  });
  await worker.start();
  const row = set.rows.invitations;
  worker.runtimes[0].attempt(row.rowHash, row);

  const startedAt = Date.now();
  const report = await worker.stop();
  const elapsed = Date.now() - startedAt;

  assert.deepEqual(report, { drained: 0, abandoned: 1 });
  assert.ok(elapsed < 1_000, `stop() waited ${elapsed}ms past its 20ms deadline`);
  assert.equal(worker.status().consumers[0].dispatching, 1);

  handler.resolve(new Mirrored(row.result));
});

test("an attempt is suppressed while the map holds an entry for the row", async () => {
  const set = await stage();
  const handler = deferred();
  let handled = 0;
  const worker = new WorkerHost(set.replicator, {
    consumers: [consumerOf(set, "invitations", () => {
      handled += 1;
      return handler.promise;
    })],
    logger: recordingLogger()
  });
  const runtime = worker.runtimes[0];
  const row = set.rows.invitations;

  assert.notEqual(runtime.attempt(row.rowHash, row), undefined);
  assert.equal(runtime.attempt(row.rowHash, row), undefined);
  assert.equal(handled, 0, "the handler ran on the offering turn");
  assert.equal(worker.status().consumers[0].dispatching, 1);

  // The one admission dispatches on a turn of its own, and the suppressed
  // offer has nothing of its own to dispatch.
  await nextTurn();
  assert.equal(handled, 1);

  handler.resolve(new Mirrored(row.result));
  await worker.stop();
});

test("stop() drops waiting rows rather than draining them", async () => {
  const set = await stage();
  const worker = new WorkerHost(set.replicator, {
    consumers: [consumerOf(set, "invitations", completing)],
    logger: recordingLogger()
  });
  const rows = worker.runtimes[0].rows;
  const row = set.rows.invitations;
  rows.set(row.rowHash, {
    phase: "waiting",
    row,
    attempts: 1,
    firstAttemptAt: 0,
    retryAt: 1
  });

  assert.deepEqual(await worker.stop(), { drained: 0, abandoned: 0 });
  assert.equal(rows.size, 0);
});

test("start() rejects when subscribeRows rejects, and leaves no timers behind", async () => {
  const before = timerCount();
  const opened = [];
  const set = await stage({
    invitations: () => {
      const stream = openStream();
      opened.push(stream);
      return stream;
    },
    attendees: () => {
      throw new Error("distribution denied");
    }
  });
  const worker = createWorker(set.replicator, {
    consumers: [
      consumerOf(set, "invitations", completing),
      consumerOf(set, "attendees", completing)
    ],
    logger: recordingLogger()
  });

  await assert.rejects(() => worker.start(), /distribution denied/);

  assert.equal(opened.length, 1);
  assert.equal(opened[0].stopped, 1);
  assert.equal(timerCount(), before);
});

test("stop() during a pending subscribe releases the stream the replicator answers with", async () => {
  const before = timerCount();
  const answer = deferred();
  let handled = 0;
  const set = await stage({ invitations: () => answer.promise });
  const stream = offeringStream(set.rows.invitations);
  const worker = new WorkerHost(set.replicator, {
    consumers: [consumerOf(set, "invitations", async row => {
      handled += 1;
      return new Mirrored(row.result);
    })],
    logger: recordingLogger()
  });

  // The boot path a service lands on: `start()` is not awaited, so SIGTERM can
  // arrive while the subscribe is still outstanding.
  const starting = worker.start();
  const report = await worker.stop();
  answer.resolve(stream);
  await starting;
  await nextTurn();
  await nextTurn();

  assert.equal(stream.stopped, 1, "the stream handed to a stopped consumer was not released");
  assert.equal(worker.runtimes[0].discovering, false);
  assert.deepEqual(report, { drained: 0, abandoned: 0 });

  const status = worker.status().consumers[0];
  // `dropped` is read through the stream the runtime holds, so the answered
  // stream's non-zero count is what a stream assigned after `stop()` would
  // surface.
  assert.equal(status.dropped, 0, "a stream was assigned to a stopped consumer");
  assert.equal(status.dispatching, 0);
  assert.equal(handled, 0, "a stopped consumer dispatched a row");
  assert.equal(timerCount(), before, "a sweep timer was scheduled after stop()");
});

test("a consumer that subscribed before stop() drains while a pending one is released", async () => {
  const before = timerCount();
  const answer = deferred();
  const handler = deferred();
  const set = await stage({ attendees: () => answer.promise });
  const pending = offeringStream(set.rows.attendees);
  const worker = new WorkerHost(set.replicator, {
    consumers: [
      consumerOf(set, "invitations", () => handler.promise),
      consumerOf(set, "attendees", completing)
    ],
    logger: recordingLogger()
  });

  // The first consumer has its stream; the second is still waiting for one.
  const starting = worker.start();
  await nextTurn();
  const row = set.rows.invitations;
  const running = worker.runtimes[0].attempt(row.rowHash, row);

  const stopping = worker.stop();
  handler.resolve(new Mirrored(row.result));
  await running;
  const report = await stopping;
  answer.resolve(pending);
  await starting;
  await nextTurn();

  assert.deepEqual(report, { drained: 1, abandoned: 0 });
  assert.equal(worker.status().consumers[0].completed, 1);
  assert.equal(pending.stopped, 1);
  assert.equal(worker.runtimes[1].discovering, false);
  assert.equal(timerCount(), before);
});

test("a started worker holds a sweep timer per consumer until stop()", async () => {
  const before = timerCount();
  const set = await stage();
  const worker = createWorker(set.replicator, {
    consumers: [
      consumerOf(set, "invitations", completing),
      consumerOf(set, "attendees", completing)
    ],
    logger: recordingLogger()
  });

  await worker.start();
  assert.equal(timerCount(), before + 2);

  await worker.stop();
  assert.equal(timerCount(), before);
});

test("the given hash is logged once per consumer at startup", async () => {
  const set = await stage();
  const logger = recordingLogger();
  const worker = createWorker(set.replicator, {
    consumers: [
      consumerOf(set, "invitations", completing),
      consumerOf(set, "attendees", completing)
    ],
    logger
  });

  await worker.start();

  const startup = logger.entries.filter(entry => entry.data?.givenHash !== undefined);
  assert.deepEqual(
    startup.map(entry => [entry.level, entry.data.consumer, entry.data.givenHash]),
    [
      ["info", "invitations", set.j.hash(set.tenants.invitations)],
      ["info", "attendees", set.j.hash(set.tenants.attendees)]
    ]
  );
  for (const entry of startup) {
    assert.ok(
      entry.message.includes(entry.data.givenHash),
      "the line does not carry the hash its data reports"
    );
  }

  await worker.stop();
});

test("status() reports each consumer's given hash and its counts, derived", async () => {
  const set = await stage();
  const worker = createWorker(set.replicator, {
    consumers: [
      consumerOf(set, "invitations", completing),
      consumerOf(set, "attendees", completing)
    ],
    logger: recordingLogger()
  });

  const counts = {
    dispatching: 0,
    waiting: 0,
    completed: 0,
    quarantined: 0,
    dropped: 0,
    sweepFailures: 0
  };
  assert.deepEqual(worker.status(), {
    consumers: [
      { name: "invitations", givenHash: set.j.hash(set.tenants.invitations), ...counts },
      { name: "attendees", givenHash: set.j.hash(set.tenants.attendees), ...counts }
    ]
  });

  await worker.stop();
});

test("a consumer resolves the sweep interval and the stream capacity", async () => {
  const set = await stage();
  assert.equal(consumerOf(set, "invitations", completing).sweepIntervalMs, 60_000);
  assert.equal(
    consumerOf(set, "invitations", completing, { sweepIntervalMs: 5 }).sweepIntervalMs,
    5
  );

  const requested = [];
  const j = driving(set.j, {
    subscribeRows: async (specification, ...args) => {
      requested.push(args);
      return openStream();
    }
  });
  const worker = createWorker(j, {
    consumers: [
      consumerOf(set, "invitations", completing),
      consumerOf(set, "attendees", completing, { capacity: 4 })
    ],
    logger: recordingLogger()
  });

  await worker.start();

  assert.deepEqual(requested, [
    [set.tenants.invitations, { capacity: 1024 }],
    [set.tenants.attendees, { capacity: 4 }]
  ]);

  await worker.stop();
});

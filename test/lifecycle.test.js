const test = require("node:test");
const assert = require("node:assert/strict");

const { defineConsumer, createWorker } = require("../dist/index.js");
const { WorkerHost } = require("../dist/worker.js");

// A given is a fact, and the only thing the lifecycle asks of one is its hash.
const tenant = id => ({ type: "Test.Tenant", id });

// The seam the worker uses: a hash per given, and a row stream per consumer.
function fakeJinaga(streams = {}) {
  return {
    hash: fact => `hash-of-${fact.id}`,
    subscribeRows: async specification => {
      const open = streams[specification.name];
      if (open === undefined) {
        return openStream();
      }
      return open();
    }
  };
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

// The specification is opaque to the lifecycle; only its identity matters, and
// the fake Jinaga keys its streams on the name.
const consumerOf = (name, handle, options = {}) => defineConsumer({
  name,
  specification: { name },
  givens: [tenant(name)],
  handle,
  ...options
});

const timerCount = () =>
  process.getActiveResourcesInfo().filter(resource => resource === "Timeout").length;

test("stop() before start() resolves cleanly and reports zeros", async () => {
  const worker = createWorker(fakeJinaga(), {
    consumers: [consumerOf("invitations", async () => {})],
    logger: recordingLogger()
  });

  assert.deepEqual(await worker.stop(), { drained: 0, abandoned: 0 });
});

test("stop() drains a settled handler and counts it in drained", async () => {
  const handler = deferred();
  const worker = new WorkerHost(fakeJinaga(), {
    consumers: [consumerOf("invitations", () => handler.promise)],
    logger: recordingLogger()
  });
  await worker.start();

  const running = worker.runtimes[0].attempt("row-1", { result: {}, rowHash: "row-1" });
  assert.equal(worker.status().consumers[0].dispatching, 1);

  const stopping = worker.stop();
  handler.resolve();
  await running;

  assert.deepEqual(await stopping, { drained: 1, abandoned: 0 });
  assert.equal(worker.status().consumers[0].completed, 1);
});

test("a handler still running at the deadline is abandoned without delaying stop()", async () => {
  const handler = deferred();
  const worker = new WorkerHost(fakeJinaga(), {
    consumers: [consumerOf("invitations", () => handler.promise)],
    shutdownTimeoutMs: 20,
    logger: recordingLogger()
  });
  await worker.start();
  worker.runtimes[0].attempt("row-1", { result: {}, rowHash: "row-1" });

  const startedAt = Date.now();
  const report = await worker.stop();
  const elapsed = Date.now() - startedAt;

  assert.deepEqual(report, { drained: 0, abandoned: 1 });
  assert.ok(elapsed < 1_000, `stop() waited ${elapsed}ms past its 20ms deadline`);
  assert.equal(worker.status().consumers[0].dispatching, 1);

  handler.resolve();
});

test("an attempt is suppressed while the map holds an entry for the row", async () => {
  const handler = deferred();
  let handled = 0;
  const worker = new WorkerHost(fakeJinaga(), {
    consumers: [consumerOf("invitations", () => {
      handled += 1;
      return handler.promise;
    })],
    logger: recordingLogger()
  });
  const runtime = worker.runtimes[0];
  const row = { result: {}, rowHash: "row-1" };

  assert.notEqual(runtime.attempt("row-1", row), undefined);
  assert.equal(runtime.attempt("row-1", row), undefined);
  assert.equal(handled, 1);
  assert.equal(worker.status().consumers[0].dispatching, 1);

  handler.resolve();
  await worker.stop();
});

test("stop() drops waiting rows rather than draining them", async () => {
  const worker = new WorkerHost(fakeJinaga(), {
    consumers: [consumerOf("invitations", async () => {})],
    logger: recordingLogger()
  });
  const rows = worker.runtimes[0].rows;
  rows.set("row-1", {
    phase: "waiting",
    row: { result: {}, rowHash: "row-1" },
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
  const j = fakeJinaga({
    invitations: () => {
      const stream = openStream();
      opened.push(stream);
      return stream;
    },
    attendees: () => {
      throw new Error("distribution denied");
    }
  });
  const worker = createWorker(j, {
    consumers: [
      consumerOf("invitations", async () => {}),
      consumerOf("attendees", async () => {})
    ],
    logger: recordingLogger()
  });

  await assert.rejects(() => worker.start(), /distribution denied/);

  assert.equal(opened.length, 1);
  assert.equal(opened[0].stopped, 1);
  assert.equal(timerCount(), before);
});

test("a started worker holds a sweep timer per consumer until stop()", async () => {
  const before = timerCount();
  const worker = createWorker(fakeJinaga(), {
    consumers: [
      consumerOf("invitations", async () => {}),
      consumerOf("attendees", async () => {})
    ],
    logger: recordingLogger()
  });

  await worker.start();
  assert.equal(timerCount(), before + 2);

  await worker.stop();
  assert.equal(timerCount(), before);
});

test("the given hash is logged once per consumer at startup", async () => {
  const logger = recordingLogger();
  const worker = createWorker(fakeJinaga(), {
    consumers: [
      consumerOf("invitations", async () => {}),
      consumerOf("attendees", async () => {})
    ],
    logger
  });

  await worker.start();

  const startup = logger.entries.filter(entry => entry.data?.givenHash !== undefined);
  assert.deepEqual(
    startup.map(entry => [entry.level, entry.data.consumer, entry.data.givenHash]),
    [
      ["info", "invitations", "hash-of-invitations"],
      ["info", "attendees", "hash-of-attendees"]
    ]
  );
  for (const entry of startup) {
    assert.match(entry.message, new RegExp(entry.data.givenHash));
  }

  await worker.stop();
});

test("status() reports each consumer's given hash and its counts, derived", async () => {
  const worker = createWorker(fakeJinaga(), {
    consumers: [
      consumerOf("invitations", async () => {}),
      consumerOf("attendees", async () => {})
    ],
    logger: recordingLogger()
  });

  assert.deepEqual(worker.status(), {
    consumers: [
      {
        name: "invitations",
        givenHash: "hash-of-invitations",
        dispatching: 0,
        waiting: 0,
        completed: 0,
        quarantined: 0
      },
      {
        name: "attendees",
        givenHash: "hash-of-attendees",
        dispatching: 0,
        waiting: 0,
        completed: 0,
        quarantined: 0
      }
    ]
  });

  await worker.stop();
});

test("a consumer resolves the sweep interval and the stream capacity", async () => {
  assert.equal(consumerOf("invitations", async () => {}).sweepIntervalMs, 60_000);
  assert.equal(
    consumerOf("invitations", async () => {}, { sweepIntervalMs: 5 }).sweepIntervalMs,
    5
  );

  const requested = [];
  const j = {
    hash: fact => `hash-of-${fact.id}`,
    subscribeRows: async (specification, ...args) => {
      requested.push(args);
      return openStream();
    }
  };
  const worker = createWorker(j, {
    consumers: [
      consumerOf("invitations", async () => {}),
      consumerOf("attendees", async () => {}, { capacity: 4 })
    ],
    logger: recordingLogger()
  });

  await worker.start();

  assert.deepEqual(requested, [
    [tenant("invitations"), { capacity: 1024 }],
    [tenant("attendees"), { capacity: 4 }]
  ]);

  await worker.stop();
});

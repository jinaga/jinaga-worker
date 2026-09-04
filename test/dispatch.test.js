const test = require("node:test");
const assert = require("node:assert/strict");

const { buildModel, JinagaTest, Trace } = require("jinaga");
const {
  DEFAULT_HANDLER_TIMEOUT_MS,
  DEFAULT_RETRY_POLICY,
  defineConsumer,
  Limiter
} = require("../dist/index.js");
const { WorkerHost } = require("../dist/worker.js");
const { backoffMs } = require("../dist/retry.js");

// A given is a fact, and dispatch asks nothing of one but its hash.
const tenant = id => ({ type: "Test.Tenant", id });

const row = rowHash => ({ result: { id: rowHash }, rowHash });
const added = rowHash => ({ ...row(rowHash), operation: "added" });
const removed = rowHash => ({ ...row(rowHash), operation: "removed" });

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

/** The seam the worker reads: one stream per consumer, and an empty sweep. */
function fakeJinaga(streams) {
  return {
    hash: fact => `hash-of-${fact.id}`,
    onDistributionDiagnostic: () => {},
    subscribeRows: async specification => streams[specification.name],
    queryRows: async () => []
  };
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
 */
function recordingHandler(respond = async () => {}) {
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
    if (condition()) {
      return;
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(what);
}

/**
 * A worker over one consumer per handler, each with its own stream. The sweep
 * reads nothing, so every row in these tests arrives by the stream.
 */
function workerOver(t, handlers, options = {}) {
  const streams = {};
  const consumers = Object.entries(handlers).map(([name, handle]) => {
    streams[name] = controllableStream();
    return defineConsumer({
      name,
      specification: { name },
      givens: [tenant(name)],
      handle,
      sweepIntervalMs: 60_000,
      ...(options.consumer?.[name] ?? {})
    });
  });
  const worker = new WorkerHost(fakeJinaga(streams), {
    consumers,
    shutdownTimeoutMs: 10,
    logger: silentLogger,
    ...(options.worker ?? {})
  });
  // Unconditional, so an assertion that fails still releases the timers and the
  // run ends in a failure rather than in a hang.
  t.after(() => worker.stop());
  return { worker, streams, rowsOf: name => worker.runtimes[Object.keys(handlers).indexOf(name)].rows };
}

const phaseOf = (rows, rowHash) => rows.get(rowHash)?.phase;

// ---------------------------------------------------------------------------
// Off the notification turn.
// ---------------------------------------------------------------------------

test("does not dispatch from inside the notification", { timeout: DEADLINE_MS }, async t => {
  const handle = recordingHandler();
  const { worker, streams, rowsOf } = workerOver(t, { items: handle });

  await worker.start();
  await streams.items.push(added("r1"));

  assert.deepEqual(handle.handled, [], "the handler ran on the turn that delivered the change");
  assert.equal(phaseOf(rowsOf("items"), "r1"), "dispatching", "the row was admitted");

  await handle.reaching(1);
  assert.deepEqual(handle.handled, ["r1"], "the row was dispatched on a later turn");

  await worker.stop();
});

test("a handler that writes its completion fact does not re-enter notify", { timeout: DEADLINE_MS }, async t => {
  class Tenant {
    constructor(identifier) {
      this.type = Tenant.Type;
      this.identifier = identifier;
    }
  }
  Tenant.Type = "Test.Tenant";

  class Item {
    constructor(tenant, key) {
      this.type = Item.Type;
      this.tenant = tenant;
      this.key = key;
    }
  }
  Item.Type = "Test.Item";

  class ItemHandled {
    constructor(item) {
      this.type = ItemHandled.Type;
      this.item = item;
    }
  }
  ItemHandled.Type = "Test.Item.Handled";

  const model = buildModel(b => b
    .type(Tenant)
    .type(Item, f => f.predecessor("tenant", Tenant))
    .type(ItemHandled, f => f.predecessor("item", Item)));

  const outstanding = model.given(Tenant).match((owner, facts) =>
    facts.ofType(Item)
      .join(item => item.tenant, owner)
      .notExists(item => facts.ofType(ItemHandled).join(done => done.item, item)));

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

  const acme = new Tenant("acme");
  const j = JinagaTest.create({ model, initialState: [acme] });
  const handle = recordingHandler(rowValue => j.fact(new ItemHandled(rowValue.result)));
  const worker = new WorkerHost(j, {
    consumers: [defineConsumer({ name: "items", specification: outstanding, givens: [acme], handle })],
    logger: silentLogger
  });
  t.after(() => worker.stop());

  await worker.start();
  await j.fact(new Item(acme, "one"));
  await handle.reaching(1);
  await quiesce();

  assert.deepEqual(
    counters.filter(name => name === "observable_notify_reentrant"),
    [],
    "the handler wrote its completion fact from inside its own notification"
  );
  await worker.stop();
});

// ---------------------------------------------------------------------------
// Retry, as a policy value the loop reads.
// ---------------------------------------------------------------------------

test("re-attempts a rejected row on backoff and stops at retry.maxAttempts", { timeout: DEADLINE_MS }, async t => {
  const handle = recordingHandler(async () => {
    throw new Error("nope");
  });
  const { worker, streams, rowsOf } = workerOver(t, { items: handle }, {
    consumer: { items: { retry: { maxAttempts: 3, baseMs: 0, capMs: 0 } } }
  });

  await worker.start();
  await streams.items.push(added("r1"));
  await handle.reaching(3);
  await quiesce();

  assert.deepEqual(handle.handled, ["r1", "r1", "r1"], "the row was attempted its three times");
  assert.equal(phaseOf(rowsOf("items"), "r1"), "quarantined");
  assert.equal(worker.status().consumers[0].quarantined, 1);
  assert.equal(worker.status().consumers[0].completed, 0);

  await worker.stop();
});

test("releases the limiter slot while waiting to retry", { timeout: DEADLINE_MS }, async t => {
  const limiter = new Limiter(1);
  const blocked = deferred();
  const handle = recordingHandler(async rowValue => {
    if (rowValue.rowHash === "r1") {
      throw new Error("nope");
    }
    await blocked.promise;
  });
  const { worker, streams, rowsOf } = workerOver(t, { items: handle }, {
    worker: { limiter },
    // Long enough that the retry cannot be what lets the second row through.
    consumer: { items: { retry: { maxAttempts: 5, baseMs: 60_000, capMs: 60_000 } } }
  });

  await worker.start();
  await streams.items.push(added("r1"));
  await until(() => phaseOf(rowsOf("items"), "r1") === "waiting", "the rejected row never waited");

  assert.equal(limiter.inFlight, 0, "the slot was held across the backoff wait");

  // A consumer at its limit still makes progress on other rows.
  await streams.items.push(added("r2"));
  await handle.reaching(2);

  assert.deepEqual(handle.handled, ["r1", "r2"]);
  assert.equal(limiter.inFlight, 1);
  assert.equal(phaseOf(rowsOf("items"), "r1"), "waiting");

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
  const wedged = deferred();
  let settled = false;
  const handle = recordingHandler(async () => {
    await wedged.promise;
    settled = true;
  });
  const { worker, streams, rowsOf } = workerOver(t, { items: handle }, {
    consumer: {
      items: { handlerTimeoutMs: 1, retry: { maxAttempts: 1, baseMs: 0, capMs: 0 } }
    }
  });

  await worker.start();
  await streams.items.push(added("r1"));
  await until(
    () => phaseOf(rowsOf("items"), "r1") === "quarantined",
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
  const blocked = deferred();
  const respond = () => blocked.promise;
  const invitations = recordingHandler(respond);
  const attendees = recordingHandler(respond);
  const limiter = new Limiter(2);
  const { worker, streams } = workerOver(t, { invitations, attendees }, {
    worker: { limiter, shutdownTimeoutMs: 1 }
  });

  await worker.start();
  for (const name of ["invitations", "attendees"]) {
    await streams[name].push(added(`${name}-1`));
    await streams[name].push(added(`${name}-2`));
  }
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
  const blocked = deferred();
  const respond = () => blocked.promise;
  const invitations = recordingHandler(respond);
  const attendees = recordingHandler(respond);
  const shared = new Limiter(4);
  const own = new Limiter(1);
  const { worker, streams } = workerOver(t, { invitations, attendees }, {
    worker: { limiter: shared, shutdownTimeoutMs: 1 },
    consumer: { invitations: { limiter: own } }
  });

  await worker.start();
  for (const name of ["invitations", "attendees"]) {
    await streams[name].push(added(`${name}-1`));
    await streams[name].push(added(`${name}-2`));
  }
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
    specification: { name: "items" },
    givens: [tenant("items")],
    handle: async () => {}
  });

  assert.deepEqual(consumer.retry, DEFAULT_RETRY_POLICY);
  assert.equal(consumer.handlerTimeoutMs, DEFAULT_HANDLER_TIMEOUT_MS);
  assert.equal(DEFAULT_HANDLER_TIMEOUT_MS, 30_000);
  assert.equal(consumer.limiter, undefined, "a consumer holds a budget only when it declares one");
});

// ---------------------------------------------------------------------------
// A row that has already left the set.
// ---------------------------------------------------------------------------

test("dispatching a row that has already left the set is harmless", { timeout: DEADLINE_MS }, async t => {
  const attempts = [deferred(), deferred()];
  const handle = recordingHandler((rowValue, call) => attempts[call - 1].promise);
  const { worker, streams, rowsOf } = workerOver(t, { items: handle });

  await worker.start();
  await streams.items.push(added("r1"));
  await handle.reaching(1);

  // The row leaves the set while its handler is still running, and a stale
  // addition behind the removal finds no entry and is admitted again.
  await streams.items.push(removed("r1"));
  assert.equal(rowsOf("items").size, 0);
  await streams.items.push(added("r1"));
  await handle.reaching(2);

  assert.deepEqual(handle.handled, ["r1", "r1"], "the second attempt did not run the handler");

  // The first attempt is no longer the one the map is about, so its outcome
  // leaves the row to the attempt that replaced it.
  attempts[0].resolve();
  await quiesce();
  assert.equal(phaseOf(rowsOf("items"), "r1"), "dispatching", "a superseded attempt moved the row");
  assert.equal(worker.status().consumers[0].completed, 0);

  attempts[1].resolve();
  await quiesce();

  assert.equal(rowsOf("items").size, 1, "the two attempts left more than one entry");
  assert.equal(phaseOf(rowsOf("items"), "r1"), "completed");
  assert.deepEqual(
    worker.status().consumers[0],
    {
      name: "items",
      givenHash: "hash-of-items",
      dispatching: 0,
      waiting: 0,
      completed: 1,
      quarantined: 0,
      dropped: 0
    },
    "the counts disagree with the map"
  );

  await worker.stop();
});

test("a superseded attempt neither retries nor drains in place of the one that replaced it", { timeout: DEADLINE_MS }, async t => {
  const attempts = [deferred(), deferred()];
  const handle = recordingHandler((rowValue, call) => attempts[call - 1].promise);
  const { worker, streams, rowsOf } = workerOver(t, { items: handle }, {
    worker: { shutdownTimeoutMs: 5_000 },
    // Long enough that a retry scheduled here would be visible as `waiting`.
    consumer: { items: { retry: { maxAttempts: 5, baseMs: 60_000, capMs: 60_000 } } }
  });

  await worker.start();
  await streams.items.push(added("r1"));
  await handle.reaching(1);
  await streams.items.push(removed("r1"));
  await streams.items.push(added("r1"));
  await handle.reaching(2);

  attempts[0].reject(new Error("nope"));
  await quiesce();

  assert.equal(
    phaseOf(rowsOf("items"), "r1"),
    "dispatching",
    "the superseded rejection paced a row whose handler is still running"
  );
  assert.equal(worker.status().consumers[0].waiting, 0);

  // The drain awaits the attempt that is running, not the one it replaced.
  const stopping = worker.stop();
  attempts[1].resolve();

  assert.deepEqual(await stopping, { drained: 1, abandoned: 0 });
});

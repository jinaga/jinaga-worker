const test = require("node:test");
const assert = require("node:assert/strict");

const { buildModel, JinagaTest } = require("jinaga");
const { defineConsumer, createWorker } = require("../dist/index.js");
const { WorkerHost } = require("../dist/worker.js");

// A given is a fact, and discovery asks nothing of one but its hash.
const tenant = id => ({ type: "Test.Tenant", id });

const row = rowHash => ({ result: { id: rowHash }, rowHash });

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

// Every wait here is for an event, not for a delay. This is only the deadline
// at which an event that is never coming is reported as a failure, so a broken
// discovery path fails the run instead of hanging it.
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
    subscribeRows: async () => stream,
    queryRows: query.read
  };
}

function deferred() {
  let settle;
  const promise = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  return { promise, ...settle };
}

/** A handler that records the rows it saw, and lets a test await the nth call. */
function recordingHandler(respond = async () => {}) {
  const handled = [];
  const waiters = [];
  const handle = async rowValue => {
    handled.push(rowValue);
    for (const waiter of waiters.splice(0)) {
      waiter();
    }
    await respond(rowValue);
  };
  handle.handled = handled;
  handle.reaching = count => new Promise(resolve => {
    const check = () => {
      if (handled.length >= count) {
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

/**
 * Wait for the next sweep to finish. `lastSweep` is written at the end of a
 * sweep, so a change in it is the sweep's own completion rather than a delay
 * chosen by the test.
 *
 * The comparison is by value, so what it waits for is a sweep that reported
 * something different rather than a `status()` that returned a different
 * object.
 */
const sweepMark = sweep =>
  sweep === undefined ? "none" : `${sweep.at.getTime()}:${sweep.size}`;

async function nextSweep(worker, index = 0) {
  const lastSweep = () => worker.status().consumers[index].lastSweep;
  const before = sweepMark(lastSweep());
  for (let turn = 0; turn < 10_000; turn += 1) {
    if (sweepMark(lastSweep()) !== before) {
      return lastSweep();
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail("no sweep completed");
}

/** Let every pending turn run, so a change that will not arrive has not. */
async function quiesce() {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

/** Wait for a state the consumer reaches on its own turns. */
async function until(condition, what) {
  for (let turn = 0; turn < 10_000; turn += 1) {
    if (condition()) {
      return;
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(what);
}

function workerOver(t, stream, query, handle, options = {}) {
  const worker = new WorkerHost(fakeJinaga(stream, query), {
    consumers: [
      defineConsumer({
        name: "invitations",
        specification: { name: "invitations" },
        givens: [tenant("invitations")],
        handle,
        sweepIntervalMs: 1,
        ...options
      })
    ],
    shutdownTimeoutMs: 10,
    logger: silentLogger
  });
  // Unconditional, so an assertion that fails still releases the sweep timer
  // and the run ends in a failure rather than in a hang.
  t.after(() => worker.stop());
  return worker;
}

const added = rowHash => ({ ...row(rowHash), operation: "added" });
const removed = rowHash => ({ ...row(rowHash), operation: "removed" });

// ---------------------------------------------------------------------------
// The stream path, against the real seam.
// ---------------------------------------------------------------------------

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

// The outstanding set: items this consumer has not yet handled.
const outstanding = model.given(Tenant).match((tenant, facts) =>
  facts.ofType(Item)
    .join(item => item.tenant, tenant)
    .notExists(item => facts.ofType(ItemHandled).join(handled => handled.item, item)));

test("delivers the backlog and later arrivals exactly once", { timeout: DEADLINE_MS }, async t => {
  const acme = new Tenant("acme");
  const j = JinagaTest.create({ model, initialState: [acme] });
  const backlog = await j.fact(new Item(acme, "backlog"));

  // A consumer's handler writes the completion fact, which is what takes the
  // row out of the outstanding set.
  const handle = recordingHandler(rowValue => j.fact(new ItemHandled(rowValue.result)));
  const worker = createWorker(j, {
    consumers: [
      defineConsumer({
        name: "items",
        specification: outstanding,
        givens: [acme],
        handle
      })
    ],
    logger: silentLogger
  });
  t.after(() => worker.stop());

  await worker.start();
  await handle.reaching(1);

  const later = await j.fact(new Item(acme, "later"));
  await handle.reaching(2);
  await quiesce();

  assert.deepEqual(handle.handled.map(r => r.result.key), ["backlog", "later"]);
  assert.equal(
    new Set(handle.handled.map(r => r.rowHash)).size,
    2,
    "the two rows are distinct, and neither was delivered twice"
  );
  assert.deepEqual(await j.queryRows(outstanding, acme), []);

  // Both facts are the application's; the library wrote neither.
  const completions = model.given(Tenant).match((owner, facts) =>
    facts.ofType(ItemHandled).join(handled => handled.item.tenant, owner));
  assert.equal((await j.query(completions, acme)).length, 2);

  await worker.stop();
  void backlog;
  void later;
});

test("the backstop sweep reads the outstanding set through queryRows", { timeout: DEADLINE_MS }, async t => {
  const acme = new Tenant("acme");
  const j = JinagaTest.create({ model, initialState: [acme] });
  await j.fact(new Item(acme, "outstanding"));

  // This handler writes no completion fact, so the row stays outstanding and
  // every sweep still returns it.
  const handle = recordingHandler();
  const worker = new WorkerHost(j, {
    consumers: [
      defineConsumer({
        name: "items",
        specification: outstanding,
        givens: [acme],
        handle,
        sweepIntervalMs: 1
      })
    ],
    shutdownTimeoutMs: 10,
    logger: silentLogger
  });
  t.after(() => worker.stop());

  await worker.start();
  const sweep = await nextSweep(worker);

  assert.equal(sweep.size, 1, "the sweep read the one outstanding row");
  await worker.stop();
});

// ---------------------------------------------------------------------------
// The gate, driven change by change.
// ---------------------------------------------------------------------------

test("a row offered by both paths in the same window is admitted once", { timeout: DEADLINE_MS }, async t => {
  const stream = controllableStream();
  const query = controllableQuery([row("r1")]);
  const handler = deferred();
  const handle = recordingHandler(() => handler.promise);
  const worker = workerOver(t, stream, query, handle);

  await worker.start();
  await stream.push(added("r1"));
  await handle.reaching(1);

  // The sweep offers the same row while the stream's attempt is still running.
  await nextSweep(worker);
  await quiesce();

  assert.equal(handle.handled.length, 1, "the sweep did not admit an admitted row");
  assert.equal(worker.status().consumers[0].dispatching, 1);
  assert.equal(worker.runtimes[0].rows.size, 1);

  handler.resolve();
  await worker.stop();
});

test("a removed change releases the row from the map", { timeout: DEADLINE_MS }, async t => {
  const stream = controllableStream();
  const query = controllableQuery([row("r1")]);
  const handler = deferred();
  const worker = workerOver(t, stream, query, recordingHandler(() => handler.promise), {
    sweepIntervalMs: 60_000
  });

  await worker.start();
  await stream.push(added("r1"));
  assert.equal(worker.runtimes[0].rows.size, 1);

  await stream.push(removed("r1"));

  assert.equal(worker.runtimes[0].rows.size, 0);
  assert.equal(worker.status().consumers[0].dispatching, 0);

  handler.resolve();
  await worker.stop();
});

test("a sweep that omits a row releases it", { timeout: DEADLINE_MS }, async t => {
  const stream = controllableStream();
  const query = controllableQuery([row("r1")]);
  const worker = workerOver(t, stream, query, recordingHandler());

  await worker.start();
  await stream.push(added("r1"));

  // The handler resolved, so nothing removed the row from the map. Only a
  // sweep that no longer returns it does that.
  await until(
    () => worker.status().consumers[0].completed === 1,
    "the handled row was never completed"
  );

  query.returns([]);
  await nextSweep(worker);

  assert.equal(worker.runtimes[0].rows.size, 0);
  assert.deepEqual(
    { completed: worker.status().consumers[0].completed, size: worker.status().consumers[0].lastSweep.size },
    { completed: 0, size: 0 }
  );

  await worker.stop();
});

test("lastSweep reflects the most recent sweep and is absent before the first", { timeout: DEADLINE_MS }, async t => {
  const stream = controllableStream();
  const query = controllableQuery([row("r1"), row("r2")]);
  const handler = deferred();
  const worker = workerOver(t, stream, query, recordingHandler(() => handler.promise));

  assert.equal(worker.status().consumers[0].lastSweep, undefined);
  await worker.start();
  assert.equal(worker.status().consumers[0].lastSweep, undefined);

  const first = await nextSweep(worker);
  assert.equal(first.size, 2);
  assert.ok(first.at instanceof Date);

  query.returns([row("r1")]);
  const second = await nextSweep(worker);
  assert.equal(second.size, 1);
  assert.ok(second.at.getTime() >= first.at.getTime());

  handler.resolve();
  await worker.stop();
});

test("the sweep timer stops on stop()", { timeout: DEADLINE_MS }, async t => {
  const stream = controllableStream();
  const query = controllableQuery([]);
  const worker = workerOver(t, stream, query, recordingHandler());

  await worker.start();
  await nextSweep(worker);
  await worker.stop();

  const afterStop = query.calls;
  await quiesce();

  assert.equal(query.calls, afterStop, "a sweep ran after stop()");
  assert.equal(stream.stopped, 1);
});

test("a sweep in flight when stop() lands admits nothing", { timeout: DEADLINE_MS }, async t => {
  const stream = controllableStream();
  const reading = deferred();
  const query = controllableQuery([row("r1")]);
  query.read = async () => {
    query.calls += 1;
    await reading.promise;
    return query.rows;
  };
  const handle = recordingHandler();
  const worker = workerOver(t, stream, query, handle);

  await worker.start();
  while (query.calls === 0) {
    await new Promise(resolve => setImmediate(resolve));
  }

  await worker.stop();
  reading.resolve();
  await quiesce();

  assert.deepEqual(handle.handled, []);
  assert.equal(worker.runtimes[0].rows.size, 0);
  assert.equal(worker.status().consumers[0].lastSweep, undefined);
});

test("an added and a removed for the same row leave the map in the state the table prescribes", { timeout: DEADLINE_MS }, async t => {
  for (const order of [["added", "removed"], ["removed", "added"]]) {
    const stream = controllableStream();
    const query = controllableQuery([]);
    const handler = deferred();
    const handle = recordingHandler(() => handler.promise);
    const worker = workerOver(t, stream, query, handle, { sweepIntervalMs: 60_000 });

    await worker.start();
    for (const operation of order) {
      await stream.push(operation === "added" ? added("r1") : removed("r1"));
    }

    const rows = worker.runtimes[0].rows;
    if (order[1] === "removed") {
      // Applied last: a removed clears the entry from any phase.
      assert.equal(rows.size, 0, `${order.join(" then ")} left an entry behind`);
    }
    else {
      // Applied last: the added finds no entry, so it is admitted.
      assert.equal(rows.get("r1").phase, "dispatching", `${order.join(" then ")}`);
    }
    // The admission stands whichever order it arrived in, so the row is
    // dispatched on its own turn either way.
    await handle.reaching(1);
    await quiesce();
    assert.equal(handle.handled.length, 1);

    handler.resolve();
    await worker.stop();
  }
});

test("a handler that throws where it could reject leaves discovery running", { timeout: DEADLINE_MS }, async t => {
  const rejections = [];
  const onRejection = error => rejections.push(error);
  process.on("unhandledRejection", onRejection);

  const stream = controllableStream();
  const query = controllableQuery([]);
  const thrown = [];
  // Not an async function: it throws on its dispatching turn rather than
  // returning a rejected promise.
  const handle = rowValue => {
    thrown.push(rowValue.rowHash);
    throw new Error("handler threw");
  };
  // One attempt per row, so what `thrown` records is what discovery offered.
  const worker = workerOver(t, stream, query, handle, {
    retry: { maxAttempts: 1, baseMs: 0, capMs: 0 }
  });

  const reaching = count => new Promise(resolve => {
    const check = () => thrown.length >= count ? resolve() : setImmediate(check);
    check();
  });

  await worker.start();
  await stream.push(added("r1"));

  // The stream's loop survived it, so a later change is still discovered.
  await stream.push(added("r2"));
  await reaching(2);
  assert.deepEqual(thrown, ["r1", "r2"]);

  // And so does the sweep, whose offers run the same handler.
  query.returns([row("r3")]);
  await nextSweep(worker);
  await reaching(3);
  assert.ok(thrown.includes("r3"));

  await worker.stop();
  await quiesce();
  process.off("unhandledRejection", onRejection);
  assert.deepEqual(rejections, [], "a thrown handler reached the process as an unhandled rejection");
});

test("status reads the stream's dropped count through, and keeps reading it after stop()", { timeout: DEADLINE_MS }, async t => {
  const stream = controllableStream();
  const query = controllableQuery([]);
  const worker = workerOver(t, stream, query, recordingHandler(), { sweepIntervalMs: 60_000 });

  await worker.start();
  assert.equal(worker.status().consumers[0].dropped, 0);

  stream.dropped = 3;
  assert.equal(worker.status().consumers[0].dropped, 3, "dropped is read through, not copied");

  await worker.stop();
  assert.equal(worker.status().consumers[0].dropped, 3);
});

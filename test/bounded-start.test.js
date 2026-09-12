const test = require("node:test");
const assert = require("node:assert/strict");

const { FeedTimeoutError } = require("jinaga");
const { defineConsumer, createWorker, TimeoutError } = require("../dist/index.js");
const { Mirrored, Tenant, driving, outstanding, world } = require("./outstanding-model.js");

const completing = async row => new Mirrored(row.result);

const consumerOf = (stage, name, options = {}) => defineConsumer({
  name,
  specification: outstanding,
  givens: [stage.tenants[name]],
  completes: Mirrored,
  handle: completing,
  ...options
});

const nextTurn = () => new Promise(resolve => setTimeout(resolve, 0));

const timerCount = () =>
  process.getActiveResourcesInfo().filter(resource => resource === "Timeout").length;

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
 * A real instance, a tenant per consumer, and the replicator as `subscribeRows`
 * sees it.
 *
 * `answer` is what the replicator does for one consumer, keyed by its given.
 * A consumer with no entry is answered at once. The bound is honoured the way
 * jinaga honours it: a `feedTimeoutMs` that expires before the answer arrives
 * releases the subscription and rejects with `FeedTimeoutError`, so a bound
 * that reaches jinaga is visible here as a rejection rather than as a value
 * the test reads back. Everything the worker does with facts, its given hashes
 * among them, is the instance's own.
 */
async function stage(answer = {}) {
  const { j } = await world();
  const tenants = {};
  for (const name of ["invitations", "attendees"]) {
    tenants[name] = await j.fact(new Tenant(name));
  }
  const subscribes = [];
  const replicator = driving(j, {
    subscribeRows: async (specification, given, options) => {
      subscribes.push({ given: given.identifier, options });
      const answering = (answer[given.identifier] ?? (async () => openStream()))();
      if (options.feedTimeoutMs === undefined) {
        return answering;
      }
      assert.ok(
        options.feedTimeoutMs > 0 && Number.isFinite(options.feedTimeoutMs),
        `jinaga refuses a non-positive bound; got ${options.feedTimeoutMs}`
      );
      let deadline;
      const expired = new Promise((_, reject) => {
        deadline = setTimeout(
          () => reject(new FeedTimeoutError(
            `Timed out after ${options.feedTimeoutMs} ms waiting for the feed.`,
            options.feedTimeoutMs
          )),
          options.feedTimeoutMs
        );
      });
      return Promise.race([answering, expired]).finally(() => clearTimeout(deadline));
    }
  });
  return { j, tenants, subscribes, replicator };
}

/** A replicator that accepts the connection and never answers. */
const silent = () => new Promise(() => {});

/**
 * Spend wall clock up to `ms` without sleeping on a guess: the loop yields
 * until the clock itself has moved past the mark.
 */
async function spend(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await nextTurn();
  }
}

test("a bound and a replicator that never answers rejects with FeedTimeoutError", async () => {
  const set = await stage({ invitations: silent });
  const worker = createWorker(set.replicator, {
    consumers: [consumerOf(set, "invitations")],
    startTimeoutMs: 20
  });

  await assert.rejects(() => worker.start(), error => {
    assert.ok(
      error instanceof FeedTimeoutError,
      `expected jinaga's FeedTimeoutError, got ${error.name}`
    );
    assert.ok(
      !(error instanceof TimeoutError),
      "TimeoutError means a handler that outran handlerTimeoutMs"
    );
    return true;
  });
});

test("a consumer that started before the bound expired is released", async () => {
  const before = timerCount();
  const opened = [];
  const set = await stage({
    invitations: async () => {
      const stream = openStream();
      opened.push(stream);
      return stream;
    },
    attendees: silent
  });
  const worker = createWorker(set.replicator, {
    consumers: [consumerOf(set, "invitations"), consumerOf(set, "attendees")],
    startTimeoutMs: 20
  });

  await assert.rejects(() => worker.start(), FeedTimeoutError);

  assert.equal(opened.length, 1);
  assert.equal(opened[0].stopped, 1, "the stream of the consumer that started is stopped");
  assert.equal(timerCount(), before, "its sweep timer is cleared");
});

test("after the bound expires nothing dispatches and no timer is held", async () => {
  const before = timerCount();
  const handled = [];
  const set = await stage({ invitations: silent });
  const worker = createWorker(set.replicator, {
    consumers: [consumerOf(set, "invitations", {
      handle: async row => {
        handled.push(row.rowHash);
        return new Mirrored(row.result);
      }
    })],
    startTimeoutMs: 20
  });

  await assert.rejects(() => worker.start(), FeedTimeoutError);
  await nextTurn();

  assert.deepEqual(handled, []);
  assert.equal(timerCount(), before);
});

test("the bound is a total across consumers, not a fresh one for each", async () => {
  const set = await stage({
    // The first consumer takes part of the budget before it answers, so what
    // the second is given has to be smaller than what the first was given.
    invitations: async () => {
      await spend(5);
      return openStream();
    }
  });
  const worker = createWorker(set.replicator, {
    consumers: [consumerOf(set, "invitations"), consumerOf(set, "attendees")],
    startTimeoutMs: 1_000
  });

  await worker.start();

  const [first, second] = set.subscribes.map(subscribe => subscribe.options.feedTimeoutMs);
  assert.ok(first <= 1_000, `the first bound is the budget, got ${first}`);
  assert.ok(second < first, `the second got ${second}, which is not less than ${first}`);
  assert.ok(second > 0);

  await worker.stop();
});

test("a budget spent before the last consumer subscribes rejects rather than reaching jinaga", async () => {
  const set = await stage({
    invitations: async () => {
      await spend(30);
      return openStream();
    }
  });
  const worker = createWorker(set.replicator, {
    consumers: [consumerOf(set, "invitations"), consumerOf(set, "attendees")],
    startTimeoutMs: 20
  });

  await assert.rejects(() => worker.start(), FeedTimeoutError);

  assert.deepEqual(
    set.subscribes.map(subscribe => subscribe.given),
    ["invitations"],
    "the second consumer never reaches jinaga with a non-positive bound"
  );
});

test("with no bound set, no feedTimeoutMs is passed and start() stays unsettled", async () => {
  const set = await stage({ invitations: silent });
  const worker = createWorker(set.replicator, { consumers: [consumerOf(set, "invitations")] });

  let settled = false;
  const starting = worker.start();
  starting.then(() => { settled = true; }, () => { settled = true; });

  await nextTurn();
  await nextTurn();
  await nextTurn();

  assert.equal(settled, false, "an unbounded subscribe leaves start() pending");
  assert.deepEqual(set.subscribes.map(subscribe => subscribe.options), [{ capacity: 1024 }]);
});

test("a structural denial rejects with the denial, bound or not", async () => {
  for (const startTimeoutMs of [undefined, 1_000]) {
    const set = await stage({
      invitations: async () => {
        throw new Error("distribution denied");
      }
    });
    const worker = createWorker(set.replicator, {
      consumers: [consumerOf(set, "invitations")],
      ...(startTimeoutMs === undefined ? {} : { startTimeoutMs })
    });

    await assert.rejects(() => worker.start(), error => {
      assert.match(error.message, /distribution denied/);
      assert.ok(!(error instanceof FeedTimeoutError));
      return true;
    });
  }
});

test("a bound that is not a length of time is refused where the worker is built", async () => {
  const set = await stage();
  for (const startTimeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    assert.throws(
      () => createWorker(set.replicator, {
        consumers: [consumerOf(set, "invitations")],
        startTimeoutMs
      }),
      error => {
        assert.match(error.message, /startTimeoutMs/);
        // Refused before anything is built, so it never reaches the deadline
        // and is never mistaken for a budget that ran out.
        assert.ok(!(error instanceof FeedTimeoutError));
        return true;
      },
      `startTimeoutMs ${startTimeoutMs} was accepted`
    );
  }
});

test("start() after an aborted start does not subscribe again", async () => {
  const set = await stage({ invitations: silent });
  const worker = createWorker(set.replicator, {
    consumers: [consumerOf(set, "invitations")],
    startTimeoutMs: 20
  });

  await assert.rejects(() => worker.start(), FeedTimeoutError);
  assert.equal(set.subscribes.length, 1);

  await assert.rejects(() => worker.start(), FeedTimeoutError);
  assert.equal(set.subscribes.length, 1, "the worker is spent; a retry builds a new one");
});

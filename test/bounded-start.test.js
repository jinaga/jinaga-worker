const test = require("node:test");
const assert = require("node:assert/strict");

const { FeedTimeoutError } = require("jinaga");
const { defineConsumer, createWorker, TimeoutError } = require("../dist/index.js");
const { retiringOn } = require("./outstanding-specification.js");

const tenant = id => ({ type: "Test.Tenant", id });

class Mirrored {
  constructor(rowHash) {
    this.type = Mirrored.Type;
    this.rowHash = rowHash;
  }
}
Mirrored.Type = "Test.Item.Mirrored";

const completing = async row => new Mirrored(row.rowHash);

const consumerOf = (name, options = {}) => defineConsumer({
  name,
  specification: retiringOn(Mirrored.Type),
  givens: [tenant(name)],
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
 * The replicator, as `subscribeRows` sees it.
 *
 * `answer` is what the replicator does for one consumer, keyed by its given.
 * A consumer with no entry is answered at once. The bound is honoured the way
 * jinaga honours it: a `feedTimeoutMs` that expires before the answer arrives
 * releases the subscription and rejects with `FeedTimeoutError`, so a bound
 * that reaches jinaga is visible here as a rejection rather than as a value
 * the test reads back.
 */
function replicator(answer = {}) {
  const subscribes = [];
  const j = {
    subscribes,
    hash: fact => `hash-of-${fact.id}`,
    onDistributionDiagnostic: () => {},
    subscribeRows: async (specification, given, options) => {
      subscribes.push({ given: given.id, options });
      const answering = (answer[given.id] ?? (async () => openStream()))();
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
    },
    fact: async prototype => prototype
  };
  return j;
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
  const worker = createWorker(replicator({ invitations: silent }), {
    consumers: [consumerOf("invitations")],
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
  const j = replicator({
    invitations: async () => {
      const stream = openStream();
      opened.push(stream);
      return stream;
    },
    attendees: silent
  });
  const worker = createWorker(j, {
    consumers: [consumerOf("invitations"), consumerOf("attendees")],
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
  const j = replicator({ invitations: silent });
  const worker = createWorker(j, {
    consumers: [consumerOf("invitations", {
      handle: async row => {
        handled.push(row.rowHash);
        return new Mirrored(row.rowHash);
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
  const j = replicator({
    // The first consumer takes part of the budget before it answers, so what
    // the second is given has to be smaller than what the first was given.
    invitations: async () => {
      await spend(5);
      return openStream();
    }
  });
  const worker = createWorker(j, {
    consumers: [consumerOf("invitations"), consumerOf("attendees")],
    startTimeoutMs: 1_000
  });

  await worker.start();

  const [first, second] = j.subscribes.map(subscribe => subscribe.options.feedTimeoutMs);
  assert.ok(first <= 1_000, `the first bound is the budget, got ${first}`);
  assert.ok(second < first, `the second got ${second}, which is not less than ${first}`);
  assert.ok(second > 0);

  await worker.stop();
});

test("a budget spent before the last consumer subscribes rejects rather than reaching jinaga", async () => {
  const j = replicator({
    invitations: async () => {
      await spend(30);
      return openStream();
    }
  });
  const worker = createWorker(j, {
    consumers: [consumerOf("invitations"), consumerOf("attendees")],
    startTimeoutMs: 20
  });

  await assert.rejects(() => worker.start(), FeedTimeoutError);

  assert.deepEqual(
    j.subscribes.map(subscribe => subscribe.given),
    ["invitations"],
    "the second consumer never reaches jinaga with a non-positive bound"
  );
});

test("with no bound set, no feedTimeoutMs is passed and start() stays unsettled", async () => {
  const j = replicator({ invitations: silent });
  const worker = createWorker(j, { consumers: [consumerOf("invitations")] });

  let settled = false;
  const starting = worker.start();
  starting.then(() => { settled = true; }, () => { settled = true; });

  await nextTurn();
  await nextTurn();
  await nextTurn();

  assert.equal(settled, false, "an unbounded subscribe leaves start() pending");
  assert.deepEqual(j.subscribes.map(subscribe => subscribe.options), [{ capacity: 1024 }]);
});

test("a structural denial rejects with the denial, bound or not", async () => {
  for (const startTimeoutMs of [undefined, 1_000]) {
    const j = replicator({
      invitations: async () => {
        throw new Error("distribution denied");
      }
    });
    const worker = createWorker(j, {
      consumers: [consumerOf("invitations")],
      ...(startTimeoutMs === undefined ? {} : { startTimeoutMs })
    });

    await assert.rejects(() => worker.start(), error => {
      assert.match(error.message, /distribution denied/);
      assert.ok(!(error instanceof FeedTimeoutError));
      return true;
    });
  }
});

test("start() after an aborted start does not subscribe again", async () => {
  const j = replicator({ invitations: silent });
  const worker = createWorker(j, {
    consumers: [consumerOf("invitations")],
    startTimeoutMs: 20
  });

  await assert.rejects(() => worker.start(), FeedTimeoutError);
  assert.equal(j.subscribes.length, 1);

  await assert.rejects(() => worker.start(), FeedTimeoutError);
  assert.equal(j.subscribes.length, 1, "the worker is spent; a retry builds a new one");
});

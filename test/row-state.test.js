const test = require("node:test");
const assert = require("node:assert/strict");

const {
  transition,
  applyRowEvent,
  isAdmissible,
  countRows
} = require("../dist/index.js");

const MAX = 5;

function row(rowHash) {
  return { result: { id: rowHash }, rowHash };
}

const dispatching = (attempts, firstAttemptAt = 100) => ({
  phase: "dispatching",
  row: row("r"),
  attempts,
  firstAttemptAt
});

const waiting = (attempts, retryAt, firstAttemptAt = 100) => ({
  phase: "waiting",
  row: row("r"),
  attempts,
  firstAttemptAt,
  retryAt
});

const completed = (attempts, firstAttemptAt = 100) => ({
  phase: "completed",
  row: row("r"),
  attempts,
  firstAttemptAt
});

const quarantined = () => ({ phase: "quarantined", row: row("r") });

// Every row of the transition table in the specification's section 3.3, as a
// table over the pure function. `from: undefined` is the table's *absent*.
const table = [
  {
    name: "absent, added from the stream, dispatching",
    from: undefined,
    event: { kind: "added", row: row("r"), at: 100 },
    to: { phase: "dispatching", row: row("r"), attempts: 1, firstAttemptAt: 100 }
  },
  {
    name: "absent, offered by the sweep, dispatching",
    from: undefined,
    event: { kind: "swept", row: row("r"), at: 100, maxAttempts: MAX },
    to: { phase: "dispatching", row: row("r"), attempts: 1, firstAttemptAt: 100 }
  },
  {
    name: "dispatching, handler resolves, completed",
    from: dispatching(2),
    event: { kind: "resolved" },
    to: { phase: "completed", row: row("r"), attempts: 2, firstAttemptAt: 100 }
  },
  {
    name: "dispatching, handler rejects below the attempt limit, waiting",
    from: dispatching(2),
    event: { kind: "rejected", retryAt: 900, maxAttempts: MAX },
    to: {
      phase: "waiting",
      row: row("r"),
      attempts: 2,
      firstAttemptAt: 100,
      retryAt: 900
    }
  },
  {
    name: "dispatching, handler rejects at the attempt limit, quarantined",
    from: dispatching(MAX),
    event: { kind: "rejected", retryAt: 900, maxAttempts: MAX },
    to: { phase: "quarantined", row: row("r") }
  },
  {
    name: "waiting, retry time reached, dispatching",
    from: waiting(2, 900),
    event: { kind: "retryDue" },
    to: { phase: "dispatching", row: row("r"), attempts: 3, firstAttemptAt: 100 }
  },
  {
    name: "completed, a sweep still returns the row below the attempt limit, dispatching",
    from: completed(2),
    event: { kind: "swept", row: row("r"), at: 500, maxAttempts: MAX },
    to: { phase: "dispatching", row: row("r"), attempts: 3, firstAttemptAt: 100 }
  },
  {
    name: "completed, a sweep still returns the row at the attempt limit, quarantined",
    from: completed(MAX),
    event: { kind: "swept", row: row("r"), at: 500, maxAttempts: MAX },
    to: { phase: "quarantined", row: row("r") }
  },
  {
    name: "dispatching, removed, absent",
    from: dispatching(2),
    event: { kind: "removed" },
    to: undefined
  },
  {
    name: "waiting, removed, absent",
    from: waiting(2, 900),
    event: { kind: "removed" },
    to: undefined
  },
  {
    name: "completed, removed, absent",
    from: completed(2),
    event: { kind: "removed" },
    to: undefined
  },
  {
    name: "quarantined, removed, absent",
    from: quarantined(),
    event: { kind: "removed" },
    to: undefined
  }
];

for (const entry of table) {
  test(`transition: ${entry.name}`, () => {
    assert.deepEqual(transition(entry.from, entry.event), entry.to);
  });
}

// The admission gate is one lookup, so every phase suppresses a further offer
// from either discovery path, except the two the table names.
const suppressed = [
  ["dispatching", dispatching(2)],
  ["waiting", waiting(2, 900)],
  ["quarantined", quarantined()]
];

for (const [name, state] of suppressed) {
  test(`transition: ${name} suppresses a stream addition`, () => {
    const event = { kind: "added", row: row("r"), at: 700 };

    assert.deepEqual(transition(state, event), state);
  });

  test(`transition: ${name} suppresses a sweep offer`, () => {
    const event = { kind: "swept", row: row("r"), at: 700, maxAttempts: MAX };

    assert.deepEqual(transition(state, event), state);
  });
}

test("transition: completed suppresses a stream addition, since the sweep decides", () => {
  const state = completed(2);
  const event = { kind: "added", row: row("r"), at: 700 };

  assert.deepEqual(transition(state, event), state);
});

test("the map holds no entry for a row that was never discovered", () => {
  const rows = new Map();

  assert.equal(rows.get("never-discovered"), undefined);
  assert.equal(isAdmissible(rows, "never-discovered"), true);
  assert.deepEqual(countRows(rows), {
    dispatching: 0,
    waiting: 0,
    completed: 0,
    quarantined: 0
  });
});

test("a row is admissible if and only if the map holds no entry for it", () => {
  const rows = new Map();
  applyRowEvent(rows, "r", { kind: "added", row: row("r"), at: 100 });

  assert.equal(isAdmissible(rows, "r"), false);

  applyRowEvent(rows, "r", { kind: "removed" });

  assert.equal(isAdmissible(rows, "r"), true);
});

test("a row that leaves the set by the removed change is absent from the map", () => {
  const rows = new Map();
  applyRowEvent(rows, "r", { kind: "added", row: row("r"), at: 100 });
  applyRowEvent(rows, "r", { kind: "resolved" });
  applyRowEvent(rows, "r", { kind: "removed" });

  assert.equal(rows.has("r"), false);
  assert.equal(rows.size, 0);
});

test("a row that leaves the set by a sweep omitting it is absent from the map", () => {
  const rows = new Map();
  applyRowEvent(rows, "r", { kind: "added", row: row("r"), at: 100 });
  applyRowEvent(rows, "r", {
    kind: "rejected",
    retryAt: 900,
    maxAttempts: MAX
  });

  // A sweep that omits a row raises the same event as a removed change.
  applyRowEvent(rows, "r", { kind: "removed" });

  assert.equal(rows.has("r"), false);
  assert.equal(rows.size, 0);
});

test("a quarantined row leaves the map when it leaves the outstanding set", () => {
  const rows = new Map();
  applyRowEvent(rows, "r", { kind: "added", row: row("r"), at: 100 });
  applyRowEvent(rows, "r", {
    kind: "rejected",
    retryAt: 900,
    maxAttempts: 1
  });

  assert.equal(rows.get("r").phase, "quarantined");

  applyRowEvent(rows, "r", { kind: "removed" });

  assert.equal(rows.has("r"), false);
});

test("a stale added following a removed for the same row admits it once", () => {
  const rows = new Map();
  applyRowEvent(rows, "r", { kind: "added", row: row("r"), at: 100 });
  applyRowEvent(rows, "r", { kind: "resolved" });

  // One save carries the row's source fact and its completion fact, and
  // notifications are unordered, so the removed can arrive before the added.
  applyRowEvent(rows, "r", { kind: "removed" });
  applyRowEvent(rows, "r", { kind: "added", row: row("r"), at: 300 });

  assert.deepEqual(rows.get("r"), {
    phase: "dispatching",
    row: row("r"),
    attempts: 1,
    firstAttemptAt: 300
  });

  // The addition behind it is the same row, and the gate holds against it.
  applyRowEvent(rows, "r", { kind: "added", row: row("r"), at: 400 });

  assert.equal(rows.get("r").attempts, 1);
  assert.equal(rows.get("r").firstAttemptAt, 300);
  assert.equal(rows.size, 1);
});

test("a stale added re-admits a quarantined row, because removed clears any phase", () => {
  const rows = new Map();
  applyRowEvent(rows, "r", { kind: "added", row: row("r"), at: 100 });
  applyRowEvent(rows, "r", {
    kind: "rejected",
    retryAt: 900,
    maxAttempts: 1
  });
  applyRowEvent(rows, "r", { kind: "removed" });
  applyRowEvent(rows, "r", { kind: "added", row: row("r"), at: 300 });

  assert.equal(rows.get("r").phase, "dispatching");
  assert.equal(rows.get("r").attempts, 1);
});

test("counts agree with the map after every transition", () => {
  const rows = new Map();

  // Each step drives one row of the transition table on one of three rows.
  const script = [
    ["a", { kind: "added", row: row("a"), at: 100 }],
    ["b", { kind: "added", row: row("b"), at: 100 }],
    ["c", { kind: "swept", row: row("c"), at: 100, maxAttempts: MAX }],
    ["a", { kind: "resolved" }],
    ["b", { kind: "rejected", retryAt: 900, maxAttempts: MAX }],
    ["c", { kind: "rejected", retryAt: 900, maxAttempts: 1 }],
    ["b", { kind: "retryDue" }],
    ["a", { kind: "swept", row: row("a"), at: 500, maxAttempts: MAX }],
    ["b", { kind: "resolved" }],
    ["b", { kind: "swept", row: row("b"), at: 600, maxAttempts: 2 }],
    ["a", { kind: "resolved" }],
    ["c", { kind: "removed" }],
    ["a", { kind: "removed" }],
    ["b", { kind: "removed" }]
  ];

  const tally = () => {
    const states = [...rows.values()];
    const of = phase => states.filter(state => state.phase === phase).length;

    return {
      dispatching: of("dispatching"),
      waiting: of("waiting"),
      completed: of("completed"),
      quarantined: of("quarantined")
    };
  };

  assert.deepEqual(countRows(rows), tally());

  for (const [rowHash, event] of script) {
    applyRowEvent(rows, rowHash, event);

    const counts = countRows(rows);

    assert.deepEqual(counts, tally());
    assert.equal(
      counts.dispatching +
        counts.waiting +
        counts.completed +
        counts.quarantined,
      rows.size
    );
  }

  assert.equal(rows.size, 0);
  assert.deepEqual(countRows(rows), {
    dispatching: 0,
    waiting: 0,
    completed: 0,
    quarantined: 0
  });
});

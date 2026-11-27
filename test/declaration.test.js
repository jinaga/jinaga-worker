const test = require("node:test");
const assert = require("node:assert/strict");

const { buildModel } = require("jinaga");

const { defineConsumer } = require("../dist/index.js");

// ---------------------------------------------------------------------------
// A model with two shapes: a flat one, and a nested one whose unknowns sit at
// two depths. The nested shape is what shows the check reads inverses rather
// than the specification's top level.
// ---------------------------------------------------------------------------

class Tenant {
  static Type = "Test.Tenant";
  constructor(identifier) {
    this.type = Tenant.Type;
    this.identifier = identifier;
  }
}

class Item {
  static Type = "Test.Item";
  constructor(tenant, key) {
    this.type = Item.Type;
    this.tenant = tenant;
    this.key = key;
  }
}

class ItemHandled {
  static Type = "Test.Item.Handled";
  constructor(item) {
    this.type = ItemHandled.Type;
    this.item = item;
  }
}

class ItemQuarantined {
  static Type = "Test.Item.Quarantined";
  constructor(item, reason) {
    this.type = ItemQuarantined.Type;
    this.item = item;
    this.reason = reason;
  }
}

/** Structurally a completion fact, and a type no specification here excludes. */
class ItemArchived {
  static Type = "Test.Item.Archived";
  constructor(item) {
    this.type = ItemArchived.Type;
    this.item = item;
  }
}

class Project {
  static Type = "Test.Project";
  constructor(tenant, name) {
    this.type = Project.Type;
    this.tenant = tenant;
    this.name = name;
  }
}

class Task {
  static Type = "Test.Task";
  constructor(project, name) {
    this.type = Task.Type;
    this.project = project;
    this.name = name;
  }
}

class TaskDone {
  static Type = "Test.Task.Done";
  constructor(task) {
    this.type = TaskDone.Type;
    this.task = task;
  }
}

class Reviewer {
  static Type = "Test.Reviewer";
  constructor(tenant, name) {
    this.type = Reviewer.Type;
    this.tenant = tenant;
    this.name = name;
  }
}

class Approved {
  static Type = "Test.Approved";
  constructor(item, reviewer) {
    this.type = Approved.Type;
    this.item = item;
    this.reviewer = reviewer;
  }
}

class Revoked {
  static Type = "Test.Revoked";
  constructor(approved) {
    this.type = Revoked.Type;
    this.approved = approved;
  }
}

const model = buildModel(b => b
  .type(Tenant)
  .type(Item, f => f.predecessor("tenant", Tenant))
  .type(ItemHandled, f => f.predecessor("item", Item))
  .type(ItemQuarantined, f => f.predecessor("item", Item))
  .type(ItemArchived, f => f.predecessor("item", Item))
  .type(Project, f => f.predecessor("tenant", Tenant))
  .type(Task, f => f.predecessor("project", Project))
  .type(TaskDone, f => f.predecessor("task", Task))
  .type(Reviewer, f => f.predecessor("tenant", Tenant))
  .type(Approved, f => f.predecessor("item", Item).predecessor("reviewer", Reviewer))
  .type(Revoked, f => f.predecessor("approved", Approved)));

/** The outstanding set in its ordinary form: items not yet handled. */
const outstanding = model.given(Tenant).match((tenant, facts) =>
  facts.ofType(Item)
    .join(item => item.tenant, tenant)
    .notExists(item => facts.ofType(ItemHandled).join(handled => handled.item, item)));

/** §4's pattern: the completion fact and the quarantine fact both excluded. */
const outstandingWithQuarantine = model.given(Tenant).match((tenant, facts) =>
  facts.ofType(Item)
    .join(item => item.tenant, tenant)
    .notExists(item => facts.ofType(ItemHandled).join(handled => handled.item, item))
    .notExists(item => facts.ofType(ItemQuarantined).join(held => held.item, item)));

/** Two terminal decisions, either of which retires a row: decision 9's shape. */
const outstandingDecisions = model.given(Tenant).match((tenant, facts) =>
  facts.ofType(Item)
    .join(item => item.tenant, tenant)
    .notExists(item => facts.ofType(ItemHandled).join(handled => handled.item, item))
    .notExists(item => facts.ofType(ItemArchived).join(archived => archived.item, item)));

/** No condition at all, so nothing ever leaves the set. */
const everyItem = model.given(Tenant).match((tenant, facts) =>
  facts.ofType(Item).join(item => item.tenant, tenant));

/**
 * A positive `exists` where a `notExists` was meant. It gates admission rather
 * than completing a row, so it produces no remove inverse and retires nothing.
 */
const handledItems = model.given(Tenant).match((tenant, facts) =>
  facts.ofType(Item)
    .join(item => item.tenant, tenant)
    .exists(item => facts.ofType(ItemHandled).join(handled => handled.item, item)));

/** The condition sits on the inner unknown, two hops from the given. */
const outstandingTasks = model.given(Tenant).match((tenant, facts) =>
  facts.ofType(Project)
    .join(project => project.tenant, tenant)
    .selectMany(project => facts.ofType(Task)
      .join(task => task.project, project)
      .notExists(task => facts.ofType(TaskDone).join(done => done.task, task))));

/**
 * The second given is reached only from inside the condition. Nothing joins
 * `reviewer` to the row itself, so the row stream pins the arriving `Approved`
 * and reads the reviewer through it.
 */
const unapprovedByReviewer = model.given(Tenant, Reviewer).match((tenant, reviewer, facts) =>
  facts.ofType(Item)
    .join(item => item.tenant, tenant)
    .notExists(item => facts.ofType(Approved)
      .join(approved => approved.item, item)
      .join(approved => approved.reviewer, reviewer)));

/** A `notExists` nested under an `exists`: the inner type retires a row. */
const approvedAndUnrevoked = model.given(Tenant).match((tenant, facts) =>
  facts.ofType(Item)
    .join(item => item.tenant, tenant)
    .exists(item => facts.ofType(Approved)
      .join(approved => approved.item, item)
      .notExists(approved => facts.ofType(Revoked).join(revoked => revoked.approved, approved))));

/** A `notExists` nested under a `notExists`: the inner type adds a row. */
const withoutUnrevokedApproval = model.given(Tenant).match((tenant, facts) =>
  facts.ofType(Item)
    .join(item => item.tenant, tenant)
    .notExists(item => facts.ofType(Approved)
      .join(approved => approved.item, item)
      .notExists(approved => facts.ofType(Revoked).join(revoked => revoked.approved, approved))));

const acme = new Tenant("acme");
const quinn = new Reviewer(acme, "quinn");

/** A handler is beside the point here; every one of these throws before it runs. */
const completeWith = Completion => async row => new Completion(row.result);

// ---------------------------------------------------------------------------

test("a specification with no notExists is rejected, naming that nothing retires a row", () => {
  assert.throws(
    () => defineConsumer({
      name: "items",
      specification: everyItem,
      givens: [acme],
      completes: [ItemHandled],
      handle: completeWith(ItemHandled)
    }),
    error => {
      assert.match(error.message, /excludes no fact type at all/);
      assert.match(error.message, /Test\.Item\.Handled/);
      return true;
    },
    "a consumer that can never retire a row is refused at declaration"
  );
});

test("a completes the specification does not exclude is rejected, naming both sides", () => {
  assert.throws(
    () => defineConsumer({
      name: "items",
      specification: outstanding,
      givens: [acme],
      completes: [ItemArchived],
      handle: completeWith(ItemArchived)
    }),
    error => {
      assert.match(
        error.message,
        /completes Test\.Item\.Archived/,
        "the message names the declared type"
      );
      assert.match(
        error.message,
        /retires a row on: Test\.Item\.Handled/,
        "and the type the specification does retire on, which is the diagnosis"
      );
      return true;
    }
  );
});

test("a tuple of the two types the specification excludes is accepted, and both are declared", () => {
  const consumer = defineConsumer({
    name: "items",
    specification: outstandingDecisions,
    givens: [acme],
    completes: [ItemHandled, ItemArchived],
    handle: completeWith(ItemHandled)
  });

  assert.deepEqual(
    [...consumer.declaredTypes].sort(),
    [ItemArchived.Type, ItemHandled.Type].sort(),
    "declaredTypes reads the whole tuple, not one type of it"
  );
});

test("an undeclared completion type is rejected in each position of the tuple", () => {
  // `outstanding` retires a row on ItemHandled alone, so ItemArchived is the
  // undeclared one wherever it sits. Each position is checked in turn, so a
  // check that read only the first would pass one of these and fail the other.
  for (const completes of [[ItemArchived, ItemHandled], [ItemHandled, ItemArchived]]) {
    const position = completes.indexOf(ItemArchived);
    assert.throws(
      () => defineConsumer({
        name: "items",
        specification: outstanding,
        givens: [acme],
        completes,
        handle: completeWith(ItemHandled)
      }),
      error => {
        assert.match(
          error.message,
          /completes Test\.Item\.Archived/,
          `the message does not name the type at position ${position}`
        );
        assert.match(error.message, /retires a row on: Test\.Item\.Handled/);
        return true;
      },
      `an undeclared type at position ${position} was accepted`
    );
  }
});

test("the section 4 pattern, with completion and quarantine both excluded, is accepted", () => {
  const consumer = defineConsumer({
    name: "items",
    specification: outstandingWithQuarantine,
    givens: [acme],
    completes: [ItemHandled],
    handle: completeWith(ItemHandled),
    quarantine: {
      produces: ItemQuarantined,
      fact: async (row, event) => new ItemQuarantined(row.result, event.kind)
    }
  });

  assert.equal(consumer.name, "items");
});

test("a notExists on a nested unknown is accepted when completes matches it", () => {
  const consumer = defineConsumer({
    name: "tasks",
    specification: outstandingTasks,
    givens: [acme],
    completes: [TaskDone],
    handle: async row => new TaskDone(row.result)
  });

  assert.equal(
    consumer.name,
    "tasks",
    "the check reads the specification's inverses, not only its top level"
  );
});

test("a specification using exists rather than notExists is rejected", () => {
  assert.throws(
    () => defineConsumer({
      name: "items",
      specification: handledItems,
      givens: [acme],
      completes: [ItemHandled],
      handle: completeWith(ItemHandled)
    }),
    /excludes no fact type at all/,
    "a positive exists is a gate on admission, and it retires nothing"
  );
});

test("a quarantine group whose produces is not excluded is rejected", () => {
  assert.throws(
    () => defineConsumer({
      name: "items",
      specification: outstanding,
      givens: [acme],
      completes: [ItemHandled],
      handle: completeWith(ItemHandled),
      quarantine: {
        produces: ItemQuarantined,
        fact: async (row, event) => new ItemQuarantined(row.result, event.kind)
      }
    }),
    error => {
      assert.match(error.message, /quarantine\.produces Test\.Item\.Quarantined/);
      assert.match(error.message, /retires a row on: Test\.Item\.Handled/);
      return true;
    },
    "an exhausted row would be written and go on matching the outstanding set"
  );
});

test("a given joined only inside the condition is accepted", () => {
  const consumer = defineConsumer({
    name: "approvals",
    specification: unapprovedByReviewer,
    givens: [acme, quinn],
    completes: [Approved],
    handle: async row => new Approved(row.result, quinn)
  });

  assert.deepEqual(
    consumer.retiringTypes,
    ["Test.Approved"],
    "the row stream serves this specification, so the declaration check accepts it"
  );
});

test("the inner type of an exists over a notExists retires a row", () => {
  const consumer = defineConsumer({
    name: "revocations",
    specification: approvedAndUnrevoked,
    givens: [acme],
    completes: [Revoked],
    handle: completeWith(Revoked)
  });

  assert.deepEqual(
    consumer.retiringTypes,
    ["Test.Revoked"],
    "a Revoked makes the inner notExists false, which makes the exists false"
  );
});

test("the inner type of a notExists over a notExists is rejected, naming what retires", () => {
  assert.throws(
    () => defineConsumer({
      name: "revocations",
      specification: withoutUnrevokedApproval,
      givens: [acme],
      completes: [Revoked],
      handle: completeWith(Revoked)
    }),
    error => {
      assert.match(error.message, /completes Test\.Revoked/);
      assert.match(
        error.message,
        /retires a row on: Test\.Approved\.$/,
        "a Revoked admits a row here, and only an Approved retires one"
      );
      return true;
    }
  );
});

test("a type two conditions can retire a row on is reported once", () => {
  const consumer = defineConsumer({
    name: "items",
    specification: outstandingWithQuarantine,
    givens: [acme],
    completes: [ItemHandled],
    handle: completeWith(ItemHandled),
    quarantine: {
      produces: ItemQuarantined,
      fact: async (row, event) => new ItemQuarantined(row.result, event.kind)
    }
  });

  assert.deepEqual(
    consumer.retiringTypes,
    ["Test.Item.Handled", "Test.Item.Quarantined"],
    "the types a row can leave the set on, each named once"
  );
});

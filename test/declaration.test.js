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

const model = buildModel(b => b
  .type(Tenant)
  .type(Item, f => f.predecessor("tenant", Tenant))
  .type(ItemHandled, f => f.predecessor("item", Item))
  .type(ItemQuarantined, f => f.predecessor("item", Item))
  .type(ItemArchived, f => f.predecessor("item", Item))
  .type(Project, f => f.predecessor("tenant", Tenant))
  .type(Task, f => f.predecessor("project", Project))
  .type(TaskDone, f => f.predecessor("task", Task)));

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

const acme = new Tenant("acme");

/** A handler is beside the point here; every one of these throws before it runs. */
const completeWith = Completion => async row => new Completion(row.result);

// ---------------------------------------------------------------------------

test("a specification with no notExists is rejected, naming that nothing retires a row", () => {
  assert.throws(
    () => defineConsumer({
      name: "items",
      specification: everyItem,
      givens: [acme],
      completes: ItemHandled,
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
      completes: ItemArchived,
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

test("the section 4 pattern, with completion and quarantine both excluded, is accepted", () => {
  const consumer = defineConsumer({
    name: "items",
    specification: outstandingWithQuarantine,
    givens: [acme],
    completes: ItemHandled,
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
    completes: TaskDone,
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
      completes: ItemHandled,
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
      completes: ItemHandled,
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

const { buildModel, JinagaTest, MemoryStore } = require("jinaga");

/**
 * The domain these tests run against, and the real Jinaga instance that holds
 * it.
 *
 * A consumer's outstanding set is the subjects of one tenant that carry
 * neither of the two facts that retire a row. Both are the application's: a
 * handler returns `Mirrored` and the library asserts it, and a quarantine
 * group returns `Quarantined`. The specification excludes both, so a row
 * leaves the set when either lands.
 *
 * Every test drives this model on a real in-memory instance: the rows a
 * consumer sees are the ones the store answers with, their `rowHash` is the
 * one jinaga computed, and a completion fact's hash is `j.hash` of the fact
 * the store holds.
 */

/** A fact class in jinaga's idiom: the literal on the constructor. */
class Tenant {
  constructor(identifier) {
    this.type = Tenant.Type;
    this.identifier = identifier;
  }
}
Tenant.Type = "Test.Tenant";

class Subject {
  constructor(tenant, key) {
    this.type = Subject.Type;
    this.tenant = tenant;
    this.key = key;
  }
}
Subject.Type = "Test.Subject";

/** What a handler returns, and what takes its row out of the outstanding set. */
class Mirrored {
  constructor(subject) {
    this.type = Mirrored.Type;
    this.subject = subject;
  }
}
Mirrored.Type = "Test.Subject.Mirrored";

/** What a quarantine group records about a row it has given up on. */
class Quarantined {
  constructor(subject, reason) {
    this.type = Quarantined.Type;
    this.subject = subject;
    this.reason = reason;
  }
}
Quarantined.Type = "Test.Subject.Quarantined";

const model = buildModel(b => b
  .type(Tenant)
  .type(Subject, f => f.predecessor("tenant", Tenant))
  .type(Mirrored, f => f.predecessor("subject", Subject))
  .type(Quarantined, f => f.predecessor("subject", Subject)));

/** The outstanding set: a tenant's subjects that are neither mirrored nor given up on. */
const outstanding = model.given(Tenant).match((tenant, facts) =>
  facts.ofType(Subject)
    .join(subject => subject.tenant, tenant)
    .notExists(subject => facts.ofType(Mirrored).join(mirrored => mirrored.subject, subject))
    .notExists(subject => facts.ofType(Quarantined).join(given => given.subject, subject)));

/** The completion facts the store holds for one tenant's subjects. */
const completionsOf = model.given(Tenant).match((tenant, facts) =>
  facts.ofType(Mirrored).join(mirrored => mirrored.subject.tenant, tenant));

/** The quarantine records the store holds for one tenant's subjects. */
const quarantinesOf = model.given(Tenant).match((tenant, facts) =>
  facts.ofType(Quarantined).join(given => given.subject.tenant, tenant));

/**
 * A real instance over this model, and the two tenants a test writes to.
 *
 * `acme` is the consumer's given. `elsewhere` is a tenant no consumer is
 * declared over, which is where a test puts a fact it wants written but not
 * read: a completion fact built against another tenant's subject is stored,
 * carries the declared type, and retires nothing the consumer is watching.
 */
async function world(config = {}) {
  const j = JinagaTest.create({ model, ...config });
  const acme = await j.fact(new Tenant("acme"));
  const elsewhere = await j.fact(new Tenant("elsewhere"));
  return { j, acme, elsewhere };
}

/**
 * Write a subject and return the row the specification gives it. Its `rowHash`
 * is jinaga's own, so a test names a row the way the consumer sees it.
 */
async function outstandingRow(j, tenant, key) {
  await j.fact(new Subject(tenant, key));
  const rows = await j.queryRows(outstanding, tenant);
  const row = rows.find(candidate => candidate.result.key === key);
  if (row === undefined) {
    throw new Error(`${key} is not in the outstanding set`);
  }
  return row;
}

/** The hashes of the facts one of those specifications reads. */
async function hashesOf(j, specification, tenant) {
  const facts = await j.query(specification, tenant);
  return facts.map(fact => j.hash(fact));
}

/**
 * A real `MemoryStore` whose writes pass through `gate` first, so a test can
 * hold one open the way a slow store does. Every other call is the store's own.
 */
function gatedStore(gate) {
  const inner = new MemoryStore();
  return new Proxy(inner, {
    get(target, property) {
      if (property === "save") {
        return async envelopes => {
          await gate(envelopes);
          return await inner.save(envelopes);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

/**
 * A real instance whose discovery seam a test drives.
 *
 * Hashing a given and asserting the fact a handler returned still run against
 * the real instance, so the hashes and the store in these tests are the ones
 * jinaga produced. Only the calls named in `overrides` are the test's, and they
 * are the ones whose orderings and failures a store cannot be made to produce:
 * a change delivered behind the fact that retired its row, a sweep the
 * replicator has forgotten the feed for, a subscribe that never answers.
 */
function driving(j, overrides) {
  return new Proxy(j, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) {
        return overrides[property];
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

module.exports = {
  Tenant,
  Subject,
  Mirrored,
  Quarantined,
  outstanding,
  completionsOf,
  quarantinesOf,
  world,
  outstandingRow,
  hashesOf,
  gatedStore,
  driving
};

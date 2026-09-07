const { buildModel } = require("jinaga");

/**
 * A real specification that retires a row on each of the named fact types.
 *
 * The tests that drive the loop through a fake Jinaga never run the
 * specification they declare: their seam answers `subscribeRows` and
 * `queryRows` directly, and only the consumer's givens reach it. It has to be a
 * real specification all the same, because `defineConsumer` inverts it to check
 * that what the consumer completes is something the specification excludes.
 *
 * The fact classes below exist only to shape that specification. A test's own
 * completion class is the one its handler returns and its store records; the
 * two meet at the type literal, which is all the check reads.
 */

/** A fact class in jinaga's idiom, built from a type literal. */
function factType(type, build) {
  const Fact = class {
    constructor(...args) {
      this.type = type;
      build(this, ...args);
    }
  };
  Fact.Type = type;
  return Fact;
}

const Tenant = factType("Test.Tenant", (fact, id) => {
  fact.id = id;
});

const Subject = factType("Test.Subject", (fact, tenant, key) => {
  fact.tenant = tenant;
  fact.key = key;
});

function retiringOn(...completionTypes) {
  const completions = completionTypes.map(type =>
    factType(type, (fact, subject) => {
      fact.subject = subject;
    }));

  // One completion type per `notExists`, so every one of them inverts to a
  // remove and the specification retires on all of them.
  const model = buildModel(builder => completions.reduce(
    (withCompletions, Completion) =>
      withCompletions.type(Completion, f => f.predecessor("subject", Subject)),
    builder
      .type(Tenant)
      .type(Subject, f => f.predecessor("tenant", Tenant))));

  return model.given(Tenant).match((tenant, facts) => completions.reduce(
    (subjects, Completion) => subjects.notExists(subject =>
      facts.ofType(Completion).join(completion => completion.subject, subject)),
    facts.ofType(Subject).join(subject => subject.tenant, tenant)));
}

module.exports = { retiringOn };

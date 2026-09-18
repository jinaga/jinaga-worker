const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { repoRoot, commentAbove } = require("./declaration-comments");

// Two members of `ConsumerOptions` carry a requirement their types admit a
// violation of. `givens: T` accepts a given that differs across restarts, and
// `handle: (row) => Promise<C>` accepts a handler that retries before it
// settles. Neither can be narrowed out of the type, so each requirement is
// stated where a caller writes the value, and read back here from the
// declaration a caller's editor shows.

const PAGE = "docs/handler-contract.md";

test("ConsumerOptions.givens states what a stable given is and what to compare", () => {
  const comment = commentAbove("consumer.d.ts", "ConsumerOptions", "givens: T;");

  assert.match(comment, /byte-stable across restarts/, "the requirement itself is unstated");
  assert.match(comment, /silently empty/, "the outcome of breaking it is unstated, and it is a silent one");
  assert.match(comment, /given hash/, "nothing sends the reader to the line they can compare");
  assert.match(
    comment,
    /\(\.\.\/docs\/inherited-constraints\.md\)/,
    "the mechanism's page is not linked, so the explanation is reachable from nowhere"
  );
});

test("ConsumerOptions.handle states that one call is one attempt, and who owns the retry", () => {
  const comment = commentAbove(
    "consumer.d.ts",
    "ConsumerOptions",
    "handle: (row: SpecificationRow<U>) => Promise<C>;"
  );

  assert.match(comment, /One call is one attempt/, "the unit an attempt measures is unstated");
  assert.match(comment, /failure is a rejection/, "nothing says how a handler reports a failed attempt");
  assert.match(
    comment,
    /belongs to the consumer's `retry`/,
    "nothing names the option that owns the retry policy, which is what a handler's own competes with"
  );
  assert.match(
    comment,
    /\(\.\.\/docs\/handler-contract\.md\)/,
    "the contract's page is not linked, so the explanation is reachable from nowhere"
  );
});

// The comment states the requirement; the page carries the mechanism. This is
// the half that says why an internal retry costs something, and the comment
// links here rather than repeating it.
test("the handler contract's Rejection section carries what an internal retry breaks", () => {
  const page = fs.readFileSync(path.join(repoRoot, PAGE), "utf8");

  const rejection = page.split(/^## Rejection$/m)[1];
  assert.ok(rejection !== undefined, `${PAGE} has no \`Rejection\` section`);

  const prose = rejection.split(/^## /m)[0].replace(/\s+/g, " ");

  assert.match(prose, /One call of your handler is one attempt/);
  assert.match(prose, /the handler keeps no retry of its own/);
  assert.match(prose, /`attempts`/, "the section does not say what an internal retry does to the count");
  assert.match(prose, /`maxAttempts`/, "the section does not say what it does to the budget");
});

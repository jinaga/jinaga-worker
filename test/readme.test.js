const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { guardPage, repoRoot } = require("./spec-guard.js");

const PAGE = "README.md";

const page = fs.readFileSync(path.join(repoRoot, PAGE), "utf8");

/**
 * What the README's Usage block stands on.
 *
 * The block is the consumer a reader copies, so it imports the package by its
 * own name and resolves through the exports map the way an installed copy
 * does. Only `mirror`, the reader's side effect, is declared here.
 */
const PREAMBLE = `declare function mirror(invitation: unknown): Promise<void>;\n`;

function guardIn(name, text = page) {
  return guardPage(PAGE, { preamble: PREAMBLE, name, text });
}

test("the README's usage compiles against the shipped types", () => {
  const result = guardIn("readme");
  assert.ok(result.ok, `${PAGE} has drifted from dist/:\n${result.output}`);
});

// The guard has to fail from the page's side, or a usage block that no longer
// typechecks would compile forever on the strength of its preamble alone.
test("a README that misspells a consumer option fails the guard", () => {
  const option = "completes: InvitationMirrored";
  assert.ok(page.includes(option), `no block on ${PAGE} sets ${option}`);

  const result = guardIn("readme-mutation", page.replace(option, "complete: InvitationMirrored"));
  assert.equal(result.ok, false, "a block set an option the consumer does not have and the guard passed");
});

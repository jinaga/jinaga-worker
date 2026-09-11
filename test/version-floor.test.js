const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { repoRoot } = require("./markdown-references");

/**
 * The jinaga version the specification is written against, and the floor the
 * package requires, are one decision written in three places.
 *
 * The specification's guarantees stand on a particular release of the library —
 * §5 depends on the bounded subscribe — so a reader who takes the preamble at
 * its word installs what it names. Both values are read here at run time, and
 * the expectation is the one the specification states: a version written into
 * the assertion would be a fourth copy of the decision, and it would agree with
 * itself while the three real ones drifted apart.
 */

const specPath = path.join(repoRoot, "design", "durable-consumer-spec.md");
const manifestPath = path.join(repoRoot, "package.json");

/** The preamble sentence that states the release the specification requires. */
const REQUIRES = /^Requires `jinaga` ([^,\s]+)/m;

/**
 * The version the specification names. A preamble the pattern cannot find is a
 * failure rather than an absent expectation, because a comparison against
 * nothing is a comparison that passes.
 */
function statedVersion() {
  const content = fs.readFileSync(specPath, "utf8");
  const stated = REQUIRES.exec(content);

  assert.ok(
    stated !== null,
    "design/durable-consumer-spec.md no longer opens with a `Requires \\`jinaga\\` <version>` line"
  );
  return stated[1];
}

/** The floor each of the manifest's dependency fields declares for jinaga. */
function declaredFloors() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  return {
    peerDependencies: manifest.peerDependencies?.jinaga,
    devDependencies: manifest.devDependencies?.jinaga
  };
}

test("package.json requires the jinaga version the specification states", () => {
  const stated = statedVersion();

  // Both fields, because the floor moves in both when it moves at all.
  assert.deepEqual(declaredFloors(), {
    peerDependencies: stated,
    devDependencies: stated
  });
});

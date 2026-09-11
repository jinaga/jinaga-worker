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
 * Where the preamble ends. The numbered sections begin at the first `##`
 * heading, so everything above it is what a reader meets before §1. The `---`
 * rule that sits just above that heading divides four later sections too, and a
 * boundary that lands on the first of five is a boundary that can move.
 */
const FIRST_SECTION = /^## /m;

/**
 * The version the preamble names.
 *
 * The claim under test is what the preamble states, so the preamble is what is
 * read: a sentence found anywhere in the document would let the stated floor
 * drift while some other line held the comparison up. Both the missing case and
 * the repeated one fail here rather than yielding an expectation that no longer
 * means what it says, because a comparison against nothing is a comparison that
 * passes.
 */
function statedVersion() {
  const content = fs.readFileSync(specPath, "utf8");
  const firstSection = FIRST_SECTION.exec(content);

  assert.ok(
    firstSection !== null,
    "design/durable-consumer-spec.md no longer has a `##` section to close its preamble"
  );

  const stated = REQUIRES.exec(content.slice(0, firstSection.index));

  assert.ok(
    stated !== null,
    "the preamble of design/durable-consumer-spec.md no longer carries a `Requires \\`jinaga\\` <version>` line"
  );

  // One sentence states the floor. A second, anywhere on the page, is a claim
  // the preamble does not govern and this comparison would not read.
  const everywhere = content.match(new RegExp(REQUIRES.source, "gm")) ?? [];
  assert.equal(
    everywhere.length,
    1,
    "design/durable-consumer-spec.md states the required jinaga version in more than one place"
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

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");

// The third outcome, and the consequence a caller acts on. A site that states
// the outcome without the consequence tells a caller what is true and not what
// to do about it, so both sites are held to both sentences.
const OUTCOME =
  "`subscribeRows` awaits the feed's first response, so a replicator that " +
  "accepts the connection and never answers leaves `start()` pending " +
  "indefinitely.";
const CONSEQUENCE =
  "Do not await `start()` in a boot path unless the process is supposed to " +
  "fail when the replicator is unreachable.";

// Both sites wrap their prose, one behind comment markers and one behind list
// markers, so compare on a single line with those markers removed.
function flatten(content) {
  return content
    .replace(/^\s*(?:\/\*\*|\*\/|\*|-)\s?/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The comment a caller reads is the one on the `Worker` interface, which is
// what `createWorker` returns. Scope the read to that member rather than to the
// file, so a sentence that drifted onto some other declaration does not answer
// for it.
function workerStartComment() {
  const declarations = fs.readFileSync(path.join(repoRoot, "dist", "worker.d.ts"), "utf8");

  const afterInterface = declarations.split(/\binterface Worker \{/)[1];
  assert.ok(afterInterface !== undefined, "dist/worker.d.ts declares no Worker interface");

  const body = afterInterface.split(/^\}/m)[0];
  const comment = body.split(/start\(\): Promise<void>;/)[0];
  assert.notEqual(comment, body, "the Worker interface declares no start()");

  return flatten(comment);
}

test("Worker.start()'s declaration names the pending outcome and what a boot path owes it", () => {
  const comment = workerStartComment();

  assert.ok(
    comment.includes(OUTCOME),
    `Worker.start() does not name the pending outcome:\n${comment}`
  );
  assert.ok(
    comment.includes(CONSEQUENCE),
    `Worker.start() does not name the boot-path consequence:\n${comment}`
  );
});

test("the inherited constraints carry the same two sentences about start()", () => {
  const page = flatten(
    fs.readFileSync(path.join(repoRoot, "docs", "inherited-constraints.md"), "utf8")
  );

  assert.ok(
    page.includes(OUTCOME),
    "docs/inherited-constraints.md does not carry the pending outcome"
  );
  assert.ok(
    page.includes(CONSEQUENCE),
    "docs/inherited-constraints.md does not carry the boot-path consequence"
  );
});

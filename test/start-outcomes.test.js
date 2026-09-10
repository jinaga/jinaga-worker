const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { repoRoot, flatten, commentAbove } = require("./declaration-comments");

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

// The comment a caller reads is the one on the `Worker` interface, which is
// what `createWorker` returns.
test("Worker.start()'s declaration names the pending outcome and what a boot path owes it", () => {
  const comment = commentAbove("worker.d.ts", "Worker", "start(): Promise<void>;");

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

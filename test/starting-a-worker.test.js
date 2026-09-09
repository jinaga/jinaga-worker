const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { DIST, readTsBlocks, runGuard, workspaceRoot } = require("./spec-guard.js");
const { repoRoot, commentAbove } = require("./declaration-comments");

const PAGE = "docs/starting-a-worker.md";
const URL = "https://github.com/jinaga/jinaga-worker/blob/main/docs/starting-a-worker.md";

const page = fs.readFileSync(path.join(repoRoot, PAGE), "utf8");

/**
 * What the page's blocks stand on.
 *
 * The page recommends shapes rather than publishing types, so its blocks are
 * boot paths: they call the library and they name the process, the log and the
 * consumers around it. Those surroundings belong to the reader's application,
 * so they are declared here and the blocks show only the code the reader
 * writes.
 */
const PREAMBLE =
  `import { DistributionDeniedError, Jinaga } from "jinaga";\n` +
  `import { Consumer, createWorker, Worker } from "${DIST}";\n` +
  `declare const j: Jinaga;\n` +
  `declare const consumers: readonly Consumer[];\n` +
  `declare const logger: {\n` +
  `    error(fields: object, message: string): void;\n` +
  `    warn(fields: object, message: string): void;\n` +
  `};\n` +
  `declare const process: {\n` +
  `    exit(code: number): never;\n` +
  `    on(signal: string, handler: () => void | Promise<void>): void;\n` +
  `};\n` +
  `declare function delay(ms: number): Promise<void>;\n`;

/** Every block on the page, each standing on the same preamble. */
function pageBlocks(text) {
  return readTsBlocks(text.split("\n"), { origin: PAGE, section: "starting-a-worker" }).map(
    (block) => ({ ...block, entry: { preamble: PREAMBLE, compares: {}, local: {} } })
  );
}

function guardIn(name, text = page) {
  return runGuard(pageBlocks(text), {
    directory: path.join(workspaceRoot, name),
    dist: "../../../dist/index"
  });
}

test("the page's boot paths compile against the shipped types", () => {
  // A page of shapes goes stale the same way the specification's type blocks
  // do, and it goes stale in the reader's editor rather than in a document
  // nobody compiles. Every block is compiled: the page has no illustrations,
  // because a shape a caller cannot paste is not a recommendation.
  assert.ok(pageBlocks(page).length > 0, `${PAGE} carries no ts block to compile`);

  const result = guardIn("starting-a-worker");
  assert.ok(result.ok, `${PAGE} has drifted from dist/:\n${result.output}`);
});

// The guard has to fail from the page's side, or a page of shapes that no
// longer typecheck would compile forever on the strength of its preamble alone.
// The mutation starts from a match, so a rename that left it substituting
// nothing fails here rather than passing on a mutation it never made.
test("a page that misspells a worker option fails the guard", () => {
  const option = "startTimeoutMs: 30_000";
  assert.ok(page.includes(option), `no block on ${PAGE} sets ${option}`);

  const result = guardIn(
    "starting-a-worker-mutation",
    page.replace(option, "startTimeoutMS: 30_000")
  );
  assert.equal(result.ok, false, "a block set an option the worker does not have and the guard passed");
});

test("the page names both rejections and which one is worth retrying", () => {
  // The shapes are only as good as the branch they turn on: a boot path that
  // treats the two rejections alike retries the one retrying cannot fix.
  assert.match(page, /`DistributionDeniedError`/);
  assert.match(page, /`FeedTimeoutError`/);
  assert.match(
    page.replace(/\s+/g, " "),
    /A `FeedTimeoutError` usually resolves on its own, and it is the one worth retrying\./
  );
});

test("the README sends a reader to the page before they deploy", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");

  const section = readme.split(/^## Before you deploy a worker$/m)[1];
  assert.ok(section !== undefined, "the README has no `Before you deploy a worker` section");

  assert.match(
    section.split(/^## /m)[0],
    /\]\(docs\/starting-a-worker\.md\)/,
    "`Before you deploy a worker` does not link the page"
  );
});

// An agent writing the call reads `dist/*.d.ts` inside `node_modules`, where a
// path relative to this repository resolves to nothing. The absolute URL is
// what reaches the page from there.
for (const [name, declaration, member] of [
  ["Worker.start()", "Worker", "start(): Promise<void>;"],
  ["WorkerOptions.startTimeoutMs", "WorkerOptions", "startTimeoutMs?: number;"]
]) {
  test(`${name} links the page by absolute URL`, () => {
    assert.ok(
      commentAbove("worker.d.ts", declaration, member).includes(URL),
      `${name} does not link ${PAGE} by absolute URL`
    );
  });
}

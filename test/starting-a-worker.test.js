const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { DIST, guardPage, repoRoot } = require("./spec-guard.js");

const PAGE = "docs/starting-a-worker.md";

const page = fs.readFileSync(path.join(repoRoot, PAGE), "utf8");

/**
 * What the page's blocks stand on.
 *
 * The page recommends shapes rather than publishing types, so its blocks are
 * boot paths: they call the library and they name the process, the log and the
 * consumers around it. Those surroundings belong to the reader's application,
 * so they are declared here and the blocks show only the code the reader
 * writes.
 *
 * Every name the package ships is imported rather than described. A hand-written
 * stand-in would compile the page against a shape the library does not have, and
 * a block that typechecks against an invented `Logger` is worse than one that
 * does not compile at all: it teaches an argument order that fails in the
 * reader's editor. Only `process` and `delay`, which the package does not ship,
 * are declared here, and each is the shape its own source gives it.
 */
const PREAMBLE =
  `import { DistributionDeniedError, Jinaga } from "jinaga";\n` +
  `import { Consumer, createWorker, Logger, Worker } from "${DIST}";\n` +
  `declare const j: Jinaga;\n` +
  `declare const consumers: readonly Consumer[];\n` +
  `declare const logger: Logger;\n` +
  `declare const process: {\n` +
  `    exit(code: number): never;\n` +
  `    on(signal: string, handler: () => void | Promise<void>): void;\n` +
  `};\n` +
  `declare function delay(ms: number): Promise<void>;\n`;

function guardIn(name, text = page) {
  return guardPage(PAGE, { preamble: PREAMBLE, name, text });
}

test("the page's boot paths compile against the shipped types", () => {
  // A page of shapes goes stale the same way the specification's type blocks
  // do, and it goes stale in the reader's editor rather than in a document
  // nobody compiles. Every block is compiled: the page has no illustrations,
  // because a shape a caller cannot paste is not a recommendation.
  const result = guardIn("starting-a-worker");
  assert.ok(result.ok, `${PAGE} has drifted from dist/:\n${result.output}`);
});

// The guard has to fail from the page's side, or a page of shapes that no
// longer typecheck would compile forever on the strength of its preamble alone.
test("a page that misspells a worker option fails the guard", () => {
  const result = guardIn(
    "starting-a-worker-mutation",
    page.replace("startTimeoutMs: 30_000", "startTimeoutMS: 30_000")
  );
  assert.equal(result.ok, false, "a misspelled worker option compiled");
});

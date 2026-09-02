const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("build output exports scaffolded API", async () => {
  const exports = require("../dist/index.js");

  assert.equal(typeof exports.consume, "function");
});

test("scaffolded consume entrypoint is intentionally unimplemented", async () => {
  const { consume } = require("../dist/index.js");

  assert.throws(
    () =>
      consume({
        name: "example",
        specification: {},
        givens: [],
        sweepIntervalMs: 60000,
        handlerTimeoutMs: 30000,
        maxAttempts: 5,
        handle: async () => {}
      }),
    /not implemented/i
  );
});

test("publish workflow is present but disabled", async () => {
  const workflowPath = path.join(__dirname, "..", ".github", "workflows", "publish.yml");
  const content = fs.readFileSync(workflowPath, "utf8");

  assert.match(content, /workflow_dispatch:/);
  assert.match(content, /if:\s*\$\{\{\s*false\s*\}\}/);
});

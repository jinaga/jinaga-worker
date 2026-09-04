const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("build output exports the package API", async () => {
  const exports = require("../dist/index.js");

  assert.equal(typeof exports.defineConsumer, "function");
  assert.equal(typeof exports.createWorker, "function");
});

test("publish workflow is present but disabled", async () => {
  const workflowPath = path.join(__dirname, "..", ".github", "workflows", "publish.yml");
  const content = fs.readFileSync(workflowPath, "utf8");

  assert.match(content, /workflow_dispatch:/);
  assert.match(content, /if:\s*\$\{\{\s*false\s*\}\}/);
});

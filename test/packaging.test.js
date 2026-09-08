const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { repoRoot, prose, references } = require("./markdown-references");

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

// The tarball is the authority on what ships, so read it rather than restating
// `files` here: a second copy of that list would drift the moment `files` moved.
//
// A pack listing names paths inside the archive, and npm roots an archive at
// `package/`. Strip that root and take the report as either shape, so the set is
// repo-relative whatever npm hands back — a set in the other shape would match
// nothing, and a check that matches nothing passes.
function shippedFiles() {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  const start = output.search(/[[{]/);
  assert.ok(start >= 0, `npm pack reported no JSON: ${output}`);

  const reported = JSON.parse(output.slice(start));
  const [tarball] = Array.isArray(reported) ? reported : [reported];
  return new Set(tarball.files.map((file) => file.path.replace(/^package\//, "")));
}

test("README.md names only paths the installed package carries", () => {
  const shipped = shippedFiles();
  const content = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");

  // `docs/` reaches the tarball under #18. Until then it is the one folder the
  // README may name that the pack listing does not yet report.
  const carried = (target) => shipped.has(target) || target.startsWith("docs/");

  const unreachable = [];
  for (const { target } of references(prose(content))) {
    const targetPath = target.split("#")[0];
    if (targetPath.length === 0) {
      continue;
    }
    const fromRoot = path.relative(repoRoot, path.resolve(repoRoot, targetPath));
    if (!carried(fromRoot)) {
      unreachable.push(target);
    }
  }

  assert.deepEqual(unreachable, []);
});

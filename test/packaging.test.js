const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { repoRoot, prose, comments, references } = require("./markdown-references");

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

// Every file under `dir`, repo-relative, so the pack listing can be asked about
// each one by name rather than about the folder.
function filesUnder(dir) {
  return fs
    .readdirSync(path.join(repoRoot, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(repoRoot, path.join(entry.parentPath, entry.name)));
}

// The paths `file` names that the tarball does not carry, taking `content` as
// the file's text rather than reading it, so the rule can be asked about a file
// that does not exist.
//
// A Markdown link is written from the file that holds it and a backticked path
// from the package root, which is the distinction `references` already draws.
function unreachablePaths(shipped, file, content) {
  const text = file.endsWith(".md") ? prose(content) : comments(content);
  const unreachable = [];

  for (const { target, fromRoot } of references(text)) {
    const targetPath = target.split("#")[0];
    if (targetPath.length === 0) {
      continue;
    }
    const base = fromRoot ? repoRoot : path.dirname(path.join(repoRoot, file));
    if (!shipped.has(path.relative(repoRoot, path.resolve(base, targetPath)))) {
      unreachable.push(`${file} -> ${target}`);
    }
  }

  return unreachable;
}

test("the tarball carries the library and its documentation, and nothing else", () => {
  const shipped = shippedFiles();

  assert.ok(shipped.has("README.md"));
  assert.ok(shipped.has("LICENSE"));
  assert.ok([...shipped].some((file) => file.startsWith("dist/")));

  const repositoryOnly = [...shipped].filter((file) =>
    /^(src|test|design|\.github)\//.test(file)
  );
  assert.deepEqual(repositoryOnly, []);
});

test("every file under docs/ ships", () => {
  const shipped = shippedFiles();

  assert.deepEqual(filesUnder("docs").filter((file) => !shipped.has(file)), []);
});

test("every shipped file names only paths the installed package carries", () => {
  const shipped = shippedFiles();
  const unreachable = [];

  for (const file of shipped) {
    if (!file.endsWith(".md") && !file.endsWith(".d.ts")) {
      continue;
    }
    const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
    unreachable.push(...unreachablePaths(shipped, file, content));
  }

  assert.deepEqual(unreachable, []);
});

test("a shipped page reaching into the design record is reported", () => {
  const shipped = shippedFiles();

  assert.deepEqual(
    unreachablePaths(
      shipped,
      "docs/example.md",
      "[the specification](../design/durable-consumer-spec.md)\n"
    ),
    ["docs/example.md -> ../design/durable-consumer-spec.md"]
  );
});

test("the package name resolves to the entry point under both module systems", () => {
  assert.equal(require.resolve("jinaga-worker"), path.join(repoRoot, "dist", "index.js"));

  const resolved = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", "process.stdout.write(import.meta.resolve('jinaga-worker'))"],
    { cwd: repoRoot, encoding: "utf8" }
  );
  assert.equal(resolved, new URL(`file://${path.join(repoRoot, "dist", "index.js")}`).href);
});

test("the interior of dist/ is not importable", () => {
  assert.throws(
    () => require("jinaga-worker/dist/consumer"),
    (error) => error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
  );
});

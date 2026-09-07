const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const repoRoot = path.join(__dirname, "..");

function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  return output.split("\0").filter((entry) => entry.length > 0);
}

const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
const SEE = /@see\s+(\S+)/g;

function linkTargets(content) {
  const targets = [];
  for (const match of content.matchAll(LINK)) {
    targets.push(match[1]);
  }
  return targets;
}

function seeTargets(content) {
  const targets = [];
  for (const match of content.matchAll(SEE)) {
    const target = match[1];
    if (target.includes("/") || target.endsWith(".md")) {
      targets.push(target);
    }
  }
  return targets;
}

function isRelative(target) {
  return !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("#");
}

test("every relative link in the tracked tree resolves to a file that exists", () => {
  const broken = [];

  for (const file of trackedFiles()) {
    const isMarkdown = file.endsWith(".md");
    const isSource = file.startsWith("src/");
    if (!isMarkdown && !isSource) {
      continue;
    }

    const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const targets = isMarkdown
      ? linkTargets(content)
      : linkTargets(content).concat(seeTargets(content));

    for (const target of targets) {
      if (!isRelative(target)) {
        continue;
      }
      const targetPath = target.split("#")[0];
      if (targetPath.length === 0) {
        continue;
      }
      const resolved = path.resolve(path.dirname(path.join(repoRoot, file)), targetPath);
      if (!fs.existsSync(resolved)) {
        broken.push(`${file} -> ${target}`);
      }
    }
  }

  assert.deepEqual(broken, []);
});

test("no reference to the design record's former home survives", () => {
  const formerHome = "docs/";
  const moved = ["durable-consumer-spec.md", "constitution/"];
  const stale = moved.map((name) => formerHome + name);
  const offenders = [];

  for (const file of trackedFiles()) {
    const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
    for (const reference of stale) {
      if (content.includes(reference)) {
        offenders.push(`${file} mentions ${reference}`);
      }
    }
  }

  assert.deepEqual(offenders, []);
});

test("docs holds the deployment pages and its own rule, and nothing else", () => {
  const entries = fs.readdirSync(path.join(repoRoot, "docs")).sort();

  assert.deepEqual(entries, [
    "README.md",
    "handler-contract.md",
    "inherited-constraints.md",
    "quarantine-pattern.md"
  ]);
});

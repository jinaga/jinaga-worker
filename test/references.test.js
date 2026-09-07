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
const BACKTICKED = /`([^`\s]+)`/g;

const topLevel = new Set(fs.readdirSync(repoRoot));

// A fenced or quoted line carries example material, so the paths in it name
// something other than this tree.
function prose(content) {
  let fenced = false;
  return content
    .split("\n")
    .filter((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return false;
      }
      return !fenced && !/^\s*>/.test(line);
    })
    .join("\n");
}

function comments(content) {
  return content
    .split("\n")
    .filter((line) => /^\s*(\/\/|\/?\*)/.test(line))
    .join("\n");
}

function isRelative(target) {
  return !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("#");
}

// A backticked token names a path in this repository when it carries a slash
// and its first segment is a top-level entry. Prose writes those from the root,
// while a Markdown link is written from the file that holds it.
function references(content) {
  const found = [];

  for (const match of content.matchAll(LINK)) {
    if (isRelative(match[1])) {
      found.push({ target: match[1], fromRoot: false });
    }
  }

  for (const match of content.matchAll(BACKTICKED)) {
    const target = match[1];
    if (target.includes("/") && topLevel.has(target.split("/")[0])) {
      found.push({ target, fromRoot: true });
    }
  }

  return found;
}

test("every path this repository names resolves to a file that exists", () => {
  const broken = [];

  for (const file of trackedFiles()) {
    const isMarkdown = file.endsWith(".md");
    const isSource = file.startsWith("src/");
    if (!isMarkdown && !isSource) {
      continue;
    }

    const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const text = isMarkdown ? prose(content) : comments(content);

    for (const { target, fromRoot } of references(text)) {
      const targetPath = target.split("#")[0];
      if (targetPath.length === 0) {
        continue;
      }
      const base = fromRoot ? repoRoot : path.dirname(path.join(repoRoot, file));
      if (!fs.existsSync(path.resolve(base, targetPath))) {
        broken.push(`${file} -> ${target}`);
      }
    }
  }

  assert.deepEqual(broken, []);
});

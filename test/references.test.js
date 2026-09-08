const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { repoRoot, prose, comments, references } = require("./markdown-references");

function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  return output.split("\0").filter((entry) => entry.length > 0);
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

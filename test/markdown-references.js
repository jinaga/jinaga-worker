const fs = require("node:fs");
const path = require("node:path");

/**
 * The paths a Markdown or source file names, and how to read them.
 *
 * Two tests ask questions about the same set: `references.test.js` asks whether
 * every path in the tree resolves, and `packaging.test.js` asks whether the
 * paths `README.md` names are ones the tarball carries. One reading serves
 * both, so the extraction rules live here.
 */

const repoRoot = path.join(__dirname, "..");

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

module.exports = { repoRoot, prose, comments, references };

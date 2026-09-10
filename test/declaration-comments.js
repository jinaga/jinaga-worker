const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

/**
 * The doc comment a caller reads on one member of one declaration in `dist/`.
 *
 * `dist/*.d.ts` is what an editor shows and what an agent reads out of
 * `node_modules`, so a claim about what a member documents is asked of the
 * built declarations rather than of the source that produced them.
 */

const repoRoot = path.join(__dirname, "..");

/**
 * Prose wrapped behind comment or list markers, on one line with those markers
 * removed, so a sentence can be matched however its site chose to wrap it.
 */
function flatten(content) {
  return content
    .replace(/^\s*(?:\/\*\*|\*\/|\*|-)\s?/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The comment immediately above `member` inside `declaration`, in `dist/<file>`.
 *
 * Adjacency is what makes the comment that member's own. Reading everything
 * above it instead would let a member declared earlier answer in its place, and
 * then deleting the member's own comment would leave the read still passing.
 *
 * `member` is matched as written in the declaration file, so it carries enough
 * of the signature to be unique within the declaration.
 */
function commentAbove(file, declaration, member) {
  const declarations = fs.readFileSync(path.join(repoRoot, "dist", file), "utf8");

  const inside = declarations.split(new RegExp(`\\b(?:interface|class) ${declaration} \\{`))[1];
  assert.ok(inside !== undefined, `dist/${file} declares no ${declaration}`);

  const body = inside.split(/^\}/m)[0];
  const above = body.split(member)[0];
  assert.notEqual(above, body, `${declaration} declares no ${member}`);

  assert.match(
    above.trimEnd(),
    /\*\/$/,
    `the declaration above ${declaration}.${member} is not a doc comment, so it has none of its own`
  );

  const blocks = above.match(/\/\*\*[\s\S]*?\*\//g) ?? [];
  assert.ok(blocks.length > 0, `${declaration}.${member} carries no doc comment`);

  return flatten(blocks[blocks.length - 1]);
}

module.exports = { repoRoot, flatten, commentAbove };

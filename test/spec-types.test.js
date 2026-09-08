const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  BLOCKS,
  isIllustration,
  doublyDisposedBlocks,
  readSpecBlocks,
  repoRoot,
  runGuard,
  specPath,
  staleNames,
  uncoveredNames,
  unregisteredBlocks,
  workspaceRoot
} = require("./spec-guard.js");

const blocks = readSpecBlocks();
const compiled = blocks.filter((block) => !isIllustration(block));

function guardIn(name, { spec = blocks, dist = "../../../dist/index" } = {}) {
  return runGuard(spec.filter((block) => !isIllustration(block)), {
    directory: path.join(workspaceRoot, name),
    dist
  });
}

// The specification's type blocks are the package's published surface, and a
// document is the one artifact nothing compiles. These tests compile it.
test("every ts block in §2 and §3 is compiled, or says in the block that it is not", () => {
  assert.deepEqual(
    unregisteredBlocks(blocks),
    [],
    "a ts block the guard does not compile must open with an `// Illustration:` line"
  );
  assert.deepEqual(
    doublyDisposedBlocks(blocks),
    [],
    "a block marked as an illustration must not also be registered for compiling"
  );
  assert.ok(compiled.length > 0, "no block in §2 or §3 is being compiled at all");
});

test("every declaration a compiled block makes is held to a type of the same name", () => {
  for (const block of compiled) {
    assert.deepEqual(
      uncoveredNames(block),
      [],
      `§${block.section} declares a name the guard neither compares nor accounts for`
    );
    assert.deepEqual(
      staleNames(block),
      [],
      `the guard accounts for a name §${block.section} no longer declares`
    );
  }
});

test("every ts block in §2 and §3 declares the types the package ships", () => {
  const result = guardIn("shipped");
  assert.ok(result.ok, `the specification has drifted from dist/:\n${result.output}`);
});

// The guard holds the document and the code to each other, so it has to fail
// from either side. Both mutations below start from a match, so a rename that
// left the substitution matching nothing fails here rather than passing on a
// mutation it never made. The document writes the variant on one line and the
// emitted declaration writes it over several, so the member is matched in
// either shape.
function withoutFirstAttemptAtOnCompleted(text) {
  const anchor = text.indexOf(`phase: "completed";`);
  assert.notEqual(anchor, -1, "nothing declares a `completed` variant");
  const member = /; firstAttemptAt: number|\n[ \t]*firstAttemptAt: number;/;
  const rest = text.slice(anchor);
  assert.match(rest, member, "the `completed` variant carries no firstAttemptAt to remove");
  return text.slice(0, anchor) + rest.replace(member, "");
}

test("dropping firstAttemptAt from §3.3 fails the guard", () => {
  const drifted = readSpecBlocks(
    withoutFirstAttemptAtOnCompleted(fs.readFileSync(specPath, "utf8"))
  );
  const result = guardIn("spec-mutation", { spec: drifted });
  assert.equal(result.ok, false, "§3.3 lost a member of `completed` and the guard passed");
});

test("dropping firstAttemptAt from the shipped RowState fails the guard", () => {
  const mutated = path.join(workspaceRoot, "shipped-mutation-dist");
  fs.rmSync(mutated, { recursive: true, force: true });
  fs.cpSync(path.join(repoRoot, "dist"), mutated, { recursive: true });

  const declaration = path.join(mutated, "row-state.d.ts");
  fs.writeFileSync(
    declaration,
    withoutFirstAttemptAtOnCompleted(fs.readFileSync(declaration, "utf8"))
  );

  const result = guardIn("shipped-mutation", { dist: "../shipped-mutation-dist/index" });
  assert.equal(result.ok, false, "the shipped RowState lost a member and the guard passed");
});

test("a ts block the extraction cannot compile fails the guard", () => {
  const broken = {
    key: "3.3#2",
    section: "3.3",
    body: "export interface Invented { row: NoSuchType; }",
    entry: {
      preamble: "export {};\n",
      compares: {},
      local: { Invented: "a block the specification does not contain" }
    }
  };
  const result = guardIn("uncompilable", { spec: [...blocks, broken] });
  assert.equal(result.ok, false, "a block that does not compile was not reported");
});

test("a ts block no disposition covers is reported rather than skipped", () => {
  const unregistered = { key: "3.9#1", section: "3.9", body: "export interface Invented { a: string }" };
  assert.deepEqual(unregisteredBlocks([...blocks, unregistered]), ["3.9#1"]);
  assert.ok(BLOCKS[unregistered.key] === undefined);
});

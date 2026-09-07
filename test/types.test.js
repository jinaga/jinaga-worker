const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

// The declaration checks are compile-time, so what pins them is a compile
// rather than a run. `test/types/` holds declarations `defineConsumer` accepts
// and, marked with `@ts-expect-error`, ones it must refuse; a refusal that
// stopped happening leaves its directive unused, which is itself an error.
// So the whole group is one assertion: this compile is clean.
test("the declarations in test/types compile exactly as they are marked", () => {
  const root = path.join(__dirname, "..");
  // The package's `bin` field is where it says its executable is. Its exports
  // map does not expose that path, so resolving the subpath directly fails.
  const manifest = require.resolve("typescript/package.json");
  const tsc = path.join(path.dirname(manifest), require(manifest).bin.tsc);

  let output;
  try {
    output = execFileSync(
      process.execPath,
      [tsc, "--noEmit", "--pretty", "false", "--project", "tsconfig.types.json"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
  }
  catch (error) {
    // tsc reports diagnostics on stdout and exits non-zero, so the failure is
    // what it printed rather than the exit code on its own.
    assert.fail(`the type fixtures did not compile as marked:\n${error.stdout ?? error.message}`);
  }

  assert.equal(output.trim(), "", `tsc reported:\n${output}`);
});

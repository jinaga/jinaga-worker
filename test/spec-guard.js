/**
 * The guard that holds §2 and §3 of the specification to the shipped types.
 *
 * Each `ts` block in those sections is extracted into a generated file, given
 * the preamble it needs to stand on its own, and compiled beside the type of
 * the same name imported from `dist/`. A type-level equality helper does the
 * comparison, so the compiler decides what "the same type" means and there is
 * no model of TypeScript's rules to maintain here.
 *
 * Every block is accounted for. A block the harness does not register fails
 * `unregisteredBlocks`, and a block that declares a name the harness does not
 * compare fails `uncoveredNames`, so drift cannot hide in a block that is
 * quietly skipped. A block that carries example code rather than declarations
 * says so in its own first line, where a reader of the specification sees it.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const repoRoot = path.join(__dirname, "..");
const specPath = path.join(repoRoot, "design", "durable-consumer-spec.md");

/** Where generated sources are compiled. Gitignored, and rewritten per run. */
const workspaceRoot = path.join(__dirname, "spec-guard-workspace");

/** A block whose first line opens with this is example code, not a surface. */
const ILLUSTRATION = /^\/\/ Illustration: \S/;

/** The specifier the real guard imports, from a directory one level in. */
const DIST = "@dist";

const EQUALITY = `
type __Equal<X, Y> =
    (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
type __Expect<T extends true> = T;
`;

/**
 * What each block needs to compile, and what it is compared against.
 *
 * `preamble` supplies the names the block uses but does not declare — the
 * blocks cite `SpecificationRow<U>`, `U`, and each other. `ambient` marks a
 * block whose functions and classes are signatures without bodies, which is a
 * declaration file's shape; the generated module says `declare` so the compiler
 * reads it the same way. `compares` names every declaration held to `dist/`,
 * and `local` names the rest with the reason the package does not export it.
 */
const BLOCKS = {
    "2#1": {
        ambient: true,
        preamble: `import { Consumer, ConsumerOptions, StopReport, WorkerOptions, WorkerStatus } from "${DIST}";\n` +
            `import * as dist from "${DIST}";\n`,
        compares: {
            defineConsumer: ["__Expect<__Equal<typeof defineConsumer, typeof dist.defineConsumer>>"],
            createWorker: ["__Expect<__Equal<typeof createWorker, typeof dist.createWorker>>"],
            Worker: ["__Expect<__Equal<Worker, dist.Worker>>"]
        },
        local: {}
    },
    "2.1#1": {
        preamble: `import { Consumer, Limiter, Logger, NoProgressEvent } from "${DIST}";\n` +
            `import * as dist from "${DIST}";\n`,
        compares: {
            WorkerOptions: ["__Expect<__Equal<WorkerOptions, dist.WorkerOptions>>"]
        },
        local: {}
    },
    "2.2#1": {
        preamble: `import { SpecificationOf, SpecificationRow } from "jinaga";\n` +
            `import { Limiter, NoProgressEvent } from "${DIST}";\n` +
            `import * as dist from "${DIST}";\n` +
            `interface Completion { type: "Test.Completion" }\n` +
            `interface Quarantined { type: "Test.Quarantined" }\n` +
            `interface Given { given: string }\n` +
            `interface Projection { projected: string }\n`,
        compares: {
            // Both instantiations: the literal it carries through, and the
            // widened `type` it maps to `never`.
            LiteralType: [
                "__Expect<__Equal<LiteralType<Completion>, dist.LiteralType<Completion>>>",
                "__Expect<__Equal<LiteralType<{ type: string }>, dist.LiteralType<{ type: string }>>>"
            ],
            CompletionConstructor: [
                "__Expect<__Equal<CompletionConstructor<Completion>, dist.CompletionConstructor<Completion>>>"
            ],
            // The second instantiation leaves `Q` to its default, so a default
            // that went missing on either side is a compile error rather than a
            // comparison that passes.
            ConsumerOptions: [
                "__Expect<__Equal<ConsumerOptions<[Given], Projection, Completion, Quarantined>, " +
                    "dist.ConsumerOptions<[Given], Projection, Completion, Quarantined>>>",
                "__Expect<__Equal<ConsumerOptions<[Given], Projection, Completion>, " +
                    "dist.ConsumerOptions<[Given], Projection, Completion>>>"
            ],
            RetryPolicy: ["__Expect<__Equal<RetryPolicy, dist.RetryPolicy>>"]
        },
        local: {}
    },
    "2.2#2": {
        preamble: "declare class Invitation {}\nexport {};\n",
        compares: {},
        local: {
            InvitationMirrored: "the fact class the idiom illustrates, which the application owns"
        }
    },
    "2.3#1": {
        preamble: `import * as dist from "${DIST}";\n` +
            `interface Projection { projected: string }\n`,
        compares: {
            NoProgressEvent: [
                "__Expect<__Equal<NoProgressEvent<Projection>, dist.NoProgressEvent<Projection>>>",
                "__Expect<__Equal<NoProgressEvent, dist.NoProgressEvent>>"
            ],
            FailedEvent: ["__Expect<__Equal<FailedEvent<Projection>, dist.FailedEvent<Projection>>>"],
            StalledEvent: ["__Expect<__Equal<StalledEvent<Projection>, dist.StalledEvent<Projection>>>"]
        },
        local: {
            NoProgress: "the members the two events share, which the package does not export"
        }
    },
    "2.4#1": {
        ambient: true,
        preamble: `import * as dist from "${DIST}";\n`,
        compares: {
            StopReport: ["__Expect<__Equal<StopReport, dist.StopReport>>"],
            WorkerStatus: ["__Expect<__Equal<WorkerStatus, dist.WorkerStatus>>"],
            ConsumerStatus: ["__Expect<__Equal<ConsumerStatus, dist.ConsumerStatus>>"],
            // A class carries its private state in its instance type, and the
            // block publishes the surface a caller sees. `keyof` is that
            // surface, and the constructor is compared on its parameters.
            Limiter: [
                "__Expect<__Equal<Pick<Limiter, keyof Limiter>, Pick<dist.Limiter, keyof dist.Limiter>>>",
                "__Expect<__Equal<ConstructorParameters<typeof Limiter>, ConstructorParameters<typeof dist.Limiter>>>"
            ]
        },
        local: {}
    },
    "3.3#1": {
        preamble: `import { SpecificationRow } from "jinaga";\n` +
            `import * as dist from "${DIST}";\n` +
            `interface Projection { projected: string }\n`,
        compares: {
            RowState: ["__Expect<__Equal<RowState<Projection>, dist.RowState<Projection>>>"]
        },
        local: {}
    }
};

/** §2 and §3: the sections that publish the package's types. */
function specSections(content) {
    const lines = content.split("\n");
    const start = lines.findIndex(line => /^## 2\. /.test(line));
    const end = lines.findIndex(line => /^## 4\. /.test(line));
    if (start < 0 || end < 0 || end < start) {
        throw new Error("the specification no longer has a §2 that runs to a §4");
    }
    return lines.slice(start, end);
}

/**
 * Every `ts` block in §2 and §3, keyed by the section it sits in and its place
 * within that section.
 */
function readSpecBlocks(content = fs.readFileSync(specPath, "utf8")) {
    const blocks = [];
    const seen = new Map();
    let section = null;
    let open = null;

    for (const line of specSections(content)) {
        const fence = /^```(.*)$/.exec(line);
        if (fence !== null) {
            if (open === null) {
                open = { language: fence[1].trim(), body: [] };
            }
            else {
                if (open.language === "ts") {
                    const ordinal = (seen.get(section) ?? 0) + 1;
                    seen.set(section, ordinal);
                    blocks.push({
                        key: `${section}#${ordinal}`,
                        section,
                        body: open.body.join("\n")
                    });
                }
                open = null;
            }
            continue;
        }
        if (open !== null) {
            open.body.push(line);
            continue;
        }
        const heading = /^#{2,3}\s+(\d+(?:\.\d+)*)\.?\s/.exec(line);
        if (heading !== null) {
            section = heading[1];
        }
    }

    if (open !== null) {
        throw new Error("a fenced block in §2 or §3 is never closed");
    }
    return blocks;
}

function isIllustration(block) {
    return ILLUSTRATION.test(block.body.trimStart());
}

/** The names a block declares at its top level. */
function declaredNames(body) {
    const declaration = /^(?:export\s+)?(?:declare\s+)?(?:interface|type|class|function|enum)\s+([A-Za-z_$][\w$]*)/gm;
    const names = [];
    for (const match of body.matchAll(declaration)) {
        names.push(match[1]);
    }
    return names;
}

/**
 * Blocks the harness neither compiles nor the document marks as illustration.
 * A block in this list is a block that can drift unseen, so the test fails on
 * it rather than passing over it.
 */
function unregisteredBlocks(blocks) {
    return blocks
        .filter(block => BLOCKS[block.key] === undefined && !isIllustration(block))
        .map(block => block.key);
}

/** Illustration blocks the harness also registers: one disposition, not two. */
function doublyDisposedBlocks(blocks) {
    return blocks
        .filter(block => BLOCKS[block.key] !== undefined && isIllustration(block))
        .map(block => block.key);
}

/** Names a registered block declares that the harness neither compares nor excuses. */
function uncoveredNames(block, entry = block.entry ?? BLOCKS[block.key]) {
    const covered = new Set([...Object.keys(entry.compares), ...Object.keys(entry.local)]);
    return declaredNames(block.body).filter(name => !covered.has(name));
}

/** Names the harness accounts for that the block no longer declares. */
function staleNames(block, entry = block.entry ?? BLOCKS[block.key]) {
    const declared = new Set(declaredNames(block.body));
    return [...Object.keys(entry.compares), ...Object.keys(entry.local)]
        .filter(name => !declared.has(name));
}

/**
 * A block's declarations as a module the compiler reads the way a declaration
 * file is read. The specification writes signatures without bodies, which is
 * what `declare` means.
 */
function normalize(body, ambient) {
    return ambient
        ? body.replace(/^(export\s+)?(function|class)\s/gm, (all, exported, kind) =>
            `${exported ?? ""}declare ${kind} `)
        : body;
}

/**
 * The generated module for one block, importing `dist/` at `distSpecifier`.
 * A block may carry its own `entry`, which is how a test hands the machinery a
 * block the specification does not contain.
 */
function guardSource(block, distSpecifier, entry = block.entry ?? BLOCKS[block.key]) {
    if (entry === undefined) {
        throw new Error(
            `§${block.section} carries a ts block the guard has no preamble for: register ` +
            `${block.key} in test/spec-guard.js, or open the block with an "// Illustration:" line`
        );
    }
    const checks = Object.entries(entry.compares).flatMap(([name, expressions]) =>
        expressions.map((expression, index) => `type __check_${name}_${index} = ${expression};`));
    return [
        `// Generated from §${block.section} of design/durable-consumer-spec.md.`,
        entry.preamble.split(DIST).join(distSpecifier),
        normalize(block.body, entry.ambient === true),
        EQUALITY,
        checks.join("\n"),
        ""
    ].join("\n");
}

function fileNameFor(key) {
    return `${key.replace("#", "-")}.ts`;
}

/**
 * Write the generated modules and the project that compiles them. The project
 * extends `tsconfig.types.json`, so the guard reads the blocks under the same
 * compiler options the package is built with.
 */
function writeGuard(directory, sources) {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    for (const [name, source] of Object.entries(sources)) {
        fs.writeFileSync(path.join(directory, name), source);
    }
    const base = path.relative(directory, path.join(repoRoot, "tsconfig.types.json")).split(path.sep).join("/");
    fs.writeFileSync(
        path.join(directory, "tsconfig.json"),
        JSON.stringify({ extends: base, include: ["./**/*.ts"] }, null, 2) + "\n"
    );
    return directory;
}

/** Compile a written guard. `ok` is the whole verdict; `output` is why not. */
function compileGuard(directory) {
    // The package's `bin` field is where it says its executable is. Its exports
    // map does not expose that path, so resolving the subpath directly fails.
    const manifest = require.resolve("typescript/package.json");
    const tsc = path.join(path.dirname(manifest), require(manifest).bin.tsc);
    try {
        const output = execFileSync(
            process.execPath,
            [tsc, "--noEmit", "--pretty", "false", "--project", path.join(directory, "tsconfig.json")],
            { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
        );
        // tsc reports diagnostics on stdout, so an empty exit is not enough.
        return { ok: output.trim() === "", output };
    }
    catch (error) {
        return { ok: false, output: error.stdout ?? error.message };
    }
}

/** Generate, write and compile the blocks a caller hands over, in one call. */
function runGuard(blocks, { directory, dist }) {
    const sources = {};
    for (const block of blocks) {
        sources[fileNameFor(block.key)] = guardSource(block, dist);
    }
    writeGuard(directory, sources);
    return compileGuard(directory);
}

module.exports = {
    BLOCKS,
    ILLUSTRATION,
    compileGuard,
    declaredNames,
    doublyDisposedBlocks,
    fileNameFor,
    guardSource,
    isIllustration,
    normalize,
    readSpecBlocks,
    repoRoot,
    runGuard,
    specPath,
    staleNames,
    uncoveredNames,
    unregisteredBlocks,
    workspaceRoot,
    writeGuard
};

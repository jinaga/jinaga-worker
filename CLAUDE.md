# Working in jinaga-worker

This file is loaded into every conversation. It captures project-wide rules that apply everywhere.

For what the package is and the contract it implements, read `design/durable-consumer-spec.md`. Every structure in that spec is answerable to `design/constitution/degrees-of-freedom-constitution.md`.

Issues labelled `ready` are queued for automated work. `.claude/skills/night-shift-worker/SKILL.md` documents that protocol, and `.night-shift/config.md` carries everything specific to this repository: how to tell whether an issue is already claimed or already landed, how the dependency chain between the implementation slices decides ordering, when to stop and ask a question instead of guessing, how stacked pull requests are opened and registered, and how each run is recorded so the reasoning survives the container.

## Build and test

`npm test` builds first, so it is the whole bar on a fresh clone. Run `npm ci && npm test` green before every push.

## Documentation and code hygiene

- **No reversed-decision reminders.** When a design or mechanism is removed or reversed, rewrite every affected doc, code comment, test, and eval description to describe only current behavior — no "this used to work like X, was removed on \<date>, here's why" asides, no retained "historical record" section standing in for a deleted feature. A fresh reader shouldn't have to figure out which parts of what they're reading are current system behavior versus a resolved argument about a past one; git history and the PR/commit that did the removal already preserve the why.

  **The rationale against the rejected option is itself a reversed-decision reminder.** This is the form the rule is most often broken in, because it does not look like history. Writing "X takes an explicit argument; an implicit one would shift every later argument" keeps the rejected mechanism alive in the reader's head and re-argues a settled question in the reader's way. So does "we do not do X, because X would break Y", "note that X is deliberately not supported", and a warning against a mistake nobody can make anymore. Delete the negation and state the rule: "X takes an explicit argument." A prohibition survives only when a reader can still *do* the prohibited thing. If the mechanism is gone from the system, the argument against it goes with it — into the commit message, which is where the why belongs.

  The one exception: an explicitly temporary, in-flight decision-support doc — one that states its own expiry (e.g. scoped to one implementation effort, discarded once it lands) — may carry a "why we changed direction" note until that effort finishes.

- **No functional scars.** The rule above is about prose; code carries the same mark just as easily. When a mechanism is renamed or replaced — an API cutover, a field rename, an option that moved homes — grep the old identifier across the whole tree, not just the file you touched, and port every match forward or delete it. A function that still checks for a name nobody uses anymore does not error. It quietly stops matching anything, so it returns zero (or an empty record) forever, and that zero ships in every committed baseline as if it were real signal. Sweep for this scar in the same pass that sweeps the reversed-decision prose above.

- **No low-value tests.** A test earns its place by being able to fail for a reason other than someone editing the very thing it quotes. A test whose subject is agreement between two copies of one fact — where the second copy is the assertion itself — cannot. It restates its subject, so the only edit that turns it red is a deliberate edit to that subject, and the only work it creates is a second site to update whenever the first one improves. It makes the thing it guards harder to change while establishing nothing about whether the code is right.

  This is [R5](.claude/skills/refining-issues/SKILL.md) landing in the suite rather than in an issue, and Article 2's diagnostic names it: the same fact maintained in two places. Ask which site is the source of truth. When the assertion is the copy, delete it.

  It is one defect wearing whatever the copied fact happens to be:

  - **Prose.** `assert.match(page, /the sentence the page carries/)`, or the same read out of a doc comment. A document is the source of truth for what it says, and matching a sentence against itself only asserts that nobody has reworded it.
  - **A constant.** An assertion that a default equals the literal the source assigns it, or that a value derived from a constant equals that constant.
  - **A configuration line.** An assertion that a workflow, manifest, or lockfile contains a line it contains. The file is what the tooling reads; a second reading of it adds a site, not a check.
  - **The language or the runtime.** An assertion that an empty `Map` returns `undefined`, that a `const` was not reassigned, or that a test double returns what the test just told it to.
  - **A test that already exists.** Two tests that drive the same branch through different-looking setups are one test. Say which one is the representative and delete the rest.

  The remedy is a check that **derives** one side rather than copying it, so both sides can move and the check still has bite: compile a documented block against the shipped types (`test/spec-guard.js`), resolve a documented path against the filesystem (`test/references.test.js`), read a default back out of the object the factory built. Each of those fails when the *code* changes, which is the failure a document cannot produce on its own. When no derivation is available, the honest answer is that there is nothing worth asserting, and the documentation stands on review.

  A bound is not a copy. `backoffMs` is checked against a ceiling re-derived from the policy, and the assertion is an interval rather than an equality, so a wrong formula fails it. Re-deriving in order to state a property is the method; re-typing in order to state a value is the defect.

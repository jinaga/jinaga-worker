# Working in jinaga-worker

This file is loaded into every conversation. It captures project-wide rules that apply everywhere.

For what the package is and the contract it implements, read `docs/durable-consumer-spec.md`. Every structure in that spec is answerable to `docs/constitution/degrees-of-freedom-constitution.md`.

## Documentation and code hygiene

- **No reversed-decision reminders.** When a design or mechanism is removed or reversed, rewrite every affected doc, code comment, test, and eval description to describe only current behavior — no "this used to work like X, was removed on \<date>, here's why" asides, no retained "historical record" section standing in for a deleted feature. A fresh reader shouldn't have to figure out which parts of what they're reading are current system behavior versus a resolved argument about a past one; git history and the PR/commit that did the removal already preserve the why.

  **The rationale against the rejected option is itself a reversed-decision reminder.** This is the form the rule is most often broken in, because it does not look like history. Writing "X takes an explicit argument; an implicit one would shift every later argument" keeps the rejected mechanism alive in the reader's head and re-argues a settled question in the reader's way. So does "we do not do X, because X would break Y", "note that X is deliberately not supported", and a warning against a mistake nobody can make anymore. Delete the negation and state the rule: "X takes an explicit argument." A prohibition survives only when a reader can still *do* the prohibited thing. If the mechanism is gone from the system, the argument against it goes with it — into the commit message, which is where the why belongs.

  The one exception: an explicitly temporary, in-flight decision-support doc — one that states its own expiry (e.g. scoped to one implementation effort, discarded once it lands) — may carry a "why we changed direction" note until that effort finishes.

- **No functional scars.** The rule above is about prose; code carries the same mark just as easily. When a mechanism is renamed or replaced — an API cutover, a field rename, an option that moved homes — grep the old identifier across the whole tree, not just the file you touched, and port every match forward or delete it. A function that still checks for a name nobody uses anymore does not error. It quietly stops matching anything, so it returns zero (or an empty record) forever, and that zero ships in every committed baseline as if it were real signal. Sweep for this scar in the same pass that sweeps the reversed-decision prose above.

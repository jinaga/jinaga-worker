---
name: refining-issues
description: Turns a backlog issue in jinaga/jinaga-worker into one that an unattended night-shift agent can implement, and turns a coupled set into a chain that stacks. Use when auditing whether an issue is ready for the `ready` label, when grouping issues for planning, when an issue's acceptance ends in an unmade decision, when two issues must land together, when an issue asks for a test that guards a redundancy rather than removing it, or when a change to the spec has just changed how a set of issues is partitioned. Encodes eight checks — five that decide readiness and three that decide independence — plus the five moves that fix a failed check.
---

# Refining issues

An issue is finished refining when an agent holding no context but the issue
body can implement it, and when landing it leaves the tree in a state somebody
would ship.

That is the bar the `ready` label asserts. `.claude/skills/night-shift-worker/SKILL.md`
is what consumes the label: a scheduled agent reads the issue, the spec sections
it names and the constitution articles its conformance criteria cite, and works
it with nobody watching. Refining is what makes that possible. Applying the
label is the maintainer's call, never yours.

Eight checks decide it. Run R1 to R5 against one issue. Run I1 to I3 across a
set. Each failed check has one move.

Do not rewrite an issue that passes. A well-argued problem statement that
already carries testable criteria is done, and adding structure to it costs
review attention for nothing.

## Readiness — run against one issue

### R1. Criteria

Does the issue state acceptance criteria, and can each one fail a test?

A criterion names an observable change. "A consumer whose sweeps fail reports a
rising `sweepFailures`, reset to 0 by one successful pass" is a criterion. "Add
sweep failure reporting to `status()`" is a task.

Fail R1 when the acceptance section is absent, or when it is a checkbox list of
work items, or when a bullet reads "resolved by a decision about X". That last
form is the most common miss, because a decision sitting in the criterion slot
looks like a criterion.

### R2. Capability

Does the issue say what a caller can do after it lands that they cannot do now?

Read the acceptance and answer the question out loud. If the answer is a
restatement of the tasks, the issue describes work rather than an outcome.

R1 and R2 fail independently. An issue can carry twelve well-formed checkboxes
and still never say what changes.

### R3. Premise

If the issue claims a caller *cannot* do something, find the mechanism in code
before you accept the framing.

An issue that opens with a capability gap and then offers directions has often
not proved the gap. Search the package's own user-facing documentation first —
`README.md`, `docs/handler-contract.md`, `docs/inherited-constraints.md`,
`docs/quarantine-pattern.md` — because a capability that exists is usually
documented there already. Then read `src/`.

A wrong premise does not produce a wrong answer. It produces a correct answer
to the wrong question, and every direction under it reads as reasonable. The
cost is a large fix where a small one was needed.

**Two premises are settled here and are not gaps.** Section 9 of
`design/durable-consumer-spec.md` records the decisions taken after the RFC, and
section 10.2 records three tensions accepted as compromises. An issue whose
premise is "the library should not have decided X" or "T2 leaves the language
open" is arguing with an accepted specification. That is a maintainer's
question, not a slice: say so and stop. What survives such an issue is whatever
observable defect it noticed in passing, scoped down to that.

### R4. Anchor

Does the issue name the spec sections it answers to, and carry conformance
criteria that cite the constitution?

The night shift treats the issue body as an index into
`design/durable-consumer-spec.md` and
`design/constitution/degrees-of-freedom-constitution.md`, not as a substitute for
them. An issue that names no section leaves the agent to guess which
requirement it is implementing, and an issue with no conformance criterion can
be satisfied by a change that passes every test and still offends an article.

Fail R4 when either is missing. The fix is to read the spec and supply them, not
to invent a requirement: if no section covers the behavior the issue wants, the
issue is asking for a spec change, which is section 9's territory and a
maintainer's decision.

### R5. Remedy

Does the issue prescribe the remedy its articles prescribe, or a guard over the
defect they name?

R4 asks whether the conformance criteria cite an article. R5 asks whether the
requirement obeys the article it cites. They fail independently: an issue can
name Article 2 correctly and then ask for precisely what Article 2 diagnoses.

The shape is a value written in more than one place, and an acceptance that
asks for a test asserting the copies agree. Article 2's diagnostic names "the
same fact maintained in two places" as the defect itself, and Article 3 answers
it: "The remedy is not a validation check that rejects the state at runtime. It
is a representation in which the state cannot be formed." A test over the
copies leaves every degree of freedom standing and adds one more moving part to
keep.

Ask which copy is the source of truth, and whether the rest can be derived or
deleted. When they can, that deletion is the requirement, and the test that
would have guarded them has nothing left to compare.

Fail R5 when the acceptance's subject is agreement between two representations
of one fact — a runtime validation, a lint, a CI step, or a test — rather than
the removal of one of them. The move is **Remove the freedom**.

Run R5 after R4, because it reads the article the issue cites. An issue that
fails R4 offers nothing to check the requirement against.

## Independence — run across a set

### I1. Reference

Do this issue's acceptance criteria name another issue's outcome?

That is the whole test. Two issues that edit the same file are independent when
neither one's criteria mention the other. Two issues that share no file are
coupled when one's check is satisfiable while the other's hole is open.

Coupling lives in shared invariants. A shared file is not coupling.

When the answer is yes, the coupling has to reach the issue body as a *Depends
on* line. The night shift sequences off that declaration alone and does not
infer order from the files an issue touches, so an undeclared dependency is
invisible to it: two sessions take the coupled pair, both branch from `main`,
and produce conflicting patches for one design. A declared one becomes a stack.

The reverse costs too. A *Depends on* that no criterion needs makes a free issue
wait for a blocked one, and the night shift will honor it.

### I2. Dimension

Does the code this issue reads conflate the axis it cares about with another?

An issue inherits the dimensionality of what it reads. A predicate that ORs two
independent axes into one boolean forces every issue touching it to depend on
both, whether or not it cares about both. The dependency sits in the code rather
than in the work.

This is Article 8 seen from the backlog: hand-maintained consistency across two
sites is one degree of freedom wearing the costume of two, and Part III names
the ripple it produces as coupling. An issue that fails I2 has found surplus
freedom in the representation, and saying which article it offends is usually
the clearest statement of the fix.

Fail I2 when the issue must wait for a decomposition rather than for a
behavior.

### I3. Intermediate

For each order of a coupled pair, is there a state worth shipping in between?

Write the criterion for the halfway point. Usually one order has a coherent
intermediate and the reverse does not, and that asymmetry is the ordering.

The danger this check catches is specific. Whichever issue of a coupled pair
lands first ships a green test suite asserting a partial invariant, and a
passing test that claims coverage it does not have goes into every committed
baseline as real signal.

Once the order is written down, the pair costs nothing in wall-clock: the upper
layer branches from the lower one's branch and opens a stacked pull request, so
neither waits for the other to merge. Ordering is what the night shift needs;
serialization is not.

## The five moves

**Extract a decision.** Several issues stalling on "Directions:" or "Decide
first" are often stalling on one decision in different words. Record it once,
outside all of them, in a design note under `docs/`. Every issue that depended
on it becomes independent with no change to its scope. Answering separately
produces answers that need not agree. When the decision is one the spec already
owns — a default, a vocabulary choice, a division of responsibility — the note
is not yours to write: it is a spec change, and section 9 is where it lands, by
the maintainer.

**Remove the freedom.** When R5 fails, name the source of truth and rewrite the
acceptance as the deletion or derivation of every other copy. The guard the
issue asked for goes with them: with one statement left there is nothing to
compare, which is Article 3's validation that "becomes unnecessary because it
becomes vacuous."

Write two consequences into the issue. Say that no test asserting agreement is
to be added, because an agent reaching for evidence will otherwise supply one
and restore the freedom the issue just removed. And where one of the copies
lives in `design/durable-consumer-spec.md`, deleting it is a spec amendment, so
the issue has to declare itself one in its title and its acceptance:
`.night-shift/config.md` forbids an implementation slice from editing the spec,
and the night shift stops and asks rather than guessing which kind it holds.

**Decompose the axis.** When I2 fails, the fix belongs to whichever issue owns
the separation rather than to the issue that noticed it. Decomposing the predicate is
what makes the other issues perpendicular, so it is scope for the owner rather
than a new issue.

**Define the intermediate criterion.** When I3 finds a coherent halfway state,
give it to the issue that lands first. This converts a must-land-together pair
into a sequence, and it moves the shared invariant out of the gap and into an
issue that owns it. A note reading "whichever lands second must not reopen this"
is prose, and prose does not run.

**Split.** An issue holding more than one concern splits, even when the parts
share a file. Prefer the split when one part is unblocked today and another
waits on a dependency, because bundling makes the free part wait.

## Worked example

`references/worked-example.md` runs R1 to R3, R5, and I1 to I3 plus both
structural moves over one backlog, and closes each with the shape to recognize. The domain
is invented so nothing in it decays as a real backlog is worked. Read it when a
check's description is not enough to recognize what is in front of you.

R4 has no shape section because it is a presence check: the sections are named
or they are not.

## Writing the refined issue

Write the title as the defect, then "so", then the consequence. "`start()` has
no bound, so an unresponsive replicator holds a boot path open."

Body leads with what happened or what the mechanism is, cites the code by path
and line, and closes with acceptance. The sections this backlog uses, in order:
the mechanism in prose; **Measured** or **Demonstrated**, showing the behavior
against a real replicator or `JinagaTest`; **Build** or **Proposal**; **Tests**;
**Conformance**, naming the article each criterion answers to; **Depends on**.

Name the interaction with any issue that shares an invariant, and say which one
must not reopen the gap.

Say plainly what the issue no longer claims when a check removed part of it. A
reader who remembers the old framing needs to know it is gone, and the removed
argument does not belong in the body. This is `CLAUDE.md`'s no-reversed-decision
rule applied to a tracker: the refined issue describes only what is wrong now.

Refining destroys the evidence. An issue that passes the checks no longer shows
the defect that made it fail them, and a tracker keeps no body history a later
reader can reach. GitHub's timeline API returns `renamed` and `labeled` events
and never the previous body.

So an issue is a poor place to point somebody who needs to learn a shape. It is
also a decaying one, because the code a good example quotes is usually the code
the issue deletes. Teach from a constructed case that holds the shape, and keep
the issue number as provenance for a reader who wants the original.

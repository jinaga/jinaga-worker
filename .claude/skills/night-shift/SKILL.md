---
name: night-shift
description: Work the queue of GitHub issues labelled `ready` in jinaga/jinaga-worker, unattended. Use when sweeping for ready issues, deciding which are actually available to work, ordering them, opening a slice as a stacked pull request, or recording a blocking question instead of guessing. Covers the claim rule, the spec-and-conformance bar that replaces reproduction here, the stacked-PR registration step, the stop condition for PR monitoring, and how each run reads and records the Night Shift Log so the reasoning outlives the container and steers the next run.
---

# Night shift: working `ready` issues

This is the protocol for automated work on `jinaga/jinaga-worker`. It exists so a scheduled agent can pick up work at night without a person watching, and so two agents never work the same issue twice.

Read `CLAUDE.md` first. Read `docs/durable-consumer-spec.md` before touching any issue: this repository implements one accepted specification, and every issue names the sections it answers to.

## 0. What is different about this repository

The sibling protocol in `jinaga/jinaga.js` was written for a maintained library whose queue is defect reports. This queue is **implementation slices of a specification that is accepted and unimplemented**. Four things follow, and each one is a place a session that pattern-matches on the sibling will go wrong.

- **There is nothing to reproduce.** An issue here does not describe a defect. Section 4 replaces "reproduce first" with the spec section and the issue's own conformance criteria.
- **Almost everything stacks.** The issues form one dependency chain — #3 → #4 → #5 → #6 → #7 → #8 — declared in each issue's *Depends on*. Sequencing is read off the issues, not inferred from the files they touch.
- **CI has no base-branch filter.** `.github/workflows/ci.yml` triggers on a bare `pull_request:`, so every layer of a stack gets check runs from its own pull request event. The sibling's finding that unregistered upper layers get zero runs is about a workflow filtered on `branches: [main]`. It does not apply here. Register stacks for what they actually buy (section 5), and do not go hunting a missing-checks problem this repository does not have.
- **The constitution is part of the bar.** `docs/constitution/degrees-of-freedom-constitution.md` is the standard the spec is scored against, and each issue carries conformance criteria drawn from it. A change that passes the tests and violates a criterion is not done.

Everything below this section is the same practice as the sibling, adapted.

## 1. Find the queue

**Open** issues labelled `ready` are the queue. Nothing else is in scope. Do not pick up unlabelled issues, and do not add the `ready` label to anything yourself.

The `state` filter is not a nicety, so pass it explicitly (`state: OPEN`) rather than filtering the results afterward. Closing an issue does not remove its labels, so a closed issue keeps `ready` indefinitely, and a queue that admits closed issues re-runs section 2's claim check on each of them every night to reach the conclusion their state already carried.

This repository does strip the label on close (`.github/workflows/clear-ready-on-close.yml`). Do not rely on it. The practice tracks several repositories and that automation is one repository's, while this filter is every sweep's.

## 2. Decide what is actually available: artifacts are the state

The `ready` label alone does not mean an issue is available. Labels go stale, because closing a pull request does not remove them. **The work artifacts are the source of truth, and you check them in this order.**

For each `ready` issue, search pull requests that reference it (by `#<number>` in the title or body, and by branch names matching `claude/issue-<number>-*`):

| What you find | What it means | What to do |
|---|---|---|
| An **open** pull request | Someone is already working it | Skip. Do not start a second session on it. |
| A **merged** pull request | The slice already landed | **Do not re-implement.** Verify it against the issue's conformance criteria. See below. |
| A **closed, unmerged** pull request | An attempt was abandoned | Read it before starting. It usually records why. |
| An unmerged branch on `origin` with no pull request | Work in progress, or abandoned | Read the branch. Build on it rather than starting over. |
| Nothing | Genuinely available | Work it, if its dependencies have landed. See section 3. |

### Read merge state from `merged_at`, never from `merged`

The table's top three rows turn on one distinction, and the field named for it does not carry it. GitHub's list-pull-requests response is a **subset** of the single-pull-request response, omitting `merged` along with `mergeable`, `merged_by` and the diff counts. A list tool renders every row through one schema regardless, so a field the response never carried surfaces as its zero value, `false`, on every row alike. Nothing is reporting a wrong answer. A question that was never asked is showing a default.

`merged_at` is in the list response, and it is populated.

A merged pull request read through `merged` therefore arrives as `state: closed, merged: false`, which is the **closed, unmerged** row: *an attempt was abandoned, read it before starting.* That sends the next session to redo work that already shipped.

So treat a non-null `merged_at` as merged, or confirm with a per-pull-request read. Do not branch on `merged` from a list response.

### When a merged pull request exists

Your job changes from *implement* to *verify*, and that is a complete and valuable outcome. Do not manufacture a change to justify the session.

1. Read the merged diff.
2. Enumerate the issue's conformance criteria and its test list, separately. A slice often satisfies the tests and misses a criterion.
3. Check each against current `main` and record a verdict per item.
4. If everything holds: open a pull request carrying only the coverage that is still missing, or open none at all. Then comment on the issue with your per-item verdicts and evidence, and recommend closing.
5. If part is missing: supply that part, and say plainly in the pull request which items the earlier work covered and which yours adds.
6. If verification is complete but one item needs a judgment you cannot make unattended — a spec ambiguity, a naming decision the maintainer owns — take the question swap in section 6.

**Never close an issue yourself, and never remove the `ready` label from an issue you believe is resolved.** Recommend, and let the maintainer decide. The one label change you may make is the question swap in section 6.

## 3. Order the work

### Read the log before you sequence

The Night Shift Log is where corrections to this protocol's own heuristics live. Read it before sequencing anything:

- `correctedVerdicts` — conclusions a later run disproved, and where the disproof came from.
- The most recent sweep's `considerationsInSweep` — what was dispatched, on what rationale, and what came of it.

Section 8 has the mechanics. This is a read for **reasoning**, never for availability: GitHub remains the only authority on what is claimed, and section 2's check still runs in full against it.

### Sequencing

Each issue declares its dependencies. Honour them: a slice whose dependencies have not merged and are not in the stack below it cannot be verified, because the tests it must pass exercise code that does not exist yet.

Do not parallelise across the chain. Every issue from #3 to #8 touches `src/index.ts` and the same test tree, so two sessions working different slices produce conflicting patches for one design. If two issues are genuinely independent — a docs-only slice, say — work them in parallel and say so.

An issue whose dependencies are unmet is **not available**. Skip it and record the skip with that reason; it is not a claim conflict and should not be recorded as one.

### How much to take

There is no fixed budget, and you should not invent one silently. Take what you can carry through section 4's full bar. **Say in your report, and in every skip rationale that leans on it, what budget you chose and why.** A skip reason is only evidence if the constraint behind it is stated.

## 4. Work the issue

**Read the spec sections the issue names, and the constitution articles its conformance criteria cite.** These are the requirements. The issue body is an index into them, not a substitute.

Then implement, with the tests the issue lists. Each test should fail before your change and pass after. Keep the change minimal, and keep it inside the slice: the chain only works if each layer stops where the next begins. Record anything you notice beyond the issue's scope as a note in the pull request rather than widening the diff.

Before you push, walk the issue's conformance criteria one at a time and say in the pull request how the change satisfies each. A criterion you cannot answer is a blocking question (section 6), not a thing to leave for review.

Run `npm ci && npm test` green before every push. `npm test` builds first, so it is the whole bar.

Two rules from `CLAUDE.md` bind every change here: no reversed-decision reminders, and no functional scars. If your slice replaces a mechanism, grep the old identifier across the whole tree and port every match forward or delete it.

## 5. Open the pull request, stacked

Branch name: `claude/issue-<number>-<slug>`.

When your issue is sequenced behind another, branch from **that issue's branch**, not from `main`, and open your pull request with its base set to that branch. This is a stacked pull request. It lets the chain proceed without waiting for anything to merge, and GitHub retargets each pull request to `main` automatically as the bases land.

### Register the stack

Registration gives branch protections, required checks and CODEOWNERS evaluated against `main`, a stack map for reviewers, and bottom-up atomic merge. It is not what makes CI run here (section 0). Register as soon as the second pull request in a chain exists.

There is no MCP tool for the Stacks API. Use the committed script, which is pre-approved for this repository:

```
./scripts/register-stack.sh list                                 # inspect existing stacks
./scripts/register-stack.sh create <lower-pr> <upper-pr> [...]   # bottom to top, min 2
./scripts/register-stack.sh add <stack-number> <pr>              # append above the current top
```

### Confirm CI actually ran, by event

A green check is not evidence until you know what triggered it. Read the run's `event`, not only its `conclusion`, and scope the lookup to one commit and one workflow.

**`gh` is not installed in the routine environment**, so use `mcp__github__actions_list` with `workflow_id: "ci.yml"` and the head SHA, and read `event` and `conclusion` off each run. In a local session with `gh` available, the same question is:

```
gh api "repos/jinaga/jinaga-worker/actions/workflows/ci.yml/runs?head_sha=<sha>" \
  --jq '.workflow_runs[] | "\(.event)/\(.conclusion)"'
```

Either way, address the workflow by its **file**, not by matching a display name: a run's `name` is the *run* name, which a workflow can override with `run-name:`, and a name filter that stops matching returns nothing, which reads exactly like "CI never ran."

Expect `pull_request` on every layer. If a layer shows no run at all, the sanctioned move is `workflow_dispatch` on `ci.yml` (`mcp__github__actions_run_trigger`) — say in your report that you dispatched it, and treat it as a finding worth a note, because on this repository it should not be necessary.

**Never push an empty commit, and never close and reopen a pull request, to provoke a run.**

## 6. When to stop and ask instead

Record a blocking question when proceeding either way could produce the wrong implementation and you cannot settle it from the spec, the constitution, the tests, or the issue text. A question about a detail you can work around is not blocking: do everything that does not depend on the answer first.

The spec is accepted, so a genuine gap in it is a question, not a licence to decide. Section 10 of the spec records three tensions that are already settled as compromises — those are not gaps, and reopening one is out of scope for a night run.

To record one:

1. Comment on the issue. State what you found, why it blocks you, the candidate answers, and what you would do under each. Make it answerable in one reply. If a pull request already exists, post it there too and link it from the issue comment.
2. Remove the `ready` label and add `question`.
3. Stop. Do not guess and push a speculative implementation.

The label swap moves the issue out of the queue, so the next night's sweep will not pick it up again while it waits on an answer.

## 7. Monitor the pull request, then stop

After opening a pull request:

1. Subscribe to its activity.
2. Request a GitHub Copilot review.
3. Drive CI to green. A red check on your own pull request is work now, at every wake: diagnose, fix, push. Never skip, disable, or quarantine a test to get green. If a failure is genuinely not yours, meaning it is red on the base branch too, say so in one comment rather than going silent.
4. Complete **one round** with Copilot. Address every suggestion with a pushed commit, or reply on the thread explaining why it is wrong or out of scope. Resolve the threads you addressed.

**Stop when CI is green on the current head and that one Copilot round is complete.** Then unsubscribe. Do not cycle into further rounds.

Until both conditions hold, schedule a check-in roughly an hour out before ending a turn, and re-arm it each time.

**Check-run events name a stale head.** Always re-read the pull request's own head before concluding anything about its state, and treat the event as a nudge to look rather than as a report of what is true.

## 8. Read and record the run in the Night Shift Log

A run that leaves no trace teaches nothing, and a run that reads no trace repeats. GitHub keeps the artifacts — a pull request, a comment, a label — but not the judgments: what you considered and passed over, why you ordered the work as you did, what a verdict rested on. Those die with the container unless you record them, and they help nobody unless the next run reads them.

They go in the **Night Shift Log**, a Jinaga application reached through the Factual MCP server. Open a console, run `applications`, and open the one whose routing matches; its manifest carries the full action catalog with argument guidance, so read `describe` there rather than relying on this list.

The shape of a run, in the order the run performs it:

1. `practicesForAdministrator($me)` — the entry point, before section 2. Find the repository whose current name is `jinaga/jinaga-worker` and take its `repositoryRef`. If no practice or no matching repository exists, **stop and say so**. `createPractice` and `registerGitHubRepository` are one-time setup, and calling them speculatively mints duplicates that split the history.
2. `startSweep($repository, $headCommit)` once, before examining anything.
3. `correctedVerdicts`, and the previous sweep's `considerationsInSweep` by way of `sweepsInRepository`, before you sequence.
4. Per issue: `considerIssue`, then exactly one finding action — `findOpenPullRequest`, `findMergedPullRequest`, `findClosedPullRequest`, `findBranch`, or `findNoPriorWork` — matching what section 2's claim check turned up.
5. Then `dispatchWork` (with the ordering argument in `rationale`) or `skipIssue`. Creating the fact *is* the decision; there is no decision value to set.
6. Per dispatch, when it finishes: `openPullRequest`, `raiseQuestion`, or `findNoChange`.
7. Later, when a question is answered or a verdict turns out wrong: `answerQuestion`, or `correctVerdictFromWork` naming the consideration whose work produced the disproof.

Two rules about what goes in:

- **Record what you skipped, not just what you worked.** A skip with its reason is the evidence the claim rule is working, and it is the only record that an issue was looked at at all. An unmet dependency is a skip reason worth recording every time, because the chain here makes it the common case.
- **Never record availability.** GitHub is the queue and the only authority on what is currently ready. The log holds what was observed and decided, and when.

If the Factual server is unreachable, do the GitHub work anyway and say in your final report that the run went unrecorded. A missing log entry is a gap; a blocked run is a worse one.

## 9. Hard limits

- Never push to `main`, and never push to another session's branch.
- Never merge a pull request.
- Never close an issue, and never remove `ready` except as part of the question swap.
- Never skip, disable, or quarantine a test to get a green build.
- Never push an empty commit to re-trigger CI.
- Never edit `docs/durable-consumer-spec.md` or the constitution to make an implementation conform. The spec is the requirement; a change to it is a maintainer's decision and a question under section 6.
- Never put a mutating call in a retry or fallback position. A shell `cmd-a || cmd-b` runs `cmd-b` when `cmd-a` merely prints something unexpected, and a "test" invocation of a create endpoint is a real write.
- End every GitHub comment with the Claude Code attribution footer.
- Do not put model identifiers in commit messages, pull request text, or code comments.

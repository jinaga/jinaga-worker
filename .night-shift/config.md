# Night shift configuration

The `night-shift-worker` and `night-shift-coordinator` skills read this file.
Every `##` heading below except `## Branch prefix` is required. A missing
heading is an error, not a default: stop and name the heading you could not
find. Anything that is not one of these headings is protocol, and protocol
lives in the skill.

## Visibility

`public`

There is nothing to withhold here. One sibling repository in this practice is
private, so never carry its contents into an issue or pull request in this one.

## Issue label

`ready`

## Read first

- `CLAUDE.md` — layout, build, and conventions.
- `design/durable-consumer-spec.md` — the accepted specification this
  repository implements. Every issue names the sections it answers to.
- `design/constitution/degrees-of-freedom-constitution.md` — the standard the
  spec is scored against. Each issue's conformance criteria are drawn from it.

Read the spec sections the issue names, and the constitution articles its
conformance criteria cite. Those are the requirements. The issue body is an
index into them, not a substitute.

## Before you fix

**There is nothing to reproduce.** An issue here does not describe a defect. It
describes a slice of an accepted specification that is not implemented yet, so
the usual reproduce-first step does not apply and its absence is not a finding.

What replaces it is the spec section the issue names and the issue's own
conformance criteria. A change that passes the tests and violates a criterion
is not done.

**Never edit `design/durable-consumer-spec.md` or the constitution to make an
implementation conform.** The spec is the requirement. A change to it is a
maintainer's decision, so raise it as a blocking question and stop.

That prohibition governs an implementation slice. It does not govern an issue
whose stated job *is* to amend the spec — those exist, and they say so in the
title and in their acceptance criteria. Read which kind you were handed before
you decide whether the spec is off limits.

## Verification commands

Green before every push, in this order.

```
npm ci
npm test
```

`npm test` builds first, so those two are the whole bar. The container starts
with no `node_modules`, so `npm ci` is not optional.

## CI workflow

`ci.yml`

Read runs for this file; it is the merge gate. It triggers on a bare
`pull_request:` with no `branches:` filter, so every layer of a stack gets
check runs from its own pull request event. Register a stack for what
registration actually buys, not to make checks appear.

## After the pull request

`none`

## What is different about this repository

**Almost everything stacks.** The issues form one dependency chain, and each
issue declares its own place in it with a `Depends on #<n>` line. Sequencing is
read off the issues rather than inferred from the files they touch, so read the
clause on the issue rather than guessing from a diff.

`clear-ready-on-close.yml` removes the `ready` label when an issue closes. Do
not rely on it: always filter for open issues.

# Contributing to jinaga-worker

## What this package implements

`jinaga-worker` is the package proposed in
[jinaga/jinaga.js#251](https://github.com/jinaga/jinaga.js/issues/251).
[The specification](design/durable-consumer-spec.md) is the implementation
contract, and it is the requirement a change answers to: accepted, and ahead of
the code. Every structure in it is scored against
[the constitution](design/constitution/degrees-of-freedom-constitution.md), whose
articles an issue's conformance criteria cite by number.

The design record is not addressed to someone installing the package, so it
stays out of the published tarball. `docs/` is the user's half, and
[`docs/README.md`](docs/README.md) states what belongs there.

## The peer dependency

The package takes `jinaga` as a peer dependency, pinned in `package.json`. The
floor is the release carrying the row-stream seam — `queryRows` and
`subscribeRows` — from
[jinaga/jinaga.js#250](https://github.com/jinaga/jinaga.js/issues/250).

## Build and test

Run `npm ci && npm test`. `npm test` builds first, so it is the whole bar on a
fresh clone, and it is what `.github/workflows/ci.yml` runs on a pull request.
`.github/workflows/publish.yml` holds the publish gate.

Two rules from jinaga.js's `contributing.md` apply to the tests here: no
arbitrary timeouts, and test at the level of the mechanism. A green end-to-end
run does not establish that a feed decomposition or a distribution rule works
against a real replicator.

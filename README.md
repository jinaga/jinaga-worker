# jinaga-worker
Worker process that services a Jinaga queue

## What the library does

A durable consumer's outstanding work is a specification. A row leaves the set
when a fact is written about it — a completion on the happy path, a quarantine
on the failure path — so progress lives in the fact graph and a restart has no
cursor to recover. `defineConsumer` declares a consumer, and `createWorker` runs
a fixed set of them.

- **Discovery.** The row stream and the backstop sweep funnel into one admission
  gate, deduplicated on `rowHash`.
- **Dispatch.** A row is handled on its own turn, under a concurrency budget and
  a handler deadline, with the backoff between attempts read from a
  `RetryPolicy`.
- **Non-progress.** A row that runs out of attempts is quarantined and reported
  once through `onNoProgress`, as `failed` or as `stalled`.

## Before you deploy a worker

- [The handler contract](docs/handler-contract.md): what `handle` is promised,
  and why it has to be idempotent
- [The quarantine pattern](docs/quarantine-pattern.md): the fact type, the
  condition, the group, and what declining the pattern costs
- [Constraints inherited from jinaga](docs/inherited-constraints.md): platform
  properties that are silent when violated
- [Starting a worker](docs/starting-a-worker.md): which shape of boot path to
  write around `start()`, and what each one costs

## Contributing

[CONTRIBUTING.md](https://github.com/jinaga/jinaga-worker/blob/main/CONTRIBUTING.md)
carries the specification this package implements, the constitution it answers
to, and how to build and test the repository.

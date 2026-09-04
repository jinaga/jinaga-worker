# jinaga-worker
Worker process that services a Jinaga queue

## Status

This repository is scaffolded for RFC #251 in `jinaga/jinaga.js`:
- TypeScript package build output (`dist`)
- Peer dependency on `jinaga` ^6.12.0, which is where the row-stream seam
  (`queryRows`, `subscribeRows`) landed — see jinaga/jinaga.js#250
- `defineConsumer` and `createWorker`: the consumer declaration and the worker
  lifecycle from [the specification](docs/durable-consumer-spec.md)
- Discovery: the row stream and the backstop sweep, funnelled into one
  admission gate and deduplicated on `rowHash`
- Dispatch: on its own turn, under a concurrency budget and a handler deadline,
  with the backoff between attempts read from a `RetryPolicy`
- CI workflow for build + test
- Publish workflow scaffolded but intentionally disabled

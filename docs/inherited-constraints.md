# Constraints inherited from jinaga

These are properties of the platform the worker runs on, not choices this
package made. Each one is silent when violated: the worker keeps running, the
logs stay clean, and no work gets done. That is why they are written down here
rather than left to be discovered.

## The given must be byte-stable across restarts

`RowObserver` hashes the given once and filters every notification against that
hash. A given that differs by any field after a restart sends both discovery
paths silently empty: the stream delivers nothing and the sweep returns nothing,
which looks exactly like an empty backlog. A given derived from
`beginSingleUse` will not work.

Every consumer logs its given hash at startup. Compare that line across restarts
when a worker goes quiet.

## A purgeable fact type needs its purge condition

Purge conditions are checked on every read and every subscribe. A specification
over a purgeable fact type must carry the purge condition's `notExists`, or
every sweep throws.

## Notifications are unordered

`ObservableSource.notify` fans out with `Promise.all` and discards the
topological order the envelopes arrived in. Two facts about where that sits make
it safe here: `FactManager.save` persists the whole batch before it calls
`notify`, and each listener re-reads storage, so every notification sees every
fact of the batch whatever the delivery order. A row therefore reaches the
stream complete, at the moment its last constituent fact is saved, and the order
decides only which of two redundant deliveries lands first.

The loop is order-insensitive by construction. Two things still follow for you:
never infer "the parent completed before this child appeared" from delivery
order, and read [the handler contract](handler-contract.md), because the one
place the absence of order is visible is a stale `added` behind a `removed`,
which dispatches a row that has already left the set.

## Nested projections are not observed

Only root-path inverses are registered, so a projected collection is a snapshot
from when the row's own notification fired. Do not project a collection a
handler needs current. Make it a layer with its own consumer, whose stage
becomes eligible when the parent's completion fact is written.

## Distribution splits loud and silent

A structural denial throws `DistributionDeniedError`, and the worker fails to
start. That is the loud half, and it is the right outcome: a worker not
authorized for its own specification should not idle.

The silent half is a `reactive: true` diagnostic. It means the subscription
race: the feed is denied for this principal right now and will self-heal once
the authorizing fact arrives. It must never be treated as fatal, and a worker
that swallows it looks exactly like a worker with no work. The worker registers
`j.onDistributionDiagnostic` before its first subscribe and reports each
`(feed, code)` once: a `reactive` decision as a warning, and a denial that will
not self-heal as an error. A feed that begins delivering retires its report, so
a decision raised again later is reported again.

## An unbounded start waits as long as the replicator takes

`subscribeRows` awaits the feed's first response, so a replicator that
accepts the connection and never answers leaves `start()` pending
indefinitely. Do not await `start()` in a boot path unless the process is
supposed to fail when the replicator is unreachable. A service whose routes
read its own local mirror holds every one of them behind that wait,
`/health` included.

That wait is what a worker does when it is given no bound, and it is its own
recovery: the same call is answered when the replicator returns, with nothing
torn down and nothing rebuilt. A boot path that would rather wait a fixed
while sets `startTimeoutMs`, which bounds the whole `start()` call and rejects
with jinaga's `FeedTimeoutError`, releasing every stream and sweep timer.

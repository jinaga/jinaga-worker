# The handler contract

A consumer's `handle` is the only place your application does the work a row
represents. This page states what the library guarantees about how it is
called, and what it requires of you in return.

```ts
handle: (row: SpecificationRow<U>) => Promise<void>
```

## The handler writes the completion fact

The library never writes a fact. A row leaves the outstanding set when your
application writes a fact that the specification's `notExists` excludes, and
writing it is part of handling the row:

```ts
handle: async row => {
    await repo.upsertInvitation(pool, row.result, row.rowHash);
    await j.fact(new InvitationMirrored(row.result));
}
```

Resolving means the completion fact is written. A handler that resolves without
writing it leaves the row outstanding, so the next sweep returns it again, and
after `retry.maxAttempts` such rounds the worker reports the consumer as
`stalled`.

## The handler must be idempotent

A row can be dispatched to your handler more than once, and two dispatches of
the same row can overlap. There are two mechanisms behind this, and neither is
avoidable from inside the library.

**An abandoned timeout.** An attempt is bounded by `handlerTimeoutMs`.
JavaScript offers no way to cancel a promise, so the bound abandons the *wait*
and the handler keeps running. The abandoned attempt counts as a rejection, the
row goes to `waiting`, and the next attempt starts while the first one is still
in flight. Two runs of your handler for one row overlap, in the same process.

**A stale addition.** Notifications are unordered. One save that carries both a
row's source fact and its completion fact produces an `added` change and a
`removed` change whose arrival order is undefined, and a feed catch-up after a
restart delivers exactly that graph. When the `removed` lands first it clears
the row from the consumer's map, and the `added` behind it finds no entry and is
admitted. Your handler runs again for a row that is already complete.

So make the handler safe to run twice:

- `j.fact` is already idempotent. Facts are content-addressed, so saving the
  same completion fact twice saves one fact.
- Give every write outside the graph a key. `row.rowHash` identifies the row,
  and an upsert on it turns a second run into a no-op.
- Do not treat "I already did this" as an error. A second run that finds its
  work done should resolve, not reject; a rejection here spends an attempt and
  moves the row toward quarantine.

## Rejection

A rejected promise and a thrown exception are the same failure, and a handler
that exceeds `handlerTimeoutMs` is a rejection too. Each one spends an attempt
and schedules the next one from the consumer's `RetryPolicy`. After
`maxAttempts` rejections the row is quarantined and the worker emits a `failed`
event. See [the quarantine pattern](quarantine-pattern.md).

## Where the handler runs

The handler never runs on the notification turn. The row stream's listener only
offers the row; the consumer's own turn acquires a slot from the limiter and
runs the handler. The slot is held for the attempt and released before any
backoff wait, so a row waiting to retry does not occupy concurrency that another
row could use.

The limiter is what bounds the pressure your handlers put on a connection pool,
so size it below the pool. A handler that waits on something without a bound
holds its slot for as long as it waits.

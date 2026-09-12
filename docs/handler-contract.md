# The handler contract

A consumer's `handle` is the only place your application does the work a row
represents. This page states what the library guarantees about how it is
called, and what it requires of you in return.

```ts
completes: CompletionConstructor<C>
handle: (row: SpecificationRow<U>) => Promise<C>
```

## The handler returns the completion fact

A row leaves the outstanding set when a fact the specification's `notExists`
excludes reaches the store. Your handler builds that fact and returns it; the
library asserts it.

```ts
completes: InvitationMirrored,
handle: async row => {
    await repo.upsertInvitation(pool, row.result, row.rowHash);
    return new InvitationMirrored(row.result);
}
```

`completes` is the constructor of the fact `handle` returns, declared alongside
it. The library cannot read a closure's return value, and the fact's type is
erased at runtime, so this is what carries the fact's identity to the
declaration. The class supplies it in jinaga's own idiom:

```ts
class InvitationMirrored {
    static Type = "Blog.Invitation.Mirrored" as const;
    type = InvitationMirrored.Type;
    constructor(public invitation: Invitation) {}
}
```

The `as const` is what makes `Type` a literal rather than `string`. A class
without it is refused where you write it, because a widened type carries nothing
to check.

Two mistakes are compile errors rather than runtime surprises: a handler that
resolves without producing a fact, and one that returns a fact of a type other
than the one `completes` names.

A third is caught when you declare the consumer. `defineConsumer` inverts your
specification to find the fact types that take a row out of it, and throws when
`completes` names none of them — a specification carrying no `notExists` at all,
or one whose condition names a different fact. The message names the type you
declared and the types the specification does retire on.

What that leaves is a fact of the declared type written against the wrong
predecessor. It is type-correct, it retires some other row, and the library
cannot see it: the library does not know which member of your projection should
hold the row. That one reaches `maxAttempts` and reports as `stalled`.

The report is where you diagnose it. A `stalled` event carries
`completionType`, the type you declared; `retiringTypes`, the types your
specification retires a row on; and `completionHash`, the fact the library
stored on the attempt that gave up. The first is among the second, so the
specification's shape is right and the fact was written. Resolve the hash and
read that fact's predecessors: they name the row it retired, which is not the
row your handler was given.

## The attempt ends when the fact is stored

The attempt spans your handler and the library's write together, and
`handlerTimeoutMs` bounds both. The row reaches `completed` when the fact is in
the store, not when your handler returns.

So a write the replicator refuses — an authorization rule that does not admit
the worker's principal, say — is a rejection of the attempt. It spends an
attempt, the row is retried on backoff, and after `maxAttempts` the worker
reports `failed` carrying the refusal.

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

- The completion fact is already idempotent. Facts are content-addressed, so
  asserting the same one twice stores one fact.
- Give every write outside the graph a key. `row.rowHash` identifies the row,
  and an upsert on it turns a second run into a no-op.
- Do not treat "I already did this" as an error. A second run that finds its
  work done should return its completion fact, not reject; a rejection here
  spends an attempt and moves the row toward quarantine.

## Rejection

A rejected promise and a thrown exception are the same failure, and a handler
that exceeds `handlerTimeoutMs` is a rejection too. Each one spends an attempt
and schedules the next one from the consumer's `RetryPolicy`. After
`maxAttempts` rejections the row is quarantined and the worker emits a `failed`
event. See [the quarantine pattern](quarantine-pattern.md).

## Where the handler runs

The handler never runs on the notification turn. The row stream's listener only
offers the row; the consumer's own turn acquires a slot from the limiter and
runs the handler. The slot is held for the attempt — the handler and the write
that ends it — and released before any backoff wait, so a row waiting to retry
does not occupy concurrency that another row could use.

The limiter is what bounds the pressure your handlers put on a connection pool,
so size it below the pool. A handler that waits on something without a bound
holds its slot for as long as it waits.

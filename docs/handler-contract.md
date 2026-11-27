# The handler contract

A consumer's `handle` is the only place your application does the work a row
represents. This page states what the library guarantees about how it is
called, and what it requires of you in return.

```ts
completes: Completions<C>
handle: (row: SpecificationRow<U>) => Promise<NoInfer<C[number]>>
```

## The handler returns the completion fact

A row leaves the outstanding set when a fact the specification's `notExists`
excludes reaches the store. Your handler builds that fact and returns it; the
library asserts it.

```ts
completes: [InvitationMirrored],
handle: async row => {
    await repo.upsertInvitation(pool, row.result, row.rowHash);
    return new InvitationMirrored(row.result);
}
```

`completes` is a non-empty tuple of the constructors of the facts `handle`
returns, declared alongside it. The library cannot read a closure's return
value, and a fact's type is erased at runtime, so this is what carries those
facts' identities to the declaration. Each class supplies it in jinaga's own
idiom:

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
resolves without producing a fact, and one that returns a fact of a type outside
the declared set. An empty `completes` is one too — a consumer that can never
retire a row.

A third is caught when you declare the consumer. `defineConsumer` inverts your
specification to find the fact types that take a row out of it, and throws for
each declared type that is none of them — a specification carrying no
`notExists` at all, or one whose condition names a different fact. The message
names the type it refused and the types the specification does retire on.

What that leaves is a fact of a declared type written against the wrong
predecessor. It is type-correct, it retires some other row, and the library
cannot see it: the library does not know which member of your projection should
hold the row. That one reaches `maxAttempts` and reports as `stalled`.

The report is where you diagnose it. A `stalled` event carries
`completionType`, the type of the fact the exhausting attempt stored;
`declaredTypes`, the types you declared; `retiringTypes`, the types your
specification retires a row on; and `completionHash`, the fact the library
stored on the attempt that gave up. The first is among the other two, so the
specification's shape is right and the fact was written, and it says which
decision your handler took. Resolve the hash and read that fact's predecessors:
they name the row it retired, which is not the row your handler was given.

## A queue with two terminal outcomes

Some queues retire a row on more than one decision, and both are decisions about
the row rather than failures. A review queue is the usual case: an application
leaves the outstanding set when it is approved, and when it is rejected. Declare
both, and return whichever one the row earned:

```ts
completes: [ApplicationApproved, ApplicationRejected],
handle: async row => {
    const verdict = await review(row.result);
    return verdict.approved
        ? new ApplicationApproved(row.result, verdict.reviewer)
        : new ApplicationRejected(row.result, verdict.reason);
}
```

Your specification excludes both, with one `notExists` each. A single outcome is
spelled `[InvitationMirrored]`, the same way, so there is one spelling however
many outcomes you have.

A row can be dispatched more than once, so which outcome the handler returns has
to be a function of the row and the premises it read: see
[the handler must be idempotent](#the-handler-must-be-idempotent).

## The attempt ends when the fact is stored

The attempt spans your handler and the library's write together, and
`handlerTimeoutMs` bounds both. The row reaches `completed` when the fact is in
the store, not when your handler returns.

So a write the replicator refuses — an authorization rule that does not admit
the worker's principal, say — is a rejection of the attempt. It spends an
attempt, the row is retried on backoff, and after `maxAttempts` the worker
reports `failed` carrying the refusal.

## Name the premises of a completion

The `notExists` in your specification is what takes a row out of the outstanding
set, and on a replica an absence is provisional: the fact that would have
excluded the row may exist somewhere this replica has not heard from. Your
handler decides anyway, and the fact it returns is permanent. So name what the
decision rested on.

Take a tenant that is frozen while a `TenantFrozen` carries no
`TenantFreezeLifted`, and an invitation to a frozen tenant that is withdrawn
rather than mirrored. The `TenantFrozen` is the premise, and the withdrawal
takes it as a predecessor:

```ts
class TenantFrozen {
    static Type = "Blog.Tenant.Frozen" as const;
    type = TenantFrozen.Type;
    constructor(public tenant: Tenant, public frozenAt: Date) {}
}

class TenantFreezeLifted {
    static Type = "Blog.Tenant.Frozen.Lifted" as const;
    type = TenantFreezeLifted.Type;
    constructor(public frozen: TenantFrozen) {}
}

class InvitationWithdrawn {
    static Type = "Blog.Invitation.Withdrawn" as const;
    type = InvitationWithdrawn.Type;
    constructor(
        public invitation: Invitation,
        public frozen: TenantFrozen
    ) {}
}
```

A `TenantFreezeLifted` that arrives afterwards is a successor of the exact fact
your withdrawal names, so the contradiction sits one hop from the decision:
history shows it, and a compensating consumer selects it. Name the positive
facts your conditions bind, the ones a later fact can overturn the decision
through. An absence is not a predecessor — the `TenantFreezeLifted` above is
already a successor of the row's own facts — so there is nothing to model for
one.

The premise has to reach your handler, so the specification binds it as a label
and projects it beside the row's own fact:

```ts
const invitationsToWithdraw = model.given(Tenant).match((tenant, facts) =>
    facts.ofType(TenantFrozen)
        .join(frozen => frozen.tenant, tenant)
        .notExists(frozen => facts.ofType(TenantFreezeLifted)
            .join(lifted => lifted.frozen, frozen))
        .selectMany(frozen => facts.ofType(Invitation)
            .join(invitation => invitation.tenant, tenant)
            .notExists(invitation => facts.ofType(InvitationWithdrawn)
                .join(withdrawn => withdrawn.invitation, invitation))
            .select(invitation => ({ invitation, frozen })))
);

handle: async row =>
    new InvitationWithdrawn(row.result.invitation, row.result.frozen)
```

Two consequences come with it:

- **A subject that more than one premise satisfies is offered once per
  premise.** The premise is a label of the row, so each of those rows can write
  a decision for the subject. A handler that reads a premise outside
  `row.result` can also write a different fact on a repeat of one row, which
  content addressing does not collapse.
- **A premise does not make a decision unique.** An authorization rule decides
  who may write a fact, not how many get written: the same principal on two
  replicas, or a retry after a timeout, writes two and both are authorized.
  Uniqueness needs a single writer that serializes decisions.

## The handler must be idempotent

A row can be dispatched to your handler more than once, and two dispatches of
the same row can overlap. There are two mechanisms behind this, and neither is
avoidable from inside the library.

**An abandoned timeout.** An attempt is bounded by `handlerTimeoutMs`.
JavaScript offers no way to cancel a promise, so the bound abandons the *wait*
and the handler keeps running. The abandoned attempt counts as a rejection, the
row goes to `waiting`, and the next attempt starts while the first one is still
in flight. Two runs of your handler for one row overlap, in the same process.

**A stale addition.** Nothing orders changes across two saves whose re-checks
overlap. The first save's re-check can read before the second save lands, the
second's re-check emits `removed`, and the first save's `added` arrives behind
it. The `removed` clears the row from the consumer's map, and the `added` behind
it finds no entry and is admitted. Your handler runs again for a row that is
already complete.

So make the handler safe to run twice:

- Return the same completion type for the same row.
  Content addressing makes a repeated fact harmless only when the attempt
  repeats it. A handler that can return more than one type and takes the other
  decision on a second run stores a second permanent fact, and the row's
  history then carries two contradictory decisions. What this asks of you is one
  decision, not one fact: a second attempt that fills a field differently, with
  a timestamp of its own, writes another fact of the type it already chose, and
  the row stays retired on that decision.
- Give every write outside the graph a key. `row.rowHash` identifies the row,
  and an upsert on it turns a second run into a no-op.
- Do not treat "I already did this" as an error. A second run that finds its
  work done should return its completion fact, not reject; a rejection here
  spends an attempt and moves the row toward quarantine.

## Rejection

One call of your handler is one attempt. A rejected promise and a thrown
exception are the same failure, and a handler that exceeds `handlerTimeoutMs`
is a rejection too. Each one spends an attempt and schedules the next one from
the consumer's `RetryPolicy`. After `maxAttempts` rejections the row is
quarantined and the worker emits a `failed` event. See
[the quarantine pattern](quarantine-pattern.md).

So the handler keeps no retry of its own. One that catches its own failures and
tries again before it settles reports every one of those tries as a single
attempt. `attempts` then stops counting what the loop tried, and the row
reaches quarantine later than the policy puts it: time-to-quarantine is
`maxAttempts` attempts spaced by the backoff `baseMs` and `capMs` govern, and a
hidden retry stretches each of those attempts without spending one. The retry
policy is the consumer's `retry`, and a handler carrying its own competes with
it.

## Where the handler runs

The handler never runs on the notification turn. The row stream's listener only
offers the row; the consumer's own turn acquires a slot from the limiter and
runs the handler. The slot is held for the attempt — the handler and the write
that ends it — and released before any backoff wait, so a row waiting to retry
does not occupy concurrency that another row could use.

The limiter is what bounds the pressure your handlers put on a connection pool,
so size it below the pool. A handler that waits on something without a bound
holds its slot for as long as it waits.

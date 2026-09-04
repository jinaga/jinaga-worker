# The quarantine pattern

**Read this before deploying a worker.**

When a row exhausts its attempts, the library calls your `quarantine` callback
and then skips the row for the life of the process. It writes nothing. The fact
type, the condition in the specification, and the write are yours, and the four
steps below are how you supply them.

Adopting the pattern is a choice. [What declining costs](#what-declining-costs)
states the price of the other one.

## 1. Define the fact

```ts
class InvitationQuarantined {
    static Type = "Blog.Invitation.Quarantined" as const;
    type = InvitationQuarantined.Type;
    constructor(
        public invitation: Invitation,
        public reason: string,
        public quarantinedAt: Date
    ) {}
}
```

## 2. Exclude it in the specification

The outstanding set must exclude a quarantined row, or the row never leaves and
the consumer reports `stalled` about its own quarantine:

```ts
const outstandingInvitations = model.given(Tenant).match((tenant, facts) =>
    facts.ofType(Invitation)
        .join(i => i.tenant, tenant)
        .notExists(i => facts.ofType(InvitationMirrored)
            .join(m => m.invitation, i))
        .notExists(i => facts.ofType(InvitationQuarantined)
            .join(q => q.invitation, i))
);
```

## 3. Write it from the callback

```ts
quarantine: async (row, e) => {
    await j.fact(new InvitationQuarantined(row.result, describe(e), new Date()));
}
```

The callback is bounded by `handlerTimeoutMs`, and the row is quarantined in
memory whether or not the callback succeeded. A callback that throws is logged
and does not put the row back in circulation, so a failed write costs you the
durable record, not the suppression.

The event `e` carries `kind`, `attempts`, `elapsedMs`, `rowHash`, the consumer's
name, and the projection the handler saw. A `failed` event carries the last
rejection as `error`; a `stalled` event has no error to carry, because the
handler resolved.

## 4. Model release as a successor

Quarantine records a decision about a possibly transient failure in immutable
storage, so releasing one is its own fact, and the condition becomes "no
*unreleased* quarantine":

```ts
class InvitationQuarantineReleased {
    static Type = "Blog.Invitation.Quarantined.Released" as const;
    type = InvitationQuarantineReleased.Type;
    constructor(public quarantined: InvitationQuarantined) {}
}

.notExists(i => facts.ofType(InvitationQuarantined)
    .join(q => q.invitation, i)
    .notExists(q => facts.ofType(InvitationQuarantineReleased)
        .join(r => r.quarantined, q)))
```

The operator needs a way to write that fact. Building one is part of adopting
the pattern.

## The callback and the condition move together

The `quarantine` callback of step 3 and the `notExists` of step 2 are one
decision written at two sites, and nothing checks that they agree. The library
cannot compose a condition onto a specification it did not build, so this page
is where the coupling is stated, and `stalled` is how a violation is detected:

- **A callback and no condition.** The quarantine fact is written, the row stays
  in the outstanding set, every sweep returns it, and the consumer reports
  `stalled` about a row it has already given up on.
- **A condition and no callback.** Nothing ever writes the fact, so the
  condition never excludes anything. The row is suppressed in memory for the
  life of this process and re-attempted by the next one.

Change one, change the other, in the same commit.

## Authorization

The worker's principal must be authorized to write both the completion fact and
the quarantine fact. A denial on either throws at the client, leaves the row
outstanding, and surfaces as `stalled`. The event names the consumer, and the
consumer's declaration names the fact types, which is how an operator gets from
the report to the authorization rule that rejected the write.

## What it buys

- A poison row leaves the outstanding set **permanently**, so the head of the
  backlog is never blocked.
- Quarantine survives a restart instead of being retried forever.
- A second worker does not re-attempt what this one gave up on.

## What declining costs

Nothing durable is written by the library, so a worker with no `quarantine`
callback still caps attempts and still emits `onNoProgress`. What it does not do
is remember. The row is suppressed in this process's memory, the next process
rediscovers it, attempts it to exhaustion again, and quarantines it again,
forever. Every sweep pays for it, and the report arrives once per process
lifetime rather than once.

That is the documented consequence of declining the pattern, not a defect.

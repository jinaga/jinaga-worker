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

## Install

```
npm install jinaga-worker jinaga
```

`jinaga` is a peer dependency: the worker runs against the `Jinaga` instance
your application already holds, so the application chooses its version.

## Usage

A consumer mirrors each invitation somewhere outside the fact graph. Its
specification is the invitations with no `InvitationMirrored` yet, and its
handler returns that fact, which the library asserts to take the row out of the
set.

```ts
import { buildModel, Jinaga } from "jinaga";
import { createWorker, defineConsumer, Worker } from "jinaga-worker";

class Tenant {
    static Type = "Blog.Tenant" as const;
    type = Tenant.Type;
    constructor(public identifier: string) {}
}

class Invitation {
    static Type = "Blog.Invitation" as const;
    type = Invitation.Type;
    constructor(public tenant: Tenant, public email: string) {}
}

class InvitationMirrored {
    static Type = "Blog.Invitation.Mirrored" as const;
    type = InvitationMirrored.Type;
    constructor(public invitation: Invitation) {}
}

const model = buildModel(b => b
    .type(Tenant)
    .type(Invitation, f => f.predecessor("tenant", Tenant))
    .type(InvitationMirrored, f => f.predecessor("invitation", Invitation)));

const outstandingInvitations = model.given(Tenant).match((tenant, facts) =>
    facts.ofType(Invitation)
        .join(invitation => invitation.tenant, tenant)
        .notExists(invitation => facts.ofType(InvitationMirrored)
            .join(mirrored => mirrored.invitation, invitation)));

const invitations = defineConsumer({
    name: "invitation-mirror",
    specification: outstandingInvitations,
    givens: [new Tenant("acme")],
    completes: InvitationMirrored,
    handle: async row => {
        await mirror(row.result);
        return new InvitationMirrored(row.result);
    }
});

export async function startWorker(j: Jinaga): Promise<Worker> {
    const worker = createWorker(j, { consumers: [invitations] });
    await worker.start();
    return worker;
}
```

`mirror` is your side effect, and it may run more than once for the same
invitation. The pages below say why, and what the boot path around `start()`
should do when it rejects.

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

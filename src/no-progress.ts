/**
 * What a worker reports when a row stops making progress.
 *
 * `kind` and `error` are one axis, not two. A `failed` event always carries the
 * rejection that exhausted the row; a `stalled` event has no error to carry,
 * because the completion fact was stored every time. Modelled as a union,
 * neither `{ kind: "stalled", error }` nor `{ kind: "failed" }` can be
 * constructed.
 */
export type NoProgressEvent<U = unknown> = FailedEvent<U> | StalledEvent<U>;

interface NoProgress<U> {
    /** The consumer that gave up on the row. */
    consumer: string;

    /** The row's projection, as the handler saw it. */
    result: U;

    rowHash: string;

    /** Attempts spent before the row was given up on. */
    attempts: number;

    /** First attempt to exhaustion. */
    elapsedMs: number;

    /** Rows this consumer holds quarantined, including this one. */
    quarantineDepth: number;
}

/**
 * The attempt rejected `maxAttempts` times: the handler rejected, or the
 * completion fact it returned was refused by the replicator's authorization
 * rules. Operational, usually transient: quarantine the row and let a restart
 * retry it. An authorization denial arrives as `error`, because the library
 * performs that write and sees the rejection.
 */
export interface FailedEvent<U = unknown> extends NoProgress<U> {
    kind: "failed";

    /** The last rejection. */
    error: unknown;
}

/**
 * The completion fact was stored `maxAttempts` times and a later sweep still
 * returned the row. A programming error that will not resolve on its own: the
 * fact was written against a predecessor the specification does not read, so
 * the row goes on matching its own outstanding set.
 *
 * It is the sweep that decides this, never the absence of a removal
 * notification.
 *
 * The three members below are the halves of the comparison the library already
 * holds: `completionType` is among `retiringTypes`, so the shape of the
 * specification is right and the fact was written. What is left to check is
 * which row that fact points at, and `completionHash` is how it is looked up.
 * They belong to this event alone, because a `failed` row has no completion
 * fact to name.
 */
export interface StalledEvent<U = unknown> extends NoProgress<U> {
    kind: "stalled";

    /** The type the consumer declared in `completes`. */
    completionType: string;

    /** The types the specification retires a row on. */
    retiringTypes: readonly string[];

    /** The fact stored by the attempt that exhausted the row. */
    completionHash: string;
}

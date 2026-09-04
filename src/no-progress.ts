/**
 * What a worker reports when a row stops making progress.
 *
 * `kind` and `error` are one axis, not two. A `failed` event always carries the
 * rejection that exhausted the row; a `stalled` event has no error to carry,
 * because the handler resolved every time. Modelled as a union, neither
 * `{ kind: "stalled", error }` nor `{ kind: "failed" }` can be constructed.
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
 * The handler rejected `maxAttempts` times. Operational, usually transient:
 * quarantine the row and let a restart retry it.
 */
export interface FailedEvent<U = unknown> extends NoProgress<U> {
    kind: "failed";

    /** The last rejection. */
    error: unknown;
}

/**
 * The handler resolved `maxAttempts` times and a later sweep still returned the
 * row. A programming error that will not resolve on its own: a missing
 * `notExists`, a completion fact of the wrong type, a handler that silently
 * no-ops, or a completion fact the replicator's authorization rules reject.
 *
 * It is the sweep that decides this, never the absence of a removal
 * notification.
 */
export interface StalledEvent<U = unknown> extends NoProgress<U> {
    kind: "stalled";
}

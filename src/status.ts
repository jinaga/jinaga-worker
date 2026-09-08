/**
 * What `stop()` resolves with.
 *
 * Both counts are derived from the row-state map at the moment `stop()`
 * resolves, over the rows that were `dispatching` when the drain began. Neither
 * is tallied as handlers finish, so neither can disagree with the map.
 */
export interface StopReport {
    /** Handlers that settled within the deadline. */
    drained: number;
    /** Handlers still running when `stop()` resolved. */
    abandoned: number;
}

/**
 * A snapshot for a health or metrics endpoint. Every row count is tallied from
 * the row-state map on call; the sweep fields are the runtime's own record of
 * the backstop, which that map does not describe.
 */
export interface WorkerStatus {
    consumers: readonly ConsumerStatus[];
}

export interface ConsumerStatus {
    name: string;
    givenHash: string;
    dispatching: number;
    waiting: number;
    completed: number;
    quarantined: number;

    /** `RowStream.dropped`, read through on call. */
    dropped: number;

    /**
     * Passes that have failed since the last successful one. Consecutive rather
     * than cumulative, because what an operator asks of a backstop is whether
     * it is recovering anything now.
     */
    sweepFailures: number;

    /**
     * The most recent successful backstop pass. One optional rather than two,
     * because an `at` without a `size` is not a state the problem contains.
     */
    lastSweep?: { at: Date; size: number };

    /**
     * The most recent failed pass. It carries its own time, so it is legible
     * beside `lastSweep` rather than through it, and the two are separately
     * optional: a consumer that has swept and never failed has a `lastSweep`
     * and no failure, and one that has only ever failed has the reverse.
     */
    lastSweepFailure?: { at: Date; error: unknown };
}

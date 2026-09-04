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
 * A snapshot for a health or metrics endpoint. Entirely derived: every count is
 * tallied from the row-state map on call.
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
     * The most recent backstop sweep. One optional rather than two, because an
     * `at` without a `size` is not a state the problem contains.
     */
    lastSweep?: { at: Date; size: number };
}

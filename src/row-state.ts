import { SpecificationRow } from "jinaga";

/**
 * What a consumer knows about one outstanding row.
 *
 * Four phases for the four situations a row can be in. `attempts` and
 * `firstAttemptAt` appear on the phases where they govern something: the
 * attempt limit, and the elapsed time a non-progress report carries. A row
 * reaches exhaustion from `dispatching` and from `completed` alike, so both
 * carry them. A quarantined row is never attempted again and never reported
 * again, so it carries neither.
 */
export type RowState<U> =
    | { phase: "dispatching"; row: SpecificationRow<U>; attempts: number; firstAttemptAt: number }
    | { phase: "waiting"; row: SpecificationRow<U>; attempts: number; firstAttemptAt: number; retryAt: number }
    | { phase: "completed"; row: SpecificationRow<U>; attempts: number; firstAttemptAt: number }
    | { phase: "quarantined"; row: SpecificationRow<U> };

/**
 * One map per consumer, keyed by `rowHash`. A row not being worked on is
 * absent from it.
 */
export type RowStateMap<U> = Map<string, RowState<U>>;

/**
 * What happens to a row.
 *
 * The two discovery paths are separate kinds because they part ways on a
 * `completed` row: the sweep is what decides a row has stalled, so a stream
 * addition behind a completion is suppressed while a sweep that still returns
 * the row re-dispatches it or quarantines it.
 *
 * `removed` covers both ways a row leaves the outstanding set: a `removed`
 * change from the stream, and a sweep that omits the row.
 *
 * `rejected` covers both ways an attempt fails: a handler that rejects, and one
 * that exceeds its timeout. `retryAt` is when the next attempt is due, computed
 * from the consumer's retry policy by the caller, and `maxAttempts` is that
 * policy's limit.
 */
export type RowEvent<U> =
    | { kind: "added"; row: SpecificationRow<U>; at: number }
    | { kind: "swept"; row: SpecificationRow<U>; at: number; maxAttempts: number }
    | { kind: "removed" }
    | { kind: "resolved" }
    | { kind: "rejected"; retryAt: number; maxAttempts: number }
    | { kind: "retryDue" };

/**
 * The counts a `ConsumerStatus` reports about its rows, tallied from the map.
 */
export interface RowCounts {
    dispatching: number;
    waiting: number;
    completed: number;
    quarantined: number;
}

/**
 * The admission gate. One lookup: a row is admitted for dispatch if and only if
 * the map holds no entry for its `rowHash`.
 */
export function isAdmissible<U>(rows: RowStateMap<U>, rowHash: string): boolean {
    return !rows.has(rowHash);
}

/**
 * The transition table, as a pure function of a row's current state and what
 * happened to it. `undefined` on either side is a row absent from the map.
 *
 * Every combination the table does not name leaves the state as it stands,
 * which is the admission gate seen from the other side: an offer from either
 * discovery path is suppressed while the map holds an entry.
 */
export function transition<U>(
    current: RowState<U> | undefined,
    event: RowEvent<U>
): RowState<U> | undefined {
    if (event.kind === "removed") {
        return undefined;
    }
    if (current === undefined) {
        return event.kind === "added" || event.kind === "swept"
            ? { phase: "dispatching", row: event.row, attempts: 1, firstAttemptAt: event.at }
            : undefined;
    }
    switch (current.phase) {
        case "dispatching":
            if (event.kind === "resolved") {
                return {
                    phase: "completed",
                    row: current.row,
                    attempts: current.attempts,
                    firstAttemptAt: current.firstAttemptAt
                };
            }
            if (event.kind === "rejected") {
                return current.attempts < event.maxAttempts
                    ? {
                        phase: "waiting",
                        row: current.row,
                        attempts: current.attempts,
                        firstAttemptAt: current.firstAttemptAt,
                        retryAt: event.retryAt
                    }
                    : { phase: "quarantined", row: current.row };
            }
            return current;
        case "waiting":
            return event.kind === "retryDue"
                ? {
                    phase: "dispatching",
                    row: current.row,
                    attempts: current.attempts + 1,
                    firstAttemptAt: current.firstAttemptAt
                }
                : current;
        case "completed":
            if (event.kind !== "swept") {
                return current;
            }
            // A re-dispatch carries the sweep's projection, which is what the
            // handler will see. A quarantine keeps the one the handler saw.
            // `firstAttemptAt` spans every cycle, as `attempts` does, so the
            // elapsed time a stalled report carries covers all of them.
            return current.attempts < event.maxAttempts
                ? {
                    phase: "dispatching",
                    row: event.row,
                    attempts: current.attempts + 1,
                    firstAttemptAt: current.firstAttemptAt
                }
                : { phase: "quarantined", row: current.row };
        case "quarantined":
            return current;
    }
}

/**
 * Apply a transition to the map, and return the row's new state. A row that
 * leaves the outstanding set is deleted, so the map holds nothing for it and a
 * later addition finds it admissible.
 */
export function applyRowEvent<U>(
    rows: RowStateMap<U>,
    rowHash: string,
    event: RowEvent<U>
): RowState<U> | undefined {
    const next = transition(rows.get(rowHash), event);
    if (next === undefined) {
        rows.delete(rowHash);
    }
    else {
        rows.set(rowHash, next);
    }
    return next;
}

/**
 * Tally the map. The counts are computed on call from the state they describe,
 * so they cannot drift from it.
 */
export function countRows<U>(rows: RowStateMap<U>): RowCounts {
    const counts: RowCounts = { dispatching: 0, waiting: 0, completed: 0, quarantined: 0 };
    for (const state of rows.values()) {
        counts[state.phase] += 1;
    }
    return counts;
}

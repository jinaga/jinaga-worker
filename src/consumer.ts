import {
    DEFAULT_ROW_STREAM_CAPACITY,
    Fact,
    Jinaga,
    RowStream,
    RowStreamOptions,
    SpecificationOf,
    SpecificationRow
} from "jinaga";
import { Limiter } from "./limiter";
import { NoProgressEvent } from "./no-progress";
import { DEFAULT_RETRY_POLICY, RetryPolicy } from "./retry";

/**
 * What a caller declares about one consumer.
 *
 * Everything here varies per consumer. A setting shared across the whole
 * process is a `WorkerOptions` field instead, and no setting appears in both.
 */
export interface ConsumerOptions<T extends unknown[], U> {
    /** The consumer's name, as it appears in status and diagnostics. */
    name: string;

    /** The outstanding set: what this consumer still has to do. */
    specification: SpecificationOf<T, U>;

    /**
     * The specification's givens, as a tuple. Its type is the specification's
     * own `T`, so passing too few is a compile error.
     */
    givens: T;

    /** What the consumer does with a row. */
    handle: (row: SpecificationRow<U>) => Promise<void>;

    /**
     * What the application writes about a row that has run out of attempts.
     *
     * The fact type, the write, and the matching `notExists` in the
     * specification are the application's: see
     * [the quarantine pattern](../docs/quarantine-pattern.md).
     */
    quarantine?: (row: SpecificationRow<U>, event: NoProgressEvent<U>) => Promise<void>;

    /** A private concurrency budget in place of the worker's shared one. */
    limiter?: Limiter;

    /** How patiently a rejected row is re-attempted. */
    retry?: RetryPolicy;

    /** How long between backstop sweeps. */
    sweepIntervalMs?: number;

    /** How long one attempt at a row may take before it counts as rejected. */
    handlerTimeoutMs?: number;

    /** The row stream's buffer bound, beyond which changes are dropped. */
    capacity?: number;
}

/** @see ConsumerOptions.sweepIntervalMs */
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/** @see ConsumerOptions.handlerTimeoutMs */
export const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;

/**
 * A consumer, as a worker holds it.
 *
 * `defineConsumer` produces one and `createWorker` takes a set of them, fixed
 * at construction. The type erases the specification's given and projection
 * types, so one worker holds consumers of different shapes in one set; a caller
 * holds the value and passes it on rather than reading it.
 */
export interface Consumer {
    /** The consumer's name, as it appears in status and diagnostics. */
    readonly name: string;

    /**
     * This consumer's own concurrency budget, when it has one. A consumer
     * without one runs under the worker's shared budget.
     */
    readonly limiter?: Limiter;

    /** How patiently a rejected row is re-attempted. */
    readonly retry: RetryPolicy;

    /** How long between backstop sweeps. */
    readonly sweepIntervalMs: number;

    /** How long one attempt at a row may take before it counts as rejected. */
    readonly handlerTimeoutMs: number;

    /**
     * The hash of the consumer's givens: `j.hash` of each, joined. A given that
     * differs by any field after a restart sends both discovery paths silently
     * empty, and this is what an operator compares.
     */
    givenHash(j: Jinaga): string;

    /** Open the row stream over the outstanding set. */
    subscribe(j: Jinaga): Promise<RowStream<unknown>>;

    /**
     * Read the outstanding set for one backstop sweep. The rows carry the same
     * `rowHash` the stream delivers, which is what lets one gate deduplicate
     * both discovery paths.
     */
    query(j: Jinaga): Promise<SpecificationRow<unknown>[]>;

    /** Run the handler for one row. */
    handle(row: SpecificationRow<unknown>): Promise<void>;

    /**
     * Write the application's record of a row that has run out of attempts,
     * when the consumer declared one. Absent otherwise, and a consumer without
     * one still caps attempts and still reports.
     */
    quarantine?(row: SpecificationRow<unknown>, event: NoProgressEvent): Promise<void>;
}

/**
 * Declare a consumer. The declaration is complete once this returns: the
 * specification, the givens and the handler are fixed together, and the
 * defaults of section 6 are resolved here, where they have their one home.
 */
export function defineConsumer<T extends unknown[], U>(
    options: ConsumerOptions<T, U>
): Consumer {
    const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    const capacity = options.capacity ?? DEFAULT_ROW_STREAM_CAPACITY;
    const quarantine = options.quarantine;
    return {
        name: options.name,
        limiter: options.limiter,
        retry: options.retry ?? DEFAULT_RETRY_POLICY,
        sweepIntervalMs,
        handlerTimeoutMs: options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS,
        givenHash: j => options.givens.map(given => j.hash(given as Fact)).join(","),
        subscribe: async j => {
            const args = [...options.givens, { capacity }] as [...T, RowStreamOptions];
            const stream = await j.subscribeRows(options.specification, ...args);
            return stream as RowStream<unknown>;
        },
        query: async j => {
            const rows = await j.queryRows(options.specification, ...options.givens);
            return rows as SpecificationRow<unknown>[];
        },
        handle: row => options.handle(row as SpecificationRow<U>),
        ...(quarantine === undefined ? {} : {
            quarantine: (row: SpecificationRow<unknown>, event: NoProgressEvent) =>
                quarantine(row as SpecificationRow<U>, event as NoProgressEvent<U>)
        })
    };
}

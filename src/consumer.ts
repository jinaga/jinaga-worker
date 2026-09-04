import {
    DEFAULT_ROW_STREAM_CAPACITY,
    Fact,
    Jinaga,
    RowStream,
    RowStreamOptions,
    SpecificationOf,
    SpecificationRow
} from "jinaga";

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

    /** How long between backstop sweeps. */
    sweepIntervalMs?: number;

    /** The row stream's buffer bound, beyond which changes are dropped. */
    capacity?: number;
}

/** @see ConsumerOptions.sweepIntervalMs */
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

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

    /** How long between backstop sweeps. */
    readonly sweepIntervalMs: number;

    /**
     * The hash of the consumer's givens: `j.hash` of each, joined. A given that
     * differs by any field after a restart sends both discovery paths silently
     * empty, and this is what an operator compares.
     */
    givenHash(j: Jinaga): string;

    /** Open the row stream over the outstanding set. */
    subscribe(j: Jinaga): Promise<RowStream<unknown>>;

    /** Run the handler for one row. */
    handle(row: SpecificationRow<unknown>): Promise<void>;
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
    return {
        name: options.name,
        sweepIntervalMs,
        givenHash: j => options.givens.map(given => j.hash(given as Fact)).join(","),
        subscribe: async j => {
            const args = [...options.givens, { capacity }] as [...T, RowStreamOptions];
            const stream = await j.subscribeRows(options.specification, ...args);
            return stream as RowStream<unknown>;
        },
        handle: row => options.handle(row as SpecificationRow<U>)
    };
}

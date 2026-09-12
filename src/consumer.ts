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
import { requireRetiringType, retiringTypes } from "./retirement";
import { DEFAULT_RETRY_POLICY, RetryPolicy } from "./retry";

/**
 * A fact type's literal, or `never` for a class whose `type` widened to
 * `string`.
 *
 * The widened case is the declaration in which nothing could be checked, so it
 * maps to a type no constructor satisfies and is refused where it is written.
 */
export type LiteralType<C extends { type: string }> =
    string extends C["type"] ? never : C["type"];

/**
 * The constructor of a fact a consumer's callback returns.
 *
 * `Type` is what survives erasure. The fact's own type is erased at runtime and
 * a closure's return value cannot be read statically, so this literal is the
 * one value that carries the fact's identity to declaration time.
 *
 * The discipline it requires is jinaga's own idiom:
 *
 * ```ts
 * class InvitationMirrored {
 *     static Type = "Blog.Invitation.Mirrored" as const;
 *     type = InvitationMirrored.Type;
 *     constructor(public invitation: Invitation) {}
 * }
 * ```
 */
export interface CompletionConstructor<C extends { type: string }> {
    new (...args: never[]): C;
    Type: LiteralType<C>;
}

/**
 * What a caller declares about one consumer.
 *
 * Everything here varies per consumer. A setting shared across the whole
 * process is a `WorkerOptions` field instead, and no setting appears in both.
 */
export interface ConsumerOptions<
    T extends unknown[],
    U,
    C extends { type: string },
    Q extends { type: string } = never
> {
    /** The consumer's name, as it appears in status and diagnostics. */
    name: string;

    /** The outstanding set: what this consumer still has to do. */
    specification: SpecificationOf<T, U>;

    /**
     * The specification's givens, as a tuple. Its type is the specification's
     * own `T`, so passing too few is a compile error.
     */
    givens: T;

    /**
     * The constructor of the fact `handle` returns.
     *
     * It is not derivable from `handle` (Art. 2): the type is erased at runtime
     * and a closure's return cannot be read statically.
     */
    completes: CompletionConstructor<C>;

    /**
     * What the consumer does with a row, ending in the completion fact that
     * takes the row out of the outstanding set. The library asserts it.
     */
    handle: (row: SpecificationRow<U>) => Promise<C>;

    /**
     * What the application records about a row that has run out of attempts.
     * The factory returns the fact and the library asserts it.
     *
     * The constructor and the factory are one group because a constructor with
     * no factory, and a factory with no constructor, are states the problem does
     * not contain (Art. 1, 3). The fact type, its meaning, and the matching
     * `notExists` in the specification are the application's: see
     * [the quarantine pattern](../docs/quarantine-pattern.md).
     */
    quarantine?: {
        produces: CompletionConstructor<Q>;
        fact: (row: SpecificationRow<U>, event: NoProgressEvent<U>) => Promise<Q>;
    };

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
     * The type of the fact `handle` returns, as `completes` named it, and the
     * fact types the specification retires a row on.
     *
     * Both are fixed when the declaration is: the literal is read off
     * `completes`, and the set is the one `defineConsumer` inverted the
     * specification for. A `stalled` report carries them, so it reads them here
     * rather than inverting the specification again (Art. 2).
     */
    readonly completionType: string;

    /** @see Consumer.completionType */
    readonly retiringTypes: readonly string[];

    /**
     * The hash of the consumer's givens: `j.hash` of each, joined. A given that
     * differs by any field after a restart sends both discovery paths silently
     * empty, and this is what an operator compares.
     */
    givenHash(j: Jinaga): string;

    /**
     * Open the row stream over the outstanding set. `feedTimeoutMs` is what
     * remains of the worker's start budget, and is absent when it set none.
     */
    subscribe(j: Jinaga, feedTimeoutMs?: number): Promise<RowStream<unknown>>;

    /**
     * Read the outstanding set for one backstop sweep. The rows carry the same
     * `rowHash` the stream delivers, which is what lets one gate deduplicate
     * both discovery paths.
     */
    query(j: Jinaga): Promise<SpecificationRow<unknown>[]>;

    /**
     * Run the handler for one row, and return the completion fact it produced.
     * The runtime asserts it, so the attempt is not done when this resolves.
     */
    handle(row: SpecificationRow<unknown>): Promise<Fact>;

    /**
     * Build the application's record of a row that has run out of attempts,
     * when the consumer declared the group. The runtime asserts what it
     * returns. Absent otherwise, and a consumer without one still caps attempts
     * and still reports.
     */
    quarantine?(row: SpecificationRow<unknown>, event: NoProgressEvent): Promise<Fact>;
}

/**
 * Declare a consumer. The declaration is complete once this returns: the
 * specification, the givens and the handler are fixed together, and the
 * defaults of section 6 are resolved here, where they have their one home.
 *
 * Throws when a declared fact type is one the specification never excludes,
 * because such a consumer cannot retire the row it is given. This is the
 * earliest point the comparison can be made: `Type` carries the erased fact's
 * identity here, and the specification's inverses say what actually shrinks the
 * outstanding set.
 */
export function defineConsumer<
    T extends unknown[],
    U,
    C extends { type: string },
    Q extends { type: string } = never
>(
    options: ConsumerOptions<T, U, C, Q>
): Consumer {
    const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    const capacity = options.capacity ?? DEFAULT_ROW_STREAM_CAPACITY;
    const quarantine = options.quarantine;

    const retiring = retiringTypes(options.specification.specification);
    requireRetiringType(options.name, "completes", options.completes.Type, retiring);
    if (quarantine !== undefined) {
        requireRetiringType(
            options.name,
            "quarantine.produces",
            quarantine.produces.Type,
            retiring
        );
    }

    return {
        name: options.name,
        limiter: options.limiter,
        retry: options.retry ?? DEFAULT_RETRY_POLICY,
        sweepIntervalMs,
        handlerTimeoutMs: options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS,
        completionType: options.completes.Type,
        retiringTypes: retiring,
        givenHash: j => options.givens.map(given => j.hash(given as Fact)).join(","),
        subscribe: async (j, feedTimeoutMs) => {
            const streamOptions: RowStreamOptions = feedTimeoutMs === undefined
                ? { capacity }
                : { capacity, feedTimeoutMs };
            const args = [...options.givens, streamOptions] as [...T, RowStreamOptions];
            const stream = await j.subscribeRows(options.specification, ...args);
            return stream as RowStream<unknown>;
        },
        query: async j => {
            const rows = await j.queryRows(options.specification, ...options.givens);
            return rows as SpecificationRow<unknown>[];
        },
        handle: async row =>
            await options.handle(row as SpecificationRow<U>) as unknown as Fact,
        ...(quarantine === undefined ? {} : {
            quarantine: async (row: SpecificationRow<unknown>, event: NoProgressEvent) =>
                await quarantine.fact(
                    row as SpecificationRow<U>,
                    event as NoProgressEvent<U>
                ) as unknown as Fact
        })
    };
}

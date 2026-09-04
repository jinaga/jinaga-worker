import { Jinaga, RowStream, SpecificationRow } from "jinaga";
import { Consumer } from "./consumer";
import { Logger } from "./logger";
import { applyRowEvent, countRows, RowEvent, RowStateMap } from "./row-state";
import { ConsumerStatus } from "./status";

/**
 * One consumer, running inside a worker.
 *
 * It holds the consumer's row-state map and the attempts in flight against it,
 * opens and releases the row stream, and owns the backstop sweep's timer.
 */
export class ConsumerRuntime {
    /** This consumer's rows, keyed by `rowHash`. */
    readonly rows: RowStateMap<unknown> = new Map();

    /**
     * The hash of the consumer's givens. It is a function of the givens alone,
     * so it is known before `start()` and `status()` can always report it.
     */
    readonly givenHash: string;

    private readonly inFlight = new Map<string, Promise<void>>();
    private stream: RowStream<unknown> | undefined;
    private sweepTimer: ReturnType<typeof setInterval> | undefined;
    private lastSweep: { at: Date; size: number } | undefined;

    constructor(
        private readonly j: Jinaga,
        private readonly consumer: Consumer,
        private readonly logger: Logger
    ) {
        this.givenHash = consumer.givenHash(j);
    }

    get name(): string {
        return this.consumer.name;
    }

    /**
     * Log the given hash, open the row stream, and schedule the backstop sweep.
     *
     * It rejects when `subscribeRows` rejects, which is a structural
     * distribution denial: a worker not authorized for its own specification
     * should fail to start rather than idle. The timer is scheduled only after
     * the stream is running, so a rejection leaves nothing behind.
     */
    async start(): Promise<void> {
        this.logger.info(
            `${this.consumer.name}: given hash ${this.givenHash}`,
            { consumer: this.consumer.name, givenHash: this.givenHash }
        );
        const stream = await this.consumer.subscribe(this.j);
        this.stream = stream;
        // The loop runs for the life of the stream and ends when `stop()`
        // releases it. It reports its own failure, so there is nothing to await.
        void this.iterate(stream);
        this.sweepTimer = setInterval(() => void this.sweep(), this.consumer.sweepIntervalMs);
    }

    /**
     * The stream path: an `added` change offers a row, a `removed` change
     * retracts one.
     *
     * Each change is applied as it arrives. One save can produce both an
     * `added` and a `removed` for the same `rowHash` in either order, and this
     * loop neither buffers nor reorders to compensate — the gate's outcome for
     * whichever arrives last is the state the map is left in.
     *
     * The change carries an `operation` alongside the row, and only the row is
     * offered, so a row admitted by the stream is the same value as the one the
     * sweep offers.
     */
    private async iterate(stream: RowStream<unknown>): Promise<void> {
        try {
            for await (const change of stream) {
                const row = { result: change.result, rowHash: change.rowHash };
                this.offer(change.rowHash, change.operation === "added"
                    ? { kind: "added", row, at: Date.now() }
                    : { kind: "removed" });
            }
        }
        catch (error) {
            this.logger.error(
                `${this.consumer.name}: row stream failed`,
                { consumer: this.consumer.name, error }
            );
        }
    }

    /**
     * One backstop pass over the outstanding set.
     *
     * Every row the read returns is offered, and every row the map held when
     * the read began and the read did not return is retracted. That retraction
     * is how a `completed` row is released without a removal notification.
     *
     * The rows the map gained while the read was in flight are not in its
     * verdict: the read is a snapshot of the moment it was taken, and a row
     * discovered after it was taken was never omitted from it.
     *
     * A sweep reports its own failure and settles either way, so the timer that
     * schedules it has no rejection to handle and one pass that fails does not
     * end the series.
     */
    private async sweep(): Promise<void> {
        const held = new Set(this.rows.keys());
        const at = Date.now();
        try {
            const rows = await this.consumer.query(this.j);
            if (this.sweepTimer === undefined) {
                // Discovery ended while the read was in flight. Nothing this
                // sweep found may be admitted, and its verdict is stale.
                return;
            }
            for (const row of rows) {
                held.delete(row.rowHash);
                this.offer(row.rowHash, {
                    kind: "swept",
                    row,
                    at,
                    maxAttempts: this.consumer.maxAttempts
                });
            }
            for (const rowHash of held) {
                this.offer(rowHash, { kind: "removed" });
            }
            this.lastSweep = { at: new Date(at), size: rows.length };
        }
        catch (error) {
            this.logger.error(
                `${this.consumer.name}: sweep failed`,
                { consumer: this.consumer.name, error }
            );
        }
    }

    /**
     * Release the stream and cancel the sweep timer. Nothing is discovered
     * after this, and the process is free to exit once the drain finishes.
     *
     * The stopped stream is still held, because `status()` reads its `dropped`
     * count through rather than keeping a copy of it.
     */
    endDiscovery(): void {
        this.stream?.stop();
        if (this.sweepTimer !== undefined) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = undefined;
        }
    }

    /**
     * Drop every row waiting to be retried. A waiting row has no attempt to
     * drain, and the next process rediscovers it.
     */
    dropWaiting(): void {
        for (const [rowHash, state] of this.rows) {
            if (state.phase === "waiting") {
                applyRowEvent(this.rows, rowHash, { kind: "removed" });
            }
        }
    }

    /**
     * The admission gate. Both discovery paths funnel through it, and it is the
     * only place a row is admitted: the transition table decides, and a row is
     * dispatched exactly when that decision moves it into `dispatching` from
     * some other state. A sweep therefore cannot admit a row the stream would
     * have rejected, because neither path decides anything of its own.
     *
     * It returns the attempt it started, and nothing when it started none.
     */
    private offer(rowHash: string, event: RowEvent<unknown>): Promise<void> | undefined {
        const wasDispatching = this.rows.get(rowHash)?.phase === "dispatching";
        const next = applyRowEvent(this.rows, rowHash, event);
        if (next?.phase !== "dispatching" || wasDispatching) {
            return undefined;
        }
        // A rejected attempt has already released its row, so discovery offers
        // it again; the rejection is not this turn's to carry any further.
        const running = this.runAttempt(rowHash, next.row);
        running.catch(() => undefined);
        return running;
    }

    /**
     * Admit a row and run its handler, holding the attempt while it runs so
     * `stop()` awaits exactly the rows the map reports as `dispatching`.
     *
     * The row moves to `completed` when the handler resolves. A rejection
     * releases the row, which returns it to the outstanding set for discovery
     * to offer again, and rejects the returned attempt.
     *
     * An offer the map already holds an entry for is suppressed, and there is
     * no attempt to return.
     */
    attempt(rowHash: string, row: SpecificationRow<unknown>): Promise<void> | undefined {
        return this.offer(rowHash, { kind: "added", row, at: Date.now() });
    }

    private runAttempt(rowHash: string, row: SpecificationRow<unknown>): Promise<void> {
        // A handler that throws where it could have rejected is the same
        // failure, and it reaches the map by the same path. Taking it here is
        // what keeps a throw from unwinding the caller: the stream's loop would
        // end, and discovery with it.
        let handled: Promise<void>;
        try {
            handled = this.consumer.handle(row);
        }
        catch (error) {
            handled = Promise.reject(error);
        }
        const running = handled.then(
            () => {
                applyRowEvent(this.rows, rowHash, { kind: "resolved" });
            },
            error => {
                applyRowEvent(this.rows, rowHash, { kind: "removed" });
                throw error;
            }
        );
        const settled: Promise<void> = running.then(
            () => undefined,
            () => undefined
        ).then(() => {
            if (this.inFlight.get(rowHash) === settled) {
                this.inFlight.delete(rowHash);
            }
        });
        this.inFlight.set(rowHash, settled);
        return running;
    }

    /** The rows this consumer is dispatching right now. */
    dispatchingRows(): string[] {
        return [...this.rows]
            .filter(([, state]) => state.phase === "dispatching")
            .map(([rowHash]) => rowHash);
    }

    /** Whether the map still reports this row as `dispatching`. */
    isDispatching(rowHash: string): boolean {
        return this.rows.get(rowHash)?.phase === "dispatching";
    }

    /**
     * The attempt held for a row, which settles when the handler does and never
     * rejects. Absent once the attempt has settled.
     */
    attemptFor(rowHash: string): Promise<void> | undefined {
        return this.inFlight.get(rowHash);
    }

    status(): ConsumerStatus {
        return {
            name: this.consumer.name,
            givenHash: this.givenHash,
            ...countRows(this.rows),
            dropped: this.stream?.dropped ?? 0,
            ...(this.lastSweep === undefined ? {} : { lastSweep: this.lastSweep })
        };
    }
}

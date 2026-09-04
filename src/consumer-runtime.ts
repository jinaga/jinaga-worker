import { Jinaga, RowStream, SpecificationRow } from "jinaga";
import { Consumer } from "./consumer";
import { Logger } from "./logger";
import { applyRowEvent, countRows, RowStateMap } from "./row-state";
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
        this.stream = await this.consumer.subscribe(this.j);
        this.sweepTimer = setInterval(() => this.sweep(), this.consumer.sweepIntervalMs);
    }

    /** One backstop pass over the outstanding set. */
    private sweep(): void {
    }

    /**
     * Release the stream and cancel the sweep timer. Nothing is discovered
     * after this, and the process is free to exit once the drain finishes.
     */
    endDiscovery(): void {
        this.stream?.stop();
        this.stream = undefined;
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
     * Admit a row and run its handler, holding the attempt while it runs so
     * `stop()` awaits exactly the rows the map reports as `dispatching`.
     *
     * The row moves to `completed` when the handler resolves. A rejection
     * releases the row, which returns it to the outstanding set for discovery
     * to offer again, and rejects the returned promise.
     */
    attempt(rowHash: string, row: SpecificationRow<unknown>): Promise<void> {
        applyRowEvent(this.rows, rowHash, { kind: "added", row, at: Date.now() });
        const running = this.consumer.handle(row).then(
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
            ...countRows(this.rows)
        };
    }
}

import { Jinaga, RowStream, SpecificationRow } from "jinaga";
import { Consumer } from "./consumer";
import { Limiter } from "./limiter";
import { Logger } from "./logger";
import { backoffMs } from "./retry";
import { applyRowEvent, countRows, RowEvent, RowStateMap } from "./row-state";
import { ConsumerStatus } from "./status";
import { withTimeout } from "./timeout";

/** A promise that settles on a later turn, never on the caller's own. */
function nextTurn(): Promise<void> {
    return new Promise(resume => setTimeout(resume, 0));
}

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

    /**
     * The budget this consumer's attempts run under: its own when it declared
     * one, and the worker's shared budget otherwise.
     */
    private readonly limiter: Limiter;

    private readonly inFlight = new Map<string, Promise<void>>();
    private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
    private stream: RowStream<unknown> | undefined;
    private sweepTimer: ReturnType<typeof setInterval> | undefined;
    private lastSweep: { at: Date; size: number } | undefined;

    constructor(
        private readonly j: Jinaga,
        private readonly consumer: Consumer,
        limiter: Limiter,
        private readonly logger: Logger
    ) {
        this.givenHash = consumer.givenHash(j);
        this.limiter = consumer.limiter ?? limiter;
    }

    get name(): string {
        return this.consumer.name;
    }

    /**
     * Whether discovery is still running. The sweep timer is the one record of
     * it, so nothing else has to be kept consistent with it.
     */
    private get discovering(): boolean {
        return this.sweepTimer !== undefined;
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
            if (!this.discovering) {
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
                    maxAttempts: this.consumer.retry.maxAttempts
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
     * Drop every row waiting to be retried, and cancel the timer that would
     * have re-attempted it. A waiting row has no attempt to drain, and the next
     * process rediscovers it.
     */
    dropWaiting(): void {
        for (const [rowHash, state] of this.rows) {
            if (state.phase === "waiting") {
                this.cancelRetry(rowHash);
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
        if (next === undefined) {
            // The row left the outstanding set, so the retry it was due has
            // nothing left to re-attempt.
            this.cancelRetry(rowHash);
            return undefined;
        }
        if (next.phase !== "dispatching" || wasDispatching) {
            return undefined;
        }
        return this.runAttempt(rowHash, next.row);
    }

    /**
     * Admit a row and dispatch it, holding the attempt while it runs so
     * `stop()` awaits exactly the rows the map reports as `dispatching`.
     *
     * The row moves to `completed` when the handler resolves, and to `waiting`
     * or `quarantined` when it rejects, on the terms its retry policy sets.
     *
     * An offer the map already holds an entry for is suppressed, and there is
     * no attempt to return.
     */
    attempt(rowHash: string, row: SpecificationRow<unknown>): Promise<void> | undefined {
        return this.offer(rowHash, { kind: "added", row, at: Date.now() });
    }

    /**
     * One attempt at one row, on a turn of its own.
     *
     * The first `await` is what keeps the handler off the notification turn:
     * whichever discovery path offered the row has returned before the handler
     * is called. A slot is held for the handler alone and released when it
     * settles, so the backoff wait that may follow holds nothing.
     *
     * A handler that throws where it could have rejected is the same failure
     * and reaches the map by the same path, because it throws inside this
     * attempt rather than on the caller's turn.
     *
     * The attempt held for a row is the one whose outcome the map takes. A row
     * removed and re-admitted while its handler runs is being attempted twice,
     * and the attempt that replaced this one is the one the map is about; this
     * one reports nothing, and the abandoned handler runs to its own end.
     *
     * The attempt settles either way. `stop()` awaits it to decide what
     * drained, and a rejection is the map's business rather than the caller's.
     */
    private runAttempt(rowHash: string, row: SpecificationRow<unknown>): Promise<void> {
        const current = () => this.inFlight.get(rowHash) === attempt;
        const attempt: Promise<void> = this.dispatch(rowHash, row, current)
            .catch(error => this.logger.error(
                `${this.consumer.name}: dispatching ${rowHash} failed`,
                { consumer: this.consumer.name, rowHash, error }
            ))
            .then(() => {
                if (current()) {
                    this.inFlight.delete(rowHash);
                }
            });
        this.inFlight.set(rowHash, attempt);
        return attempt;
    }

    private async dispatch(
        rowHash: string,
        row: SpecificationRow<unknown>,
        current: () => boolean
    ): Promise<void> {
        await nextTurn();
        try {
            await this.limiter.run(() => withTimeout(
                this.consumer.handle(row),
                this.consumer.handlerTimeoutMs
            ));
        }
        catch (error) {
            if (current()) {
                this.rejectAttempt(rowHash, error);
            }
            return;
        }
        if (current()) {
            applyRowEvent(this.rows, rowHash, { kind: "resolved" });
        }
    }

    /**
     * Account for an attempt that rejected, a handler that outran its deadline
     * included. The policy decides how long the row waits and how many times it
     * is asked; this reads that value and schedules the wait it names.
     *
     * The row is quarantined instead once its attempts are exhausted, which the
     * transition table decides from the same policy.
     */
    private rejectAttempt(rowHash: string, error: unknown): void {
        const state = this.rows.get(rowHash);
        if (state?.phase !== "dispatching") {
            // The row left the outstanding set, or was re-admitted, while the
            // handler ran. Either way this attempt has nothing left to report.
            return;
        }
        this.logger.warn(
            `${this.consumer.name}: attempt ${state.attempts} failed for ${rowHash}`,
            { consumer: this.consumer.name, rowHash, attempts: state.attempts, error }
        );
        const next = applyRowEvent(this.rows, rowHash, {
            kind: "rejected",
            retryAt: Date.now() + backoffMs(this.consumer.retry, state.attempts),
            maxAttempts: this.consumer.retry.maxAttempts
        });
        if (next?.phase !== "waiting") {
            return;
        }
        if (!this.discovering) {
            // Discovery has ended, so nothing will offer this row again. Drop
            // it as `stop()` drops the rows already waiting.
            applyRowEvent(this.rows, rowHash, { kind: "removed" });
            return;
        }
        // The wait is read from the state that records it, so the row is
        // re-attempted when the map says it is due.
        this.retries.set(rowHash, setTimeout(() => {
            this.retries.delete(rowHash);
            this.offer(rowHash, { kind: "retryDue" });
        }, next.retryAt - Date.now()));
    }

    private cancelRetry(rowHash: string): void {
        const timer = this.retries.get(rowHash);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.retries.delete(rowHash);
        }
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

import { FeedTimeoutError, Jinaga } from "jinaga";
import { Consumer } from "./consumer";
import { ConsumerRuntime } from "./consumer-runtime";
import { distributionDiagnostics } from "./diagnostics";
import { Limiter } from "./limiter";
import { consoleLogger, Logger } from "./logger";
import { NoProgressEvent } from "./no-progress";
import { StopReport, WorkerStatus } from "./status";

/**
 * What a caller declares about the worker.
 *
 * Everything here is shared across every consumer. A setting that varies per
 * consumer is a `ConsumerOptions` field instead, and no setting appears in
 * both.
 */
export interface WorkerOptions {
    /** The consumers this worker runs. The set is fixed at construction. */
    consumers: readonly Consumer[];

    /**
     * The concurrency budget every consumer shares, sized to the resources the
     * whole process contends for. Adding a consumer must not raise the total
     * pressure, so a consumer that needs a budget of its own declares one.
     */
    limiter?: Limiter;

    /**
     * The wall clock `start()` may spend before it gives up.
     *
     * One deadline is computed when `start()` is entered, and each consumer's
     * subscribe is given what remains of it, so this bounds the whole call
     * rather than each consumer in turn. Expiry rejects with jinaga's
     * `FeedTimeoutError`, which is the rejection worth retrying; a
     * `DistributionDeniedError` is not. Either one leaves nothing running and
     * spends the worker.
     *
     * Absent, no bound is passed and each subscribe waits as long as the
     * replicator takes. That wait is itself the recovery: the same call is
     * answered when the replicator returns, with nothing torn down and nothing
     * rebuilt, which is what the shapes that do not await `start()` run on.
     *
     * https://github.com/jinaga/jinaga-worker/blob/main/design/durable-consumer-spec.md#31-start
     */
    startTimeoutMs?: number;

    /** How long `stop()` waits for in-flight handlers before abandoning them. */
    shutdownTimeoutMs?: number;

    /**
     * What the process does about a row that stopped making progress.
     *
     * One handler for the whole worker. The event names the consumer it came
     * from, so a reaction that differs per consumer is a `switch` inside this
     * handler rather than a second place to register one.
     */
    onNoProgress?: (event: NoProgressEvent) => void | Promise<void>;

    /** Where the worker writes its diagnostics. */
    logger?: Logger;
}

/** @see WorkerOptions.shutdownTimeoutMs */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

/** The size of the shared budget when the worker is given none. */
export const DEFAULT_CONCURRENCY = 8;

export interface Worker {
    /**
     * Subscribe, sweep, and begin dispatching.
     *
     * It resolves when every consumer's stream is running, and rejects if any
     * consumer fails to start, carrying that consumer's error. The rejection
     * to plan for is a structural distribution denial, which will not
     * self-heal. There is a third outcome: `subscribeRows` awaits the feed's
     * first response, so a replicator that accepts the connection and never
     * answers leaves `start()` pending indefinitely.
     *
     * Do not await `start()` in a boot path unless the process is supposed to
     * fail when the replicator is unreachable. A service whose routes read its
     * own local mirror holds every one of them behind that wait, `/health`
     * included, and those routes are what let it answer while the replicator
     * is away. Such a process starts the worker without awaiting it and
     * reports the rejection instead.
     *
     * A boot path that would rather wait a bounded while sets
     * `startTimeoutMs`, which turns that third outcome into a rejection:
     * jinaga's `FeedTimeoutError`, raised when the replicator does not answer
     * in time. The two rejections are worth opposite responses — a denial
     * repeats until somebody changes a distribution rule, while a replicator
     * that did not answer usually resolves on its own — so it reaches the
     * caller unwrapped, and this package's `TimeoutError` keeps its one
     * meaning, a handler that outran `handlerTimeoutMs`. Either rejection
     * leaves nothing running and spends the worker: a caller who wants to
     * retry builds a new one.
     *
     * See `docs/inherited-constraints.md`.
     */
    start(): Promise<void>;
    /** Stop discovery, drain in-flight work to a deadline, release feeds. */
    stop(): Promise<StopReport>;
    /** A snapshot for a health or metrics endpoint. */
    status(): WorkerStatus;
}

/**
 * The worker itself: one Jinaga instance, one lifecycle, one runtime per
 * consumer.
 */
export class WorkerHost implements Worker {
    /** One per consumer, in the order the options gave them. */
    readonly runtimes: readonly ConsumerRuntime[];

    private readonly startTimeoutMs: number | undefined;
    private readonly shutdownTimeoutMs: number;
    private readonly logger: Logger;

    /**
     * The one start this worker gets. Every call returns it, so a second call
     * after an aborted start yields the same rejection rather than subscribing
     * again.
     */
    private starting: Promise<void> | undefined;

    constructor(private readonly j: Jinaga, options: WorkerOptions) {
        const logger = options.logger ?? consoleLogger;
        const limiter = options.limiter ?? new Limiter(DEFAULT_CONCURRENCY);
        this.logger = logger;
        this.startTimeoutMs = requireDuration(options.startTimeoutMs);
        this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
        this.runtimes = options.consumers.map(
            consumer => new ConsumerRuntime(j, consumer, limiter, logger, options.onNoProgress)
        );
    }

    /**
     * Start every consumer, in the order the options gave them, each given
     * what remains of the one start budget. A rejection releases the streams
     * and timers of the consumers that did start.
     *
     * The diagnostics channel is registered before the first subscribe, so a
     * feed the replicator reports as `reactive` is logged rather than lost. A
     * `reactive` decision is the subscription race and self-heals once the
     * authorizing fact arrives; of the two, the structural denial that will
     * not self-heal is the one that reaches this method as a rejection.
     *
     * @see Worker.start for the three outcomes, and what a boot path owes them.
     */
    start(): Promise<void> {
        this.starting ??= this.startEveryConsumer();
        return this.starting;
    }

    private async startEveryConsumer(): Promise<void> {
        this.j.onDistributionDiagnostic(distributionDiagnostics(this.logger));
        const budget = this.startTimeoutMs === undefined
            ? undefined
            : { totalMs: this.startTimeoutMs, deadline: Date.now() + this.startTimeoutMs };
        try {
            for (const runtime of this.runtimes) {
                await runtime.start(remainingOf(budget));
            }
        }
        catch (error) {
            for (const runtime of this.runtimes) {
                runtime.endDiscovery();
            }
            throw error;
        }
    }

    async stop(): Promise<StopReport> {
        for (const runtime of this.runtimes) {
            runtime.endDiscovery();
            runtime.dropWaiting();
        }

        const draining = this.runtimes.map(runtime => runtime.dispatchingRows());
        const attempts = this.runtimes.flatMap(
            (runtime, index) => draining[index]
                .map(rowHash => runtime.attemptFor(rowHash))
                .filter((attempt): attempt is Promise<void> => attempt !== undefined)
        );
        await settleWithin(attempts, this.shutdownTimeoutMs);

        const report: StopReport = { drained: 0, abandoned: 0 };
        this.runtimes.forEach((runtime, index) => {
            for (const rowHash of draining[index]) {
                if (runtime.isDispatching(rowHash)) {
                    report.abandoned += 1;
                }
                else {
                    report.drained += 1;
                }
            }
        });
        return report;
    }

    status(): WorkerStatus {
        return { consumers: this.runtimes.map(runtime => runtime.status()) };
    }
}

/**
 * Create a worker over a fixed set of consumers. The defaults of section 6 that
 * belong to the worker are resolved here, where they have their one home.
 */
export function createWorker(j: Jinaga, options: WorkerOptions): Worker {
    return new WorkerHost(j, options);
}

/**
 * Hold `startTimeoutMs` to a positive, finite number of milliseconds.
 *
 * `number` admits `NaN`, an infinity and a negative, and none of those is a
 * length of time. A worker refuses one where it is built, which is where its
 * options have their one home, so every value that reaches the deadline is a
 * duration and `FeedTimeoutError` keeps its meaning: a bound that expired.
 */
function requireDuration(startTimeoutMs: number | undefined): number | undefined {
    if (startTimeoutMs === undefined) {
        return undefined;
    }
    if (!Number.isFinite(startTimeoutMs) || startTimeoutMs <= 0) {
        throw new Error(
            `startTimeoutMs is ${startTimeoutMs}, which is not a length of time. Give ` +
            `it a positive number of milliseconds, or leave it out to let start() wait ` +
            `as long as the replicator takes.`
        );
    }
    return startTimeoutMs;
}

/**
 * The bound for the next consumer's subscribe: what is left of the one
 * deadline. A worker given no `startTimeoutMs` has no budget and passes no
 * bound, so each subscribe waits as long as the replicator takes.
 *
 * A budget already spent is a bound that has expired, and it says so here.
 * jinaga reads a non-positive `feedTimeoutMs` as a malformed request and
 * refuses it as a `ValidationError`, which carries the other meaning.
 */
function remainingOf(
    budget: { totalMs: number; deadline: number } | undefined
): number | undefined {
    if (budget === undefined) {
        return undefined;
    }
    const remaining = budget.deadline - Date.now();
    if (remaining <= 0) {
        throw new FeedTimeoutError(
            `Timed out after ${budget.totalMs} ms waiting to start every consumer.`,
            budget.totalMs
        );
    }
    return remaining;
}

/**
 * Wait for every promise to settle, or for the deadline, whichever comes first.
 * The deadline's timer is cleared either way, so a drained worker does not hold
 * the process open for the rest of the timeout.
 */
async function settleWithin(promises: readonly Promise<void>[], timeoutMs: number): Promise<void> {
    if (promises.length === 0) {
        return;
    }
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>(resolve => {
        deadline = setTimeout(resolve, timeoutMs);
    });
    try {
        await Promise.race([Promise.all(promises), expired]);
    }
    finally {
        if (deadline !== undefined) {
            clearTimeout(deadline);
        }
    }
}

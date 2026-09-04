import { Jinaga } from "jinaga";
import { Consumer } from "./consumer";
import { ConsumerRuntime } from "./consumer-runtime";
import { Limiter } from "./limiter";
import { consoleLogger, Logger } from "./logger";
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

    /** How long `stop()` waits for in-flight handlers before abandoning them. */
    shutdownTimeoutMs?: number;

    /** Where the worker writes its diagnostics. */
    logger?: Logger;
}

/** @see WorkerOptions.shutdownTimeoutMs */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

/** The size of the shared budget when the worker is given none. */
export const DEFAULT_CONCURRENCY = 8;

export interface Worker {
    /** Subscribe, sweep, and begin dispatching. */
    start(): Promise<void>;
    /** Stop discovery, drain in-flight work to a deadline, release feeds. */
    stop(): Promise<StopReport>;
    /** A snapshot for a health or metrics endpoint. Entirely derived. */
    status(): WorkerStatus;
}

/**
 * The worker itself: one Jinaga instance, one lifecycle, one runtime per
 * consumer.
 */
export class WorkerHost implements Worker {
    /** One per consumer, in the order the options gave them. */
    readonly runtimes: readonly ConsumerRuntime[];

    private readonly shutdownTimeoutMs: number;

    constructor(j: Jinaga, options: WorkerOptions) {
        const logger = options.logger ?? consoleLogger;
        const limiter = options.limiter ?? new Limiter(DEFAULT_CONCURRENCY);
        this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
        this.runtimes = options.consumers.map(
            consumer => new ConsumerRuntime(j, consumer, limiter, logger)
        );
    }

    /**
     * Start every consumer. It resolves when every stream is running, and
     * rejects when any `subscribeRows` rejects, releasing the streams and
     * timers of the consumers that did start.
     */
    async start(): Promise<void> {
        try {
            for (const runtime of this.runtimes) {
                await runtime.start();
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

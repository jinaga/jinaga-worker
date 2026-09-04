/**
 * A concurrency budget.
 *
 * One instance bounds every consumer that holds it together, so the total work
 * in flight is what the process's real resources — a connection pool, an
 * upstream rate limit — can carry, however many consumers contend for them.
 *
 * The budget is the instance itself. A caller that wants a private budget makes
 * another `Limiter`; there is no number to set in a second place.
 */
export class Limiter {
    private running = 0;
    private readonly queue: (() => void)[] = [];

    constructor(private readonly max: number) {}

    /** Work running right now. */
    get inFlight(): number {
        return this.running;
    }

    /** Work admitted but not started, because the budget is full. */
    get waiting(): number {
        return this.queue.length;
    }

    /**
     * Run the work once a slot is free, and release the slot when it settles.
     * The slot is held for the work alone: whatever the caller does after this
     * resolves is outside the budget.
     */
    async run<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await fn();
        }
        finally {
            this.release();
        }
    }

    private acquire(): Promise<void> {
        if (this.running < this.max) {
            this.running += 1;
            return Promise.resolve();
        }
        return new Promise<void>(granted => {
            this.queue.push(granted);
        });
    }

    /**
     * Hand the slot to the next waiter, or give it back to the budget when
     * nobody is waiting. The count therefore tracks slots taken rather than
     * calls made, and a waiter never observes a free slot it did not receive.
     */
    private release(): void {
        const granted = this.queue.shift();
        if (granted === undefined) {
            this.running -= 1;
        }
        else {
            granted();
        }
    }
}

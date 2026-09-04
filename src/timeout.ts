/** What a handler that outran its deadline rejects with. */
export class TimeoutError extends Error {
    constructor(public readonly timeoutMs: number) {
        super(`timed out after ${timeoutMs}ms`);
        this.name = "TimeoutError";
    }
}

/**
 * Reject when the work has not settled within the deadline.
 *
 * The wait is abandoned, not the work: the handler keeps running, which is one
 * of the two reasons the handler contract demands idempotence. The timer is
 * cleared as soon as either side settles, so a bounded wait does not hold the
 * process open for the rest of its deadline.
 */
export function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs);
    });
    return Promise.race([work, expired]).finally(() => {
        if (deadline !== undefined) {
            clearTimeout(deadline);
        }
    });
}

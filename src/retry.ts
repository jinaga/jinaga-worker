/**
 * How patiently a consumer re-attempts a row.
 *
 * Three knobs for the three axes the problem has: how long to wait first, how
 * long at most, and how many times. It is a declaration the dispatch loop
 * reads, so pacing changes without the loop changing.
 */
export interface RetryPolicy {
    /** How many attempts a row gets before it is given up on. */
    readonly maxAttempts: number;
    /** The wait before the second attempt. */
    readonly baseMs: number;
    /** The longest the wait grows to. */
    readonly capMs: number;
}

/** @see ConsumerOptions.retry */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
    maxAttempts: 5,
    baseMs: 1_000,
    capMs: 30_000
};

/**
 * The wait after `attempts` attempts have failed: exponential from `baseMs`,
 * capped at `capMs`, then spread over the lower half of that so rows which
 * failed together do not return together.
 */
export function backoffMs(policy: RetryPolicy, attempts: number): number {
    const bounded = Math.min(policy.capMs, policy.baseMs * 2 ** (attempts - 1));
    return bounded * (0.5 + Math.random() * 0.5);
}

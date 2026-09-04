/**
 * Where the library writes its diagnostics.
 *
 * The library never writes a fact, so a log line is the only trace it leaves.
 * `data` carries the structured fields; `message` is what an operator reads.
 */
export interface Logger {
    info(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
    error(message: string, data?: Record<string, unknown>): void;
}

/**
 * The logger a worker uses when its options name none. It writes to the
 * console, because the startup line of section 3.1 is the only way an operator
 * sees a given that drifted, and a worker that swallows it looks exactly like a
 * worker with no work.
 */
export const consoleLogger: Logger = {
    info: (message, data) => console.info(message, data ?? {}),
    warn: (message, data) => console.warn(message, data ?? {}),
    error: (message, data) => console.error(message, data ?? {})
};

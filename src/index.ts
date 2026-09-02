import { SpecificationRow } from "jinaga";

export interface WorkerConsumerOptions<T = unknown> {
  name: string;
  specification: unknown;
  givens: readonly unknown[];
  sweepIntervalMs: number;
  handlerTimeoutMs: number;
  maxAttempts: number;
  handle: (row: SpecificationRow<T>) => Promise<void>;
}

export function consume<T>(_options: WorkerConsumerOptions<T>): never {
  throw new Error("consume is not implemented in this scaffolding package.");
}

export interface SpecificationRow<T = unknown> {
  result: T;
  rowHash: string;
}

export interface SpecificationChange<T = unknown> extends SpecificationRow<T> {
  operation: "added" | "removed";
}

export interface RowStream<T = unknown> extends AsyncIterable<SpecificationChange<T>> {
  stop(): void;
  readonly dropped: number;
  readonly pending: number;
}

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

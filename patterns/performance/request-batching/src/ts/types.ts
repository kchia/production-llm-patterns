/**
 * Request Batching — Type Definitions
 *
 * Core types for grouping LLM API requests into batches for throughput efficiency.
 */

export interface BatchProcessorConfig {
  /** Maximum items per batch. Higher = better throughput but more memory and timeout risk. */
  maxBatchSize: number;
  /** Max batches running simultaneously. Controls rate limit pressure. */
  maxConcurrentBatches: number;
  /** Max ms to wait for a batch to fill before flushing a partial batch. */
  flushIntervalMs: number;
  /** Per-batch retry attempts on failure. */
  retryAttempts: number;
  /** Base delay (ms) between retries. Applied with exponential backoff + jitter. */
  retryDelayMs: number;
  /** Max ms to wait for a single item before marking it timed out. */
  itemTimeoutMs: number;
}

export const DEFAULT_CONFIG: BatchProcessorConfig = {
  maxBatchSize: 20,
  maxConcurrentBatches: 3,
  flushIntervalMs: 100,
  retryAttempts: 3,
  retryDelayMs: 1000,
  itemTimeoutMs: 30000,
};

/** A single item submitted for batch processing. */
export interface BatchItem<T> {
  id: string;
  data: T;
}

/** Result for a single item. */
export interface BatchItemResult<TInput, TOutput> {
  item: BatchItem<TInput>;
  result: TOutput;
}

/** A failed item with its error. */
export interface BatchItemFailure<TInput> {
  item: BatchItem<TInput>;
  error: Error;
}

/** Aggregate metrics for a completed batch job. */
export interface BatchMetrics {
  totalItems: number;
  totalBatches: number;
  successfulBatches: number;
  failedBatches: number;
  avgBatchSize: number;
  durationMs: number;
  /** Items successfully processed. */
  successCount: number;
  /** Items that ultimately failed after all retries. */
  failureCount: number;
}

/** Aggregated result for an entire batch job. */
export interface BatchJobResult<TInput, TOutput> {
  results: BatchItemResult<TInput, TOutput>[];
  failed: BatchItemFailure<TInput>[];
  metrics: BatchMetrics;
}

/** Internal batch ready for execution. */
export interface Batch<T> {
  id: string;
  items: BatchItem<T>[];
  attempt: number;
}

/** LLM provider interface — implemented by real and mock providers. */
export interface LLMProvider<TInput, TOutput> {
  /**
   * Process a batch of items. Returns a result for each item.
   * The provider decides how to map inputs → outputs (single call, multi-call, etc.)
   */
  processBatch(items: BatchItem<TInput>[]): Promise<Map<string, TOutput>>;
}

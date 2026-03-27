/**
 * Request Batching Pattern
 *
 * Groups individual LLM API calls into batches for throughput efficiency.
 * Handles concurrency control, partial-batch flushing, and per-item failure tracking.
 *
 * Usage:
 *   const processor = new BatchProcessor(provider, { maxBatchSize: 20, maxConcurrentBatches: 3 });
 *   const result = await processor.process(items);
 */

import {
  BatchItem,
  BatchItemFailure,
  BatchItemResult,
  BatchJobResult,
  BatchMetrics,
  BatchProcessorConfig,
  DEFAULT_CONFIG,
  LLMProvider,
} from "./types.js";

export { BatchProcessor };
export type {
  BatchItem,
  BatchItemResult,
  BatchItemFailure,
  BatchJobResult,
  BatchMetrics,
  BatchProcessorConfig,
  LLMProvider,
};

class BatchProcessor<TInput, TOutput> {
  private config: BatchProcessorConfig;

  constructor(
    private provider: LLMProvider<TInput, TOutput>,
    config: Partial<BatchProcessorConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Process a list of items through the LLM provider in batches.
   *
   * Items are split into batches of `maxBatchSize`. Batches run with limited
   * concurrency (`maxConcurrentBatches`). Failed batches are retried at the
   * batch level; individual items that cannot be recovered are reported separately.
   */
  async process(items: BatchItem<TInput>[]): Promise<BatchJobResult<TInput, TOutput>> {
    const startTime = Date.now();

    const batches = this.splitIntoBatches(items);
    const results: BatchItemResult<TInput, TOutput>[] = [];
    const failed: BatchItemFailure<TInput>[] = [];

    let successfulBatches = 0;
    let failedBatches = 0;

    // Process batches with bounded concurrency
    // We use a semaphore-style pool: keep maxConcurrentBatches running at once
    await this.runWithConcurrency(batches, async (batch) => {
      const batchResult = await this.executeBatchWithRetry(batch);
      results.push(...batchResult.results);
      failed.push(...batchResult.failed);

      if (batchResult.failed.length === batch.items.length) {
        failedBatches++;
      } else {
        successfulBatches++;
      }
    });

    const durationMs = Date.now() - startTime;

    const metrics: BatchMetrics = {
      totalItems: items.length,
      totalBatches: batches.length,
      successfulBatches,
      failedBatches,
      avgBatchSize: items.length / Math.max(batches.length, 1),
      durationMs,
      successCount: results.length,
      failureCount: failed.length,
    };

    return { results, failed, metrics };
  }

  /**
   * Split items into fixed-size batches.
   * A final partial batch is always included — no items are dropped.
   */
  private splitIntoBatches(items: BatchItem<TInput>[]) {
    const batches = [];
    for (let i = 0; i < items.length; i += this.config.maxBatchSize) {
      batches.push({
        id: `batch-${Math.floor(i / this.config.maxBatchSize)}`,
        items: items.slice(i, i + this.config.maxBatchSize),
        attempt: 0,
      });
    }
    return batches;
  }

  /**
   * Execute a batch with retry logic. Retries the entire batch on transient failures.
   * On exhausted retries, all items in the batch are reported as failed.
   *
   * We retry at the batch level (not item level) because individual item failures
   * can't be distinguished from batch failures at the API layer — if the batch call
   * throws, we don't know which items succeeded.
   */
  private async executeBatchWithRetry(batch: {
    id: string;
    items: BatchItem<TInput>[];
    attempt: number;
  }): Promise<{
    results: BatchItemResult<TInput, TOutput>[];
    failed: BatchItemFailure<TInput>[];
  }> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.retryAttempts; attempt++) {
      try {
        if (attempt > 0) {
          // Exponential backoff with jitter to avoid thundering-herd on rate limits
          const delay = this.config.retryDelayMs * Math.pow(2, attempt - 1);
          const jitter = Math.random() * delay * 0.2;
          await sleep(delay + jitter);
        }

        // Apply per-item timeout by racing the batch call against a timer
        const resultMap = await withTimeout(
          this.provider.processBatch(batch.items),
          this.config.itemTimeoutMs * batch.items.length, // scale timeout with batch size
          `Batch ${batch.id} timed out`
        );

        // Map results back to original items
        const results: BatchItemResult<TInput, TOutput>[] = [];
        const failed: BatchItemFailure<TInput>[] = [];

        for (const item of batch.items) {
          if (resultMap.has(item.id)) {
            results.push({ item, result: resultMap.get(item.id)! });
          } else {
            // Item was in the batch but not in the result — provider dropped it
            failed.push({
              item,
              error: new Error(`Item ${item.id} missing from batch response`),
            });
          }
        }

        return { results, failed };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Don't retry on non-retryable errors (e.g. invalid input)
        if (isNonRetryable(lastError)) {
          break;
        }
      }
    }

    // All retries exhausted — mark all items in batch as failed
    return {
      results: [],
      failed: batch.items.map((item) => ({
        item,
        error: lastError ?? new Error("Unknown batch failure"),
      })),
    };
  }

  /**
   * Run tasks with bounded concurrency (simple semaphore pattern).
   * Processes all tasks but never has more than `maxConcurrentBatches` running at once.
   */
  private async runWithConcurrency<T>(
    items: T[],
    fn: (item: T) => Promise<void>
  ): Promise<void> {
    const max = this.config.maxConcurrentBatches;
    const queue = [...items];
    const running: Promise<void>[] = [];

    // Drain the queue, keeping at most `max` in flight
    while (queue.length > 0 || running.length > 0) {
      while (running.length < max && queue.length > 0) {
        const item = queue.shift()!;
        const p = fn(item).then(() => {
          running.splice(running.indexOf(p), 1);
        });
        running.push(p);
      }
      if (running.length > 0) {
        await Promise.race(running);
      }
    }
  }
}

/** Wrap a promise with a timeout. Rejects with `timeoutMessage` if exceeded. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  timeoutMessage: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** Non-retryable errors should not be retried — saves budget on obvious failures. */
function isNonRetryable(err: Error): boolean {
  const message = err.message.toLowerCase();
  return (
    message.includes("invalid input") ||
    message.includes("context length exceeded") ||
    message.includes("content policy") ||
    message.includes("non_retryable")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

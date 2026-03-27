/**
 * Tests for Request Batching pattern
 *
 * Coverage:
 * - Unit: batch splitting, partial-batch flushing config, metrics tracking
 * - Failure mode: exponential backoff retries, per-item timeout, rate limit recovery,
 *   partial batch failure with preserved successes, non-retryable errors
 * - Integration: end-to-end with MockLLMProvider, high-concurrency with rate limits
 */

import { describe, it, expect, beforeEach } from "vitest";
import { BatchProcessor, BatchItem } from "../index.js";
import { MockLLMProvider, MockProviderConfig } from "../mock-provider.js";

// Helper: create N items with sequential IDs
function makeItems(n: number, prefix = "item"): BatchItem<string>[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    data: `input data for ${prefix}-${i}`,
  }));
}

// Minimal mock config for fast tests
const FAST_MOCK: MockProviderConfig = {
  latencyMs: 0,
  jitterMs: 0,
  errorRate: 0,
  rateLimitRate: 0,
  tokensPerItemInput: 100,
  tokensPerItemOutput: 50,
};

// ─────────────────────────────────────────────
// UNIT TESTS
// ─────────────────────────────────────────────

describe("BatchProcessor — unit", () => {
  describe("batch splitting based on maxBatchSize", () => {
    it("splits items into correct batch count with even division", async () => {
      const provider = new MockLLMProvider(FAST_MOCK);
      const processor = new BatchProcessor(provider, { maxBatchSize: 5 });
      const items = makeItems(10);
      const result = await processor.process(items);
      // 10 items / 5 = 2 batches
      expect(result.metrics.totalBatches).toBe(2);
      expect(result.results).toHaveLength(10);
    });

    it("creates a partial final batch when items are not evenly divisible", async () => {
      const provider = new MockLLMProvider(FAST_MOCK);
      const processor = new BatchProcessor(provider, { maxBatchSize: 5 });
      const items = makeItems(13);
      const result = await processor.process(items);
      // 13 items / 5 = 3 batches (5, 5, 3)
      expect(result.metrics.totalBatches).toBe(3);
      expect(result.results).toHaveLength(13);
    });

    it("creates a single batch when items <= maxBatchSize", async () => {
      const provider = new MockLLMProvider(FAST_MOCK);
      const processor = new BatchProcessor(provider, { maxBatchSize: 20 });
      const items = makeItems(7);
      const result = await processor.process(items);
      expect(result.metrics.totalBatches).toBe(1);
      expect(result.results).toHaveLength(7);
    });

    it("creates one batch per item when maxBatchSize is 1", async () => {
      const provider = new MockLLMProvider(FAST_MOCK);
      const processor = new BatchProcessor(provider, { maxBatchSize: 1 });
      const items = makeItems(4);
      const result = await processor.process(items);
      expect(result.metrics.totalBatches).toBe(4);
      expect(result.results).toHaveLength(4);
    });

    it("handles empty input gracefully", async () => {
      const provider = new MockLLMProvider(FAST_MOCK);
      const processor = new BatchProcessor(provider);
      const result = await processor.process([]);
      expect(result.results).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
      expect(result.metrics.totalItems).toBe(0);
      expect(result.metrics.totalBatches).toBe(0);
    });
  });

  describe("partial batch flush after flushIntervalMs", () => {
    // The current BatchProcessor.process() accepts all items up-front and
    // splits them immediately. flushIntervalMs is part of the config but the
    // batching is synchronous — a partial batch is always included because
    // splitIntoBatches never drops remainder items.
    // These tests verify the partial-batch behavior that flushIntervalMs is
    // designed to ensure: no items are stranded in an unfilled batch.

    it("includes a partial final batch (items not dropped when < maxBatchSize)", async () => {
      const provider = new MockLLMProvider(FAST_MOCK);
      const processor = new BatchProcessor(provider, {
        maxBatchSize: 10,
        flushIntervalMs: 50,
      });
      // 3 items with maxBatchSize=10 should still be processed
      const items = makeItems(3);
      const result = await processor.process(items);
      expect(result.results).toHaveLength(3);
      expect(result.metrics.totalBatches).toBe(1);
    });

    it("flushIntervalMs config is stored and does not break processing", async () => {
      const provider = new MockLLMProvider(FAST_MOCK);
      const processor = new BatchProcessor(provider, {
        maxBatchSize: 5,
        flushIntervalMs: 1,
      });
      const items = makeItems(8);
      const result = await processor.process(items);
      expect(result.results).toHaveLength(8);
      expect(result.metrics.totalBatches).toBe(2);
    });
  });

  describe("metrics tracking", () => {
    it("tracks totalItems, totalBatches, successfulBatches correctly on full success", async () => {
      const provider = new MockLLMProvider({ ...FAST_MOCK, latencyMs: 1 });
      const processor = new BatchProcessor(provider, { maxBatchSize: 5 });
      const items = makeItems(12);
      const result = await processor.process(items);

      expect(result.metrics.totalItems).toBe(12);
      expect(result.metrics.totalBatches).toBe(3); // 5+5+2
      expect(result.metrics.successfulBatches).toBe(3);
      expect(result.metrics.failedBatches).toBe(0);
      expect(result.metrics.successCount).toBe(12);
      expect(result.metrics.failureCount).toBe(0);
      expect(result.metrics.durationMs).toBeGreaterThan(0);
    });

    it("computes avgBatchSize as totalItems / totalBatches", async () => {
      const provider = new MockLLMProvider(FAST_MOCK);
      const processor = new BatchProcessor(provider, { maxBatchSize: 4 });
      const items = makeItems(10);
      const result = await processor.process(items);
      // 10 items / 3 batches (4+4+2)
      expect(result.metrics.avgBatchSize).toBeCloseTo(10 / 3, 5);
    });

    it("tracks failedBatches when all items in a batch fail", async () => {
      const provider = {
        async processBatch() {
          throw new Error("total failure");
        },
      };
      const processor = new BatchProcessor(provider, {
        maxBatchSize: 5,
        retryAttempts: 0,
        retryDelayMs: 1,
      });
      const items = makeItems(10);
      const result = await processor.process(items);

      expect(result.metrics.failedBatches).toBe(2);
      expect(result.metrics.successfulBatches).toBe(0);
      expect(result.metrics.failureCount).toBe(10);
    });

    it("counts a batch as successful even with partial item failures", async () => {
      // Provider returns results for only 3 out of 5 items
      const provider = {
        async processBatch(items: BatchItem<string>[]) {
          const result = new Map<string, string>();
          items.slice(0, 3).forEach((i) => result.set(i.id, `result:${i.id}`));
          return result;
        },
      };
      const processor = new BatchProcessor(provider, {
        maxBatchSize: 5,
        retryAttempts: 0,
      });
      const items = makeItems(5);
      const result = await processor.process(items);

      // Batch is not counted as failed because some items succeeded
      expect(result.metrics.successfulBatches).toBe(1);
      expect(result.metrics.failedBatches).toBe(0);
      expect(result.metrics.successCount).toBe(3);
      expect(result.metrics.failureCount).toBe(2);
    });
  });
});

// ─────────────────────────────────────────────
// FAILURE MODE TESTS
// ─────────────────────────────────────────────

describe("BatchProcessor — failure modes", () => {
  describe("retries with exponential backoff on transient errors", () => {
    it("retries on transient error and succeeds on second attempt", async () => {
      let callCount = 0;
      const provider = {
        async processBatch(items: BatchItem<string>[]) {
          callCount++;
          if (callCount === 1) {
            throw new Error("Transient network error");
          }
          return new Map(items.map((i) => [i.id, `result:${i.id}`]));
        },
      };

      const processor = new BatchProcessor(provider, {
        maxBatchSize: 5,
        retryAttempts: 3,
        retryDelayMs: 1,
      });

      const items = makeItems(5);
      const result = await processor.process(items);

      expect(result.results).toHaveLength(5);
      expect(result.failed).toHaveLength(0);
      expect(callCount).toBe(2);
    });

    it("applies exponential backoff — later retries take longer", async () => {
      const callTimestamps: number[] = [];
      const provider = {
        async processBatch(items: BatchItem<string>[]) {
          callTimestamps.push(Date.now());
          if (callTimestamps.length <= 3) {
            throw new Error("Transient error");
          }
          return new Map(items.map((i) => [i.id, `result:${i.id}`]));
        },
      };

      const processor = new BatchProcessor(provider, {
        maxBatchSize: 5,
        maxConcurrentBatches: 1,
        retryAttempts: 3,
        retryDelayMs: 20, // base delay 20ms
      });

      const items = makeItems(5);
      await processor.process(items);

      // We expect 4 calls: initial + 3 retries (succeeds on attempt 4)
      expect(callTimestamps).toHaveLength(4);

      // Verify delays increase: delay1 ~ 20ms, delay2 ~ 40ms, delay3 ~ 80ms
      const delay1 = callTimestamps[1] - callTimestamps[0];
      const delay2 = callTimestamps[2] - callTimestamps[1];
      const delay3 = callTimestamps[3] - callTimestamps[2];

      // Each subsequent delay should be roughly double the previous (with some jitter tolerance)
      expect(delay2).toBeGreaterThan(delay1 * 1.3);
      expect(delay3).toBeGreaterThan(delay2 * 1.3);
    });

    it("marks all items failed after exhausting retries", async () => {
      let callCount = 0;
      const provider = {
        async processBatch() {
          callCount++;
          throw new Error("Persistent transient error");
        },
      };

      const processor = new BatchProcessor(provider, {
        maxBatchSize: 5,
        retryAttempts: 2,
        retryDelayMs: 1,
      });

      const items = makeItems(5);
      const result = await processor.process(items);

      expect(result.results).toHaveLength(0);
      expect(result.failed).toHaveLength(5);
      // 1 initial + 2 retries = 3 calls
      expect(callCount).toBe(3);
    });

    it("does not retry non-retryable errors", async () => {
      let callCount = 0;
      const provider = {
        async processBatch() {
          callCount++;
          throw new Error("Context length exceeded");
        },
      };

      const processor = new BatchProcessor(provider, {
        maxBatchSize: 5,
        retryAttempts: 3,
        retryDelayMs: 1,
      });

      const items = makeItems(5);
      const result = await processor.process(items);

      expect(callCount).toBe(1);
      expect(result.failed).toHaveLength(5);
    });
  });

  describe("per-item timeout handling", () => {
    it("times out batch when provider hangs — slow items do not block forever", async () => {
      const provider = {
        async processBatch(_items: BatchItem<string>[]) {
          // Hang forever
          await new Promise(() => {});
          return new Map<string, string>();
        },
      };

      const processor = new BatchProcessor(provider, {
        maxBatchSize: 3,
        maxConcurrentBatches: 1,
        retryAttempts: 0,
        itemTimeoutMs: 30, // 30ms per item, 90ms total for batch of 3
      });

      const items = makeItems(3);
      const start = Date.now();
      const result = await processor.process(items);
      const elapsed = Date.now() - start;

      expect(result.failed).toHaveLength(3);
      expect(result.results).toHaveLength(0);
      expect(elapsed).toBeLessThan(500); // should resolve quickly, not hang
      expect(result.failed[0].error.message).toContain("timed out");
    });

    it("timeout scales with batch size (larger batches get more time)", async () => {
      let batchCallTimedOut = false;
      const provider = {
        async processBatch(items: BatchItem<string>[]) {
          // Takes 150ms regardless
          await new Promise((r) => setTimeout(r, 150));
          batchCallTimedOut = false;
          return new Map(items.map((i) => [i.id, `result:${i.id}`]));
        },
      };

      // itemTimeoutMs=100, batch of 5 => total timeout = 500ms (enough for 150ms work)
      const processor = new BatchProcessor(provider, {
        maxBatchSize: 5,
        retryAttempts: 0,
        itemTimeoutMs: 100,
      });

      const items = makeItems(5);
      const result = await processor.process(items);

      // Should succeed because 5 * 100ms = 500ms timeout > 150ms work
      expect(result.results).toHaveLength(5);
      expect(result.failed).toHaveLength(0);
    });
  });

  describe("rate limit (429) recovery", () => {
    it("recovers from rate limit error via retry", async () => {
      let callCount = 0;
      const provider = {
        async processBatch(items: BatchItem<string>[]) {
          callCount++;
          if (callCount <= 2) {
            const err = new Error("Rate limit exceeded");
            (err as NodeJS.ErrnoException).code = "RATE_LIMIT";
            throw err;
          }
          return new Map(items.map((i) => [i.id, `result:${i.id}`]));
        },
      };

      const processor = new BatchProcessor(provider, {
        maxBatchSize: 5,
        maxConcurrentBatches: 1,
        retryAttempts: 3,
        retryDelayMs: 1,
      });

      const items = makeItems(5);
      const result = await processor.process(items);

      expect(result.results).toHaveLength(5);
      expect(result.failed).toHaveLength(0);
      expect(callCount).toBe(3); // 2 rate limit failures + 1 success
    });

    it("marks all items failed after rate limit exhausts all retries", async () => {
      const provider = {
        async processBatch() {
          const err = new Error("Rate limit exceeded");
          (err as NodeJS.ErrnoException).code = "RATE_LIMIT";
          throw err;
        },
      };

      const processor = new BatchProcessor(provider, {
        maxBatchSize: 5,
        maxConcurrentBatches: 1,
        retryAttempts: 2,
        retryDelayMs: 1,
      });

      const items = makeItems(5);
      const result = await processor.process(items);

      expect(result.results).toHaveLength(0);
      expect(result.failed).toHaveLength(5);
      expect(result.metrics.failedBatches).toBe(1);
    });
  });

  describe("partial batch failure — successful items preserved", () => {
    it("preserves successful items when provider drops some from response", async () => {
      const provider = {
        async processBatch(items: BatchItem<string>[]) {
          const result = new Map<string, string>();
          // Only return results for even-indexed items
          items.forEach((item, idx) => {
            if (idx % 2 === 0) {
              result.set(item.id, `result:${item.id}`);
            }
          });
          return result;
        },
      };

      const processor = new BatchProcessor(provider, {
        maxBatchSize: 10,
        retryAttempts: 0,
      });

      const items = makeItems(10);
      const result = await processor.process(items);

      // 5 even-indexed items succeed, 5 odd-indexed fail
      expect(result.results).toHaveLength(5);
      expect(result.failed).toHaveLength(5);

      // Verify the successful items have correct results
      for (const r of result.results) {
        expect(r.result).toBe(`result:${r.item.id}`);
      }

      // Verify failed items have descriptive errors
      for (const f of result.failed) {
        expect(f.error.message).toContain("missing from batch response");
      }
    });

    it("preserves items across multiple batches with mixed partial failures", async () => {
      let batchIndex = 0;
      const provider = {
        async processBatch(items: BatchItem<string>[]) {
          batchIndex++;
          const result = new Map<string, string>();
          if (batchIndex === 2) {
            // Second batch drops the last item
            items.slice(0, -1).forEach((i) => result.set(i.id, `result:${i.id}`));
          } else {
            items.forEach((i) => result.set(i.id, `result:${i.id}`));
          }
          return result;
        },
      };

      const processor = new BatchProcessor(provider, {
        maxBatchSize: 5,
        maxConcurrentBatches: 1, // sequential to control batch order
        retryAttempts: 0,
      });

      const items = makeItems(15); // 3 batches of 5
      const result = await processor.process(items);

      // 14 succeed (batch 2 lost 1), 1 failed
      expect(result.results).toHaveLength(14);
      expect(result.failed).toHaveLength(1);
    });
  });
});

// ─────────────────────────────────────────────
// INTEGRATION TESTS
// ─────────────────────────────────────────────

describe("BatchProcessor — integration", () => {
  it("end-to-end: feeds N items through MockLLMProvider, verifies all results", async () => {
    const provider = new MockLLMProvider({
      ...FAST_MOCK,
      latencyMs: 2,
      jitterMs: 1,
    });

    const processor = new BatchProcessor(provider, {
      maxBatchSize: 10,
      maxConcurrentBatches: 3,
    });

    const items = makeItems(50);
    const result = await processor.process(items);

    expect(result.results).toHaveLength(50);
    expect(result.failed).toHaveLength(0);
    expect(result.metrics.totalItems).toBe(50);
    expect(result.metrics.totalBatches).toBe(5);
    expect(result.metrics.successfulBatches).toBe(5);
    expect(result.metrics.durationMs).toBeGreaterThan(0);

    // Verify each item got the expected mock response
    const resultMap = new Map(result.results.map((r) => [r.item.id, r.result]));
    for (const item of items) {
      expect(resultMap.has(item.id)).toBe(true);
      expect(resultMap.get(item.id)).toBe(`response:${item.id}`);
    }
  });

  it("end-to-end: result identity is preserved across batches", async () => {
    const provider = {
      async processBatch(items: BatchItem<string>[]) {
        return new Map(items.map((i) => [i.id, `processed:${i.data}`]));
      },
    };

    const processor = new BatchProcessor(provider, { maxBatchSize: 5 });
    const items = makeItems(17);
    const result = await processor.process(items);

    expect(result.results).toHaveLength(17);
    for (const r of result.results) {
      expect(r.result).toBe(`processed:${r.item.data}`);
    }
  });

  it("end-to-end: concurrent processing is faster than sequential", async () => {
    const provider = new MockLLMProvider({
      ...FAST_MOCK,
      latencyMs: 20,
    });

    const items = makeItems(20);

    // Sequential: 1 concurrent batch
    const sequential = new BatchProcessor(provider, {
      maxBatchSize: 5,
      maxConcurrentBatches: 1,
    });
    const startSeq = Date.now();
    await sequential.process(items);
    const seqDuration = Date.now() - startSeq;

    provider.reset();

    // Concurrent: 4 concurrent batches
    const concurrent = new BatchProcessor(provider, {
      maxBatchSize: 5,
      maxConcurrentBatches: 4,
    });
    const startConc = Date.now();
    await concurrent.process(items);
    const concDuration = Date.now() - startConc;

    // Concurrent should be meaningfully faster
    expect(concDuration).toBeLessThan(seqDuration * 0.75);
  });

  it("high-concurrency with mock rate limits: backpressure behavior", async () => {
    // Provider that rate-limits the first few calls, then succeeds
    let callCount = 0;
    const rateLimitUntilCall = 4;
    const provider = {
      async processBatch(items: BatchItem<string>[]) {
        callCount++;
        if (callCount <= rateLimitUntilCall) {
          const err = new Error("Rate limit exceeded");
          (err as NodeJS.ErrnoException).code = "RATE_LIMIT";
          throw err;
        }
        await new Promise((r) => setTimeout(r, 5));
        return new Map(items.map((i) => [i.id, `result:${i.id}`]));
      },
    };

    const processor = new BatchProcessor(provider, {
      maxBatchSize: 5,
      maxConcurrentBatches: 3,
      retryAttempts: 5,
      retryDelayMs: 1,
    });

    const items = makeItems(25); // 5 batches
    const result = await processor.process(items);

    // All items should eventually succeed despite initial rate limits
    expect(result.results).toHaveLength(25);
    expect(result.failed).toHaveLength(0);
    // More calls than batches due to retries
    expect(callCount).toBeGreaterThan(5);
  });

  it("high-concurrency: respects maxConcurrentBatches under load", async () => {
    let concurrentCount = 0;
    let maxObservedConcurrent = 0;

    const provider = {
      async processBatch(items: BatchItem<string>[]) {
        concurrentCount++;
        maxObservedConcurrent = Math.max(maxObservedConcurrent, concurrentCount);
        await new Promise((r) => setTimeout(r, 15));
        concurrentCount--;
        return new Map(items.map((i) => [i.id, `result:${i.id}`]));
      },
    };

    const processor = new BatchProcessor(provider, {
      maxBatchSize: 5,
      maxConcurrentBatches: 2,
    });

    const items = makeItems(40); // 8 batches
    const result = await processor.process(items);

    expect(result.results).toHaveLength(40);
    expect(maxObservedConcurrent).toBeLessThanOrEqual(2);
    expect(maxObservedConcurrent).toBeGreaterThanOrEqual(1);
  });

  it("high-concurrency: mixed rate limits and successes across batches", async () => {
    // Odd-numbered calls get rate limited once, then succeed on retry
    let callCount = 0;
    const failedOnce = new Set<string>();
    const provider = {
      async processBatch(items: BatchItem<string>[]) {
        callCount++;
        const batchKey = items.map((i) => i.id).join(",");
        if (!failedOnce.has(batchKey) && callCount % 3 === 0) {
          failedOnce.add(batchKey);
          const err = new Error("Rate limit exceeded");
          (err as NodeJS.ErrnoException).code = "RATE_LIMIT";
          throw err;
        }
        await new Promise((r) => setTimeout(r, 2));
        return new Map(items.map((i) => [i.id, `result:${i.id}`]));
      },
    };

    const processor = new BatchProcessor(provider, {
      maxBatchSize: 10,
      maxConcurrentBatches: 4,
      retryAttempts: 3,
      retryDelayMs: 1,
    });

    const items = makeItems(100);
    const result = await processor.process(items);

    // All items should succeed because rate-limited batches get retried
    expect(result.results.length + result.failed.length).toBe(100);
    expect(result.metrics.totalItems).toBe(100);
    // Most or all should succeed given retries
    expect(result.results.length).toBeGreaterThanOrEqual(90);
  });
});

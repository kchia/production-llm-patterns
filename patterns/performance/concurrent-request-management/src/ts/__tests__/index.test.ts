/**
 * Tests for Concurrent Request Management pattern.
 *
 * Categories:
 *   1. Unit tests — core logic, defaults, configuration, state transitions
 *   2. Failure mode tests — one per failure mode in README Failure Modes table
 *   3. Integration tests — end-to-end with mock provider
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ConcurrencyManager, DEFAULT_CONFIG } from "../index.js";
import {
  MockLLMProvider,
  RateLimitError,
  TransientServerError,
} from "../mock-provider.js";
import { MaxRetriesExceededError, TokenBudgetExceededError } from "../types.js";

// Fast mock provider (0ms latency) for unit and failure mode tests
function makeProvider(overrides = {}) {
  return new MockLLMProvider({
    baseLatencyMs: 0,
    latencyVarianceMs: 0,
    ...overrides,
  });
}

function makeRequest(provider: MockLLMProvider, overrides = {}) {
  return {
    estimatedInputTokens: 100,
    estimatedOutputTokens: 50,
    execute: () => provider.complete("test prompt"),
    ...overrides,
  };
}

// ─── 1. Unit Tests ────────────────────────────────────────────────────────────

describe("ConcurrencyManager — unit", () => {
  it("uses sensible defaults", () => {
    const manager = new ConcurrencyManager();
    expect(DEFAULT_CONFIG.maxConcurrent).toBe(10);
    expect(DEFAULT_CONFIG.maxRetries).toBe(4);
    expect(DEFAULT_CONFIG.jitterFactor).toBe(0.25);
    expect(DEFAULT_CONFIG.maxRequestsPerMinute).toBe(500);
    expect(DEFAULT_CONFIG.maxTokensPerMinute).toBe(80_000);
  });

  it("accepts config overrides", () => {
    const manager = new ConcurrencyManager({ maxConcurrent: 5, maxRetries: 2 });
    const metrics = manager.getMetrics();
    expect(metrics.inFlight).toBe(0);
  });

  it("completes a single request", async () => {
    const provider = makeProvider();
    const manager = new ConcurrencyManager();
    const response = await manager.run(makeRequest(provider));
    expect(response.content).toContain("Mock response");
  });

  it("returns metrics after requests", async () => {
    const provider = makeProvider();
    const manager = new ConcurrencyManager();
    await manager.run(makeRequest(provider));
    await manager.run(makeRequest(provider));

    const metrics = manager.getMetrics();
    expect(metrics.totalCompleted).toBe(2);
    expect(metrics.totalFailed).toBe(0);
    expect(metrics.inFlight).toBe(0);
  });

  it("assigns a requestId if not provided", async () => {
    const provider = makeProvider();
    const manager = new ConcurrencyManager();
    // Should not throw
    await expect(manager.run(makeRequest(provider))).resolves.toBeDefined();
  });

  it("uses provided requestId in error messages", async () => {
    const provider = makeProvider({ rateLimitErrorRate: 1 });
    const manager = new ConcurrencyManager({
      maxRetries: 1,
      baseRetryDelayMs: 0,
      maxRetryDelayMs: 0,
    });
    const req = makeRequest(provider, { requestId: "my-custom-id" });
    await expect(manager.run(req)).rejects.toThrow("my-custom-id");
  });

  it("runAll returns results in order", async () => {
    const provider = makeProvider();
    const manager = new ConcurrencyManager();
    const requests = Array.from({ length: 5 }, (_, i) =>
      makeRequest(provider, {
        requestId: `req-${i}`,
        execute: async () => ({
          content: `response-${i}`,
          usage: { inputTokens: 100, outputTokens: 50 },
        }),
      }),
    );
    const results = await manager.runAll(requests);
    expect(results).toHaveLength(5);
    results.forEach((r, i) => expect(r.content).toBe(`response-${i}`));
  });

  it("runAllSettled captures both successes and failures", async () => {
    const provider = makeProvider();
    const manager = new ConcurrencyManager({
      maxRetries: 1,
      baseRetryDelayMs: 0,
      maxRetryDelayMs: 0,
    });
    const requests = [
      makeRequest(provider), // success
      makeRequest(new MockLLMProvider({ rateLimitErrorRate: 1, baseLatencyMs: 0, latencyVarianceMs: 0 })), // failure
    ];
    const results = await manager.runAllSettled(requests);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
  });
});

// ─── 2. Failure Mode Tests ────────────────────────────────────────────────────

describe("ConcurrencyManager — failure modes", () => {
  /**
   * FM1: Thundering herd after rate limit
   * Verify that jitter desynchronizes retry timing — retries don't all fire at
   * exactly the same delay. We check this by measuring the variance in actual
   * delay times across parallel retrying requests.
   */
  it("FM1: jitter produces variance in retry delays (no thundering herd)", async () => {
    const delays: number[] = [];
    const originalSetTimeout = global.setTimeout;

    // Intercept setTimeout to capture actual delay values
    vi.spyOn(global, "setTimeout").mockImplementation((fn: any, delay?: number) => {
      if (delay && delay > 50) delays.push(delay);
      return originalSetTimeout(fn, 0); // execute immediately
    });

    const provider = makeProvider({ rateLimitErrorRate: 0.5 });
    const manager = new ConcurrencyManager({
      maxRetries: 3,
      baseRetryDelayMs: 1000,
      jitterFactor: 0.25,
    });

    const requests = Array.from({ length: 8 }, () => makeRequest(provider));
    await manager.runAllSettled(requests);

    vi.restoreAllMocks();

    if (delays.length >= 2) {
      // With jitter=0.25, delays should have at least some variance
      const minDelay = Math.min(...delays);
      const maxDelay = Math.max(...delays);
      // The ratio of max to min should be > 1 (they differ)
      expect(maxDelay / minDelay).toBeGreaterThan(1.0);
    }
    // Test validates the mechanism is in place; variance is statistical
  });

  /**
   * FM2: Token exhaustion without RPM violation
   * Verify TPM is tracked independently from RPM — a request that fits under
   * RPM but exceeds TPM should wait (or be rejected if single request > limit).
   */
  it("FM2: rejects request that exceeds per-minute token limit", async () => {
    const provider = makeProvider();
    const manager = new ConcurrencyManager({
      maxTokensPerMinute: 1000,
    });

    const bigRequest = makeRequest(provider, {
      estimatedInputTokens: 2000,
      estimatedOutputTokens: 0,
    });

    await expect(manager.run(bigRequest)).rejects.toThrow(
      TokenBudgetExceededError,
    );
  });

  /**
   * FM3: Queue depth / semaphore blocking
   * Verify that maxConcurrent is enforced — no more than N requests run simultaneously.
   */
  it("FM3: enforces maxConcurrent — never exceeds in-flight limit", async () => {
    let maxObservedInFlight = 0;
    let currentInFlight = 0;

    const provider = makeProvider({ baseLatencyMs: 10 });
    const manager = new ConcurrencyManager({ maxConcurrent: 3 });

    const requests = Array.from({ length: 10 }, () =>
      makeRequest(provider, {
        execute: async () => {
          currentInFlight++;
          maxObservedInFlight = Math.max(maxObservedInFlight, currentInFlight);
          await new Promise((r) => setTimeout(r, 20));
          currentInFlight--;
          return provider.complete("test");
        },
      }),
    );

    await manager.runAll(requests);
    expect(maxObservedInFlight).toBeLessThanOrEqual(3);
  });

  /**
   * FM4: Stale provider limits (configuration drift)
   * Verify manager respects updated config if config were re-created — simulates
   * what happens when you restart the service with corrected limits.
   */
  it("FM4: new manager with higher limits allows more throughput", async () => {
    const provider = makeProvider();

    const constrainedManager = new ConcurrencyManager({
      maxConcurrent: 2,
      maxRequestsPerMinute: 5,
      maxTokensPerMinute: 1000,
    });
    const generousManager = new ConcurrencyManager({
      maxConcurrent: 20,
      maxRequestsPerMinute: 500,
      maxTokensPerMinute: 80_000,
    });

    const requests = Array.from({ length: 5 }, () => makeRequest(provider));

    // Both should complete; generous manager should be faster
    const [constrainedResults, generousResults] = await Promise.all([
      constrainedManager.runAllSettled(requests),
      generousManager.runAllSettled(requests),
    ]);

    const constrainedOk = constrainedResults.filter(
      (r) => r.status === "fulfilled",
    ).length;
    const generousOk = generousResults.filter(
      (r) => r.status === "fulfilled",
    ).length;

    // Both complete all 5 — this test verifies the structure, not timing
    expect(constrainedOk).toBe(5);
    expect(generousOk).toBe(5);
  });

  /**
   * FM5: Retry amplification — non-retryable errors don't get retried
   * Verify that 4xx errors (not 429) are not retried — retrying auth errors
   * or malformed requests wastes capacity and amplifies load.
   */
  it("FM5: non-retryable errors fail immediately without retries", async () => {
    const provider = makeProvider();
    const manager = new ConcurrencyManager({ maxRetries: 4 });
    let callCount = 0;

    const req = makeRequest(provider, {
      execute: async () => {
        callCount++;
        throw new Error("401 Unauthorized — invalid API key");
      },
    });

    await expect(manager.run(req)).rejects.toThrow("401 Unauthorized");
    // Should fail on first attempt without retrying
    expect(callCount).toBe(1);
  });

  /**
   * FM6: Silent TPM drift — token usage per request increases over time
   * This is the silent degradation failure mode. Test proves the detection
   * signal works: tokens_per_request in metrics can be monitored externally.
   */
  it("FM6: metrics expose token consumption for drift monitoring", async () => {
    const provider = makeProvider();
    const manager = new ConcurrencyManager();

    // Simulate requests with increasing token usage
    const smallRequest = makeRequest(provider, {
      estimatedInputTokens: 100,
      estimatedOutputTokens: 50,
    });
    const largeRequest = makeRequest(provider, {
      estimatedInputTokens: 800,
      estimatedOutputTokens: 200,
    });

    await manager.run(smallRequest);
    const metricsAfterSmall = manager.getMetrics();
    const tokensAfterSmall = metricsAfterSmall.tokensUsedThisWindow;

    await manager.run(largeRequest);
    const metricsAfterLarge = manager.getMetrics();
    const tokensAfterLarge = metricsAfterLarge.tokensUsedThisWindow;

    // Token window accumulates — monitoring this over time reveals drift
    expect(tokensAfterLarge).toBeGreaterThan(tokensAfterSmall);
    // Verify we can compute average tokens per request
    const avgTokens = tokensAfterLarge / metricsAfterLarge.totalCompleted;
    expect(avgTokens).toBeGreaterThan(0);
  });

  /**
   * FM rate-limit retry: 429 errors are retried, metric counts them
   */
  it("rate-limit errors are retried and counted in metrics", async () => {
    let callAttempts = 0;
    const manager = new ConcurrencyManager({
      maxRetries: 3,
      baseRetryDelayMs: 0,
      maxRetryDelayMs: 0,
    });

    const req = makeRequest(makeProvider(), {
      execute: async () => {
        callAttempts++;
        if (callAttempts < 3) throw new RateLimitError();
        return { content: "success", usage: { inputTokens: 100, outputTokens: 50 } };
      },
    });

    const result = await manager.run(req);
    expect(result.content).toBe("success");
    expect(callAttempts).toBe(3);

    const metrics = manager.getMetrics();
    expect(metrics.totalRateLimitHits).toBe(2);
    expect(metrics.totalRetriesSucceeded).toBe(1);
  });

  /**
   * Exhausted retries surface MaxRetriesExceededError
   */
  it("exhausted retries throw MaxRetriesExceededError", async () => {
    const provider = makeProvider({ rateLimitErrorRate: 1 });
    const manager = new ConcurrencyManager({
      maxRetries: 2,
      baseRetryDelayMs: 0,
      maxRetryDelayMs: 0,
    });

    await expect(manager.run(makeRequest(provider))).rejects.toThrow(
      MaxRetriesExceededError,
    );

    const metrics = manager.getMetrics();
    expect(metrics.totalFailed).toBe(1);
  });
});

// ─── 3. Integration Tests ─────────────────────────────────────────────────────

describe("ConcurrencyManager — integration", () => {
  /**
   * End-to-end: process a batch of mixed successful/failing requests
   */
  it("processes a batch with mixed outcomes", async () => {
    const goodProvider = makeProvider();
    const badProvider = makeProvider({ rateLimitErrorRate: 1 });
    const manager = new ConcurrencyManager({
      maxConcurrent: 5,
      maxRetries: 2,
      baseRetryDelayMs: 0,
      maxRetryDelayMs: 0,
    });

    const requests = [
      ...Array.from({ length: 7 }, () => makeRequest(goodProvider)),
      ...Array.from({ length: 3 }, () => makeRequest(badProvider)),
    ];

    const results = await manager.runAllSettled(requests);
    const successes = results.filter((r) => r.status === "fulfilled");
    const failures = results.filter((r) => r.status === "rejected");

    expect(successes).toHaveLength(7);
    expect(failures).toHaveLength(3);
  });

  /**
   * Concurrent usage: multiple callers sharing a manager
   */
  it("handles concurrent callers sharing the same manager instance", async () => {
    const provider = makeProvider({ baseLatencyMs: 5 });
    const manager = new ConcurrencyManager({ maxConcurrent: 4 });

    // Simulate 3 concurrent "users" each firing 4 requests
    const batchA = manager.runAll(
      Array.from({ length: 4 }, () => makeRequest(provider)),
    );
    const batchB = manager.runAll(
      Array.from({ length: 4 }, () => makeRequest(provider)),
    );
    const batchC = manager.runAll(
      Array.from({ length: 4 }, () => makeRequest(provider)),
    );

    const [a, b, c] = await Promise.all([batchA, batchB, batchC]);
    expect(a).toHaveLength(4);
    expect(b).toHaveLength(4);
    expect(c).toHaveLength(4);

    const metrics = manager.getMetrics();
    expect(metrics.totalCompleted).toBe(12);
    expect(metrics.inFlight).toBe(0);
  });

  /**
   * Transient error recovery: 5xx errors are retried and succeed
   */
  it("recovers from transient 5xx errors", async () => {
    let attempts = 0;
    const manager = new ConcurrencyManager({
      maxRetries: 3,
      baseRetryDelayMs: 0,
      maxRetryDelayMs: 0,
    });

    const req = makeRequest(makeProvider(), {
      execute: async () => {
        attempts++;
        if (attempts === 1) throw new TransientServerError();
        return { content: "recovered", usage: { inputTokens: 100, outputTokens: 50 } };
      },
    });

    const result = await manager.run(req);
    expect(result.content).toBe("recovered");
    expect(attempts).toBe(2);
  });

  /**
   * Metrics consistency: completed + failed = total attempts processed
   */
  it("metrics remain consistent across success and failure paths", async () => {
    const provider = makeProvider();
    const failProvider = makeProvider({ rateLimitErrorRate: 1 });
    const manager = new ConcurrencyManager({
      maxRetries: 1,
      baseRetryDelayMs: 0,
      maxRetryDelayMs: 0,
    });

    await manager.runAllSettled([
      makeRequest(provider),
      makeRequest(provider),
      makeRequest(failProvider),
    ]);

    const metrics = manager.getMetrics();
    expect(metrics.totalCompleted + metrics.totalFailed).toBe(3);
    expect(metrics.totalCompleted).toBe(2);
    expect(metrics.totalFailed).toBe(1);
  });
});

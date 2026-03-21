/**
 * Concurrent Request Management — core implementation.
 *
 * Two independent controls layered:
 *   1. Semaphore — caps in-flight count, preventing connection saturation.
 *   2. Dual token bucket (RPM + TPM) — prevents provider rate limit exhaustion.
 *
 * Retries use exponential backoff with ±jitter to desynchronize retry waves
 * across application instances, preventing thundering-herd re-saturation.
 */

import {
  ConcurrencyManagerConfig,
  ConcurrencyMetrics,
  LLMRequest,
  LLMResponse,
  MaxRetriesExceededError,
  RetryContext,
  TokenBudgetExceededError,
} from "./types.js";
import { RateLimitError } from "./mock-provider.js";

export const DEFAULT_CONFIG: ConcurrencyManagerConfig = {
  maxConcurrent: 10,
  maxRequestsPerMinute: 500,
  maxTokensPerMinute: 80_000,
  maxRetries: 4,
  baseRetryDelayMs: 1_000,
  maxRetryDelayMs: 60_000,
  jitterFactor: 0.25,
};

export class ConcurrencyManager {
  private readonly config: ConcurrencyManagerConfig;

  // Semaphore state
  private inFlightCount = 0;
  private waitQueue: Array<() => void> = [];

  // Rolling window rate limiting (sliding 60-second window)
  // Each entry is a timestamp (ms) when the request/token consumption was recorded.
  private requestTimestamps: number[] = [];
  private tokenTimestamps: Array<{ ts: number; tokens: number }> = [];

  // Metrics counters
  private totalCompleted = 0;
  private totalFailed = 0;
  private totalRateLimitHits = 0;
  private totalRetriesSucceeded = 0;

  constructor(config: Partial<ConcurrencyManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute a managed LLM request with concurrency control, rate limiting, and retries.
   * Caller awaits this; it returns when the request succeeds or exhausts retries.
   */
  async run(request: LLMRequest): Promise<LLMResponse> {
    const requestId = request.requestId ?? `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const estimatedTokens =
      (request.estimatedInputTokens ?? 0) +
      (request.estimatedOutputTokens ?? 0);

    // Guard: a single request that exceeds the per-minute token limit can never succeed.
    // Fail fast rather than blocking indefinitely.
    if (estimatedTokens > this.config.maxTokensPerMinute) {
      throw new TokenBudgetExceededError(
        requestId,
        estimatedTokens,
        this.config.maxTokensPerMinute,
      );
    }

    let lastError: Error = new Error("Unknown error");

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        // Step 1: Acquire semaphore slot (blocks until a slot is free)
        await this.acquireSemaphore();

        try {
          // Step 2: Wait for token bucket capacity (RPM + TPM)
          await this.waitForCapacity(estimatedTokens);

          // Record consumption before the call, not after — prevents over-admission
          // during the time the call is in flight.
          this.recordConsumption(estimatedTokens);

          // Execute the underlying LLM call
          const response = await request.execute();

          // Update token accounting with actual usage if available
          if (response.usage) {
            const actualTokens =
              response.usage.inputTokens + response.usage.outputTokens;
            if (actualTokens !== estimatedTokens) {
              // Adjust for the difference between estimate and actuals
              const delta = actualTokens - estimatedTokens;
              if (delta > 0) this.recordConsumption(delta);
              // Under-estimation: can't un-record over-reserved tokens, but
              // over-estimation is safe (conservative). Tracking difference in
              // metrics would be useful for tuning estimatedTokens over time.
            }
          }

          if (attempt > 1) this.totalRetriesSucceeded++;
          this.totalCompleted++;
          return response;
        } finally {
          // Release semaphore unconditionally so blocked callers can proceed.
          this.releaseSemaphore();
        }
      } catch (error) {
        lastError = error as Error;

        if (error instanceof TokenBudgetExceededError) {
          // Not retryable — the request itself is too large.
          this.totalFailed++;
          throw error;
        }

        const isRateLimit = isRateLimitError(error);
        const isTransient = isTransientError(error);

        if (!isRateLimit && !isTransient) {
          // Non-retryable error (4xx other than 429, auth errors, etc.)
          this.totalFailed++;
          throw error;
        }

        if (isRateLimit) this.totalRateLimitHits++;

        if (attempt < this.config.maxRetries) {
          // Calculate backoff with jitter to desynchronize retry waves
          const retryCtx: RetryContext = { attempt, lastError, requestId };
          const delay = this.calculateBackoffDelay(retryCtx, isRateLimit);
          await sleep(delay);
        }
      }
    }

    this.totalFailed++;
    throw new MaxRetriesExceededError(
      requestId,
      this.config.maxRetries,
      lastError,
    );
  }

  /**
   * Run multiple requests concurrently, respecting the configured limits.
   * Returns results in the same order as inputs (rejects on first failure by default).
   */
  async runAll(requests: LLMRequest[]): Promise<LLMResponse[]> {
    return Promise.all(requests.map((req) => this.run(req)));
  }

  /**
   * Run multiple requests concurrently, collecting both successes and failures.
   * Useful for batch jobs where partial success is acceptable.
   */
  async runAllSettled(
    requests: LLMRequest[],
  ): Promise<PromiseSettledResult<LLMResponse>[]> {
    return Promise.allSettled(requests.map((req) => this.run(req)));
  }

  getMetrics(): ConcurrencyMetrics {
    this.pruneWindows();
    const tokensUsed = this.tokenTimestamps.reduce(
      (sum, t) => sum + t.tokens,
      0,
    );
    return {
      inFlight: this.inFlightCount,
      tokensUsedThisWindow: tokensUsed,
      requestsUsedThisWindow: this.requestTimestamps.length,
      totalCompleted: this.totalCompleted,
      totalFailed: this.totalFailed,
      totalRateLimitHits: this.totalRateLimitHits,
      totalRetriesSucceeded: this.totalRetriesSucceeded,
    };
  }

  // ─── Semaphore ───────────────────────────────────────────────────────────────

  private acquireSemaphore(): Promise<void> {
    if (this.inFlightCount < this.config.maxConcurrent) {
      this.inFlightCount++;
      return Promise.resolve();
    }

    // Queue the waiter; it will be resolved when a slot is released.
    return new Promise<void>((resolve) => {
      this.waitQueue.push(() => {
        this.inFlightCount++;
        resolve();
      });
    });
  }

  private releaseSemaphore(): void {
    // Pull the next waiter from the queue if one exists.
    const next = this.waitQueue.shift();
    if (next) {
      next();
    } else {
      this.inFlightCount--;
    }
  }

  // ─── Token Bucket (sliding window) ───────────────────────────────────────────

  private async waitForCapacity(estimatedTokens: number): Promise<void> {
    // Polling interval: check capacity every 100ms rather than precise scheduling.
    // A precise scheduler would require a priority queue; polling is simpler and
    // adequate for typical LLM call patterns (requests take seconds, not microseconds).
    const pollIntervalMs = 100;
    const maxWaitMs = 70_000; // slightly more than 1 full window
    let waited = 0;

    while (true) {
      this.pruneWindows();

      const requestsOk =
        this.requestTimestamps.length < this.config.maxRequestsPerMinute;
      const currentTokenUsage = this.tokenTimestamps.reduce(
        (sum, t) => sum + t.tokens,
        0,
      );
      const tokensOk =
        currentTokenUsage + estimatedTokens <= this.config.maxTokensPerMinute;

      if (requestsOk && tokensOk) return;

      if (waited >= maxWaitMs) {
        throw new Error(
          `Timed out waiting for rate limit capacity after ${waited}ms`,
        );
      }

      await sleep(pollIntervalMs);
      waited += pollIntervalMs;
    }
  }

  private recordConsumption(tokens: number): void {
    const now = Date.now();
    this.requestTimestamps.push(now);
    this.tokenTimestamps.push({ ts: now, tokens });
  }

  /** Remove entries older than the sliding 60-second window. */
  private pruneWindows(): void {
    const cutoff = Date.now() - 60_000;
    this.requestTimestamps = this.requestTimestamps.filter((ts) => ts > cutoff);
    this.tokenTimestamps = this.tokenTimestamps.filter((t) => t.ts > cutoff);
  }

  // ─── Retry / Backoff ─────────────────────────────────────────────────────────

  /**
   * Exponential backoff with ±jitter.
   *
   * Rate limit errors use a 2× multiplier on the base delay because 429s
   * typically mean the quota won't reset for a full minute — recovering
   * faster than the quota reset just causes another 429.
   */
  private calculateBackoffDelay(
    ctx: RetryContext,
    isRateLimit: boolean,
  ): number {
    const multiplier = isRateLimit ? 2.0 : 1.0;
    const exponential =
      this.config.baseRetryDelayMs * Math.pow(2, ctx.attempt - 1) * multiplier;
    const capped = Math.min(exponential, this.config.maxRetryDelayMs);

    // Apply jitter: ±jitterFactor of the capped value
    const jitter = capped * this.config.jitterFactor * (Math.random() * 2 - 1);
    return Math.max(0, capped + jitter);
  }
}

// ─── Error Classification ─────────────────────────────────────────────────────

function isRateLimitError(error: unknown): boolean {
  if (error instanceof RateLimitError) return true;
  if (error instanceof Error) {
    // Cover providers that embed status codes in message strings
    return (
      error.message.includes("429") ||
      error.message.toLowerCase().includes("rate limit") ||
      error.message.toLowerCase().includes("too many requests")
    );
  }
  return false;
}

function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.message.includes("503") ||
      error.message.includes("500") ||
      error.message.toLowerCase().includes("service unavailable") ||
      error.message.toLowerCase().includes("internal server error")
    );
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

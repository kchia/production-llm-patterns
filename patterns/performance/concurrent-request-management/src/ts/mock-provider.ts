/**
 * Mock LLM provider for testing and benchmarks.
 *
 * Simulates realistic LLM behavior: variable latency, token counts, and
 * configurable error injection. Supports:
 *  - Configurable base latency + variance
 *  - Rate limit (429) injection at a specified failure rate
 *  - Transient 5xx injection
 *  - Configurable output token counts
 */

import type { LLMResponse } from "./types.js";

export interface MockProviderConfig {
  /** Base latency for each response in ms. Default: 100. */
  baseLatencyMs: number;
  /** Random variance added to latency: ±latencyVarianceMs. Default: 50. */
  latencyVarianceMs: number;
  /** Fraction of calls that return a 429 (0–1). Default: 0. */
  rateLimitErrorRate: number;
  /** Fraction of calls that return a 5xx transient error (0–1). Default: 0. */
  transientErrorRate: number;
  /** Average output token count. Default: 100. */
  outputTokens: number;
  /** Variance in output tokens: ±outputTokenVariance. Default: 20. */
  outputTokenVariance: number;
}

export class RateLimitError extends Error {
  readonly status = 429;
  /** Simulated retry-after in seconds. */
  readonly retryAfter: number;

  constructor(retryAfter = 5) {
    super(`429 Too Many Requests — retry after ${retryAfter}s`);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

export class TransientServerError extends Error {
  readonly status = 503;

  constructor() {
    super("503 Service Unavailable");
    this.name = "TransientServerError";
  }
}

export const DEFAULT_MOCK_CONFIG: MockProviderConfig = {
  baseLatencyMs: 100,
  latencyVarianceMs: 50,
  rateLimitErrorRate: 0,
  transientErrorRate: 0,
  outputTokens: 100,
  outputTokenVariance: 20,
};

export class MockLLMProvider {
  private callCount = 0;
  private config: MockProviderConfig;

  constructor(config: Partial<MockProviderConfig> = {}) {
    this.config = { ...DEFAULT_MOCK_CONFIG, ...config };
  }

  async complete(prompt: string): Promise<LLMResponse> {
    this.callCount++;

    // Simulate network/inference latency
    const latency =
      this.config.baseLatencyMs +
      (Math.random() * 2 - 1) * this.config.latencyVarianceMs;
    await sleep(Math.max(0, latency));

    // Inject rate limit errors (checked before transient to ensure test isolation)
    if (Math.random() < this.config.rateLimitErrorRate) {
      throw new RateLimitError(5);
    }

    // Inject transient server errors
    if (Math.random() < this.config.transientErrorRate) {
      throw new TransientServerError();
    }

    const outputTokens = Math.max(
      1,
      Math.round(
        this.config.outputTokens +
          (Math.random() * 2 - 1) * this.config.outputTokenVariance,
      ),
    );

    // Estimate input tokens naively (1 token ≈ 4 chars) — real providers return exact counts
    const inputTokens = Math.ceil(prompt.length / 4);

    return {
      content: `Mock response to: ${prompt.slice(0, 40)}...`,
      usage: {
        inputTokens,
        outputTokens,
      },
    };
  }

  getCallCount(): number {
    return this.callCount;
  }

  resetCallCount(): void {
    this.callCount = 0;
  }

  /** Update config at runtime — useful for simulating sudden error rate changes. */
  updateConfig(partial: Partial<MockProviderConfig>): void {
    this.config = { ...this.config, ...partial };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

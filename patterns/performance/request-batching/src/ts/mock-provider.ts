/**
 * Mock LLM Provider for Request Batching
 *
 * Simulates an LLM API with configurable latency, token counts, and error injection.
 * Used for tests and benchmarks — no real API calls.
 */

import { BatchItem, LLMProvider } from "./types.js";

export interface MockProviderConfig {
  /** Base latency per batch (ms). Simulates API round-trip time. */
  latencyMs: number;
  /** Additional latency variance (ms). Adds jitter: actual = latencyMs + rand(0, jitterMs). */
  jitterMs: number;
  /** Fraction of batches that fail with an error (0–1). */
  errorRate: number;
  /** Fraction of batches that fail with a 429 rate limit error specifically (0–1). */
  rateLimitRate: number;
  /** Simulated tokens per item (input). Used for token count assertions in tests. */
  tokensPerItemInput: number;
  /** Simulated tokens per item (output). */
  tokensPerItemOutput: number;
  /** If set, causes this provider to respond slowly on items whose id matches the pattern. */
  slowItemPattern?: string;
  /** Latency for slow items (ms). */
  slowItemLatencyMs?: number;
}

export const DEFAULT_MOCK_CONFIG: MockProviderConfig = {
  latencyMs: 50,
  jitterMs: 10,
  errorRate: 0,
  rateLimitRate: 0,
  tokensPerItemInput: 100,
  tokensPerItemOutput: 50,
};

export class MockLLMProvider<TInput, TOutput = string>
  implements LLMProvider<TInput, TOutput>
{
  private callCount = 0;
  private rateLimitStreak = 0;

  constructor(
    private config: MockProviderConfig = DEFAULT_MOCK_CONFIG,
    /** Optional transform — defaults to returning item id as the "response". */
    private transform?: (item: BatchItem<TInput>) => TOutput
  ) {}

  async processBatch(items: BatchItem<TInput>[]): Promise<Map<string, TOutput>> {
    this.callCount++;

    // Simulate rate limit error first (before latency) so callers see it quickly
    if (Math.random() < this.config.rateLimitRate) {
      this.rateLimitStreak++;
      const err = new Error(`Rate limit exceeded (call ${this.callCount})`);
      (err as NodeJS.ErrnoException).code = "RATE_LIMIT";
      throw err;
    }
    this.rateLimitStreak = 0;

    // Simulate generic error
    if (Math.random() < this.config.errorRate) {
      throw new Error(`Provider error on batch (call ${this.callCount})`);
    }

    // Apply base latency + jitter
    const latency =
      this.config.latencyMs + Math.random() * this.config.jitterMs;
    await sleep(latency);

    const results = new Map<string, TOutput>();

    for (const item of items) {
      // Slow item simulation — items matching the pattern take longer
      if (
        this.config.slowItemPattern &&
        item.id.includes(this.config.slowItemPattern)
      ) {
        await sleep(this.config.slowItemLatencyMs ?? 5000);
      }

      const output = this.transform
        ? this.transform(item)
        : (`response:${item.id}` as unknown as TOutput);
      results.set(item.id, output);
    }

    return results;
  }

  getCallCount(): number {
    return this.callCount;
  }

  reset(): void {
    this.callCount = 0;
    this.rateLimitStreak = 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

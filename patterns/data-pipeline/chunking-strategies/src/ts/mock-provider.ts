import type { Tokenizer } from './types.js';

export interface MockTokenizerConfig {
  /** Tokens per word ratio. Real tokenizers avg ~1.3 tokens/word for English. */
  tokensPerWord?: number;
  /** Simulate tokenizer failures for a fraction of calls (0–1). */
  errorRate?: number;
  /** Latency in ms per countTokens call (for benchmarking). */
  latencyMs?: number;
}

/**
 * Approximates GPT-style tokenization without a real tokenizer dependency.
 * Uses word splitting + a configurable tokens-per-word ratio, which is accurate
 * enough for chunk size estimation in tests and benchmarks.
 *
 * For production, swap this for tiktoken or a similar library.
 */
export class MockTokenizer implements Tokenizer {
  private tokensPerWord: number;
  private errorRate: number;
  private latencyMs: number;
  private callCount = 0;

  constructor(config: MockTokenizerConfig = {}) {
    this.tokensPerWord = config.tokensPerWord ?? 1.3;
    this.errorRate = config.errorRate ?? 0;
    this.latencyMs = config.latencyMs ?? 0;
  }

  countTokens(text: string): number {
    this.callCount++;
    this.maybeThrow();
    this.simulateLatency();
    return this.estimateTokens(text);
  }

  encode(text: string): number[] {
    this.maybeThrow();
    // Encode as word indices — sufficient for overlap slicing in tests.
    const words = text.split(/\s+/).filter(Boolean);
    return words.map((_, i) => i);
  }

  decode(tokens: number[]): string {
    // In tests, round-trip fidelity isn't needed — return placeholder.
    return `[decoded:${tokens.length}tokens]`;
  }

  getCallCount(): number {
    return this.callCount;
  }

  private estimateTokens(text: string): number {
    const words = text.split(/\s+/).filter(Boolean).length;
    return Math.ceil(words * this.tokensPerWord);
  }

  private maybeThrow(): void {
    if (this.errorRate > 0 && Math.random() < this.errorRate) {
      throw new Error('MockTokenizer: simulated tokenization failure');
    }
  }

  private simulateLatency(): void {
    if (this.latencyMs <= 0) return;
    // Synchronous busy-wait for benchmark accuracy. Not suitable for production.
    const end = Date.now() + this.latencyMs;
    while (Date.now() < end) { /* busy wait */ }
  }
}

/** Creates a default mock tokenizer with realistic GPT-4 token ratios. */
export function createMockTokenizer(overrides: MockTokenizerConfig = {}): MockTokenizer {
  return new MockTokenizer({ tokensPerWord: 1.3, ...overrides });
}

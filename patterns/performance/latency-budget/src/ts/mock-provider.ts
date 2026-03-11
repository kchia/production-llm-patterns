/**
 * Mock LLM Provider — configurable latency, tokens, and error injection
 * for testing and benchmarking the latency budget pattern.
 */

import { MockProviderConfig, MockProviderResponse } from './types';

const DEFAULT_CONFIG: MockProviderConfig = {
  latencyMs: 500,
  varianceMs: 100,
  outputTokens: 150,
  errorRate: 0,
};

export class MockProvider {
  private config: MockProviderConfig;
  private callCount = 0;

  constructor(config: Partial<MockProviderConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async generate(prompt: string, model = 'mock-gpt-4o'): Promise<MockProviderResponse> {
    const latency = this.getLatency();

    // Simulate error injection
    if (this.config.errorRate > 0 && Math.random() < this.config.errorRate) {
      await this.sleep(latency * 0.3); // Errors are faster — fail early
      throw new Error(`MockProvider error: simulated failure on call #${this.callCount}`);
    }

    await this.sleep(latency);
    this.callCount++;

    const inputTokens = Math.ceil(prompt.length / 4);

    return {
      text: `Mock response for: ${prompt.slice(0, 50)}...`,
      inputTokens,
      outputTokens: this.config.outputTokens,
      latencyMs: latency,
      model,
    };
  }

  /** Generate with an external abort signal (for budget-aware cancellation) */
  async generateWithTimeout(
    prompt: string,
    timeoutMs: number,
    model = 'mock-gpt-4o'
  ): Promise<MockProviderResponse> {
    const latency = this.getLatency();

    if (this.config.errorRate > 0 && Math.random() < this.config.errorRate) {
      await this.sleep(Math.min(latency * 0.3, timeoutMs));
      throw new Error(`MockProvider error: simulated failure`);
    }

    if (latency > timeoutMs) {
      // Simulate timeout — wait for the timeout duration, then throw
      await this.sleep(timeoutMs);
      throw new Error(`MockProvider timeout: ${latency}ms exceeds ${timeoutMs}ms budget`);
    }

    await this.sleep(latency);
    this.callCount++;

    const inputTokens = Math.ceil(prompt.length / 4);

    return {
      text: `Mock response for: ${prompt.slice(0, 50)}...`,
      inputTokens,
      outputTokens: this.config.outputTokens,
      latencyMs: latency,
      model,
    };
  }

  getCallCount(): number {
    return this.callCount;
  }

  reset(): void {
    this.callCount = 0;
  }

  /** Update config at runtime (useful for benchmarks that change scenarios) */
  updateConfig(config: Partial<MockProviderConfig>): void {
    this.config = { ...this.config, ...config };
  }

  private getLatency(): number {
    // Use deterministic latencies if provided (for reproducible tests)
    if (this.config.deterministicLatencies?.length) {
      const idx = this.callCount % this.config.deterministicLatencies.length;
      return this.config.deterministicLatencies[idx];
    }

    const { latencyMs, varianceMs } = this.config;
    const jitter = (Math.random() - 0.5) * 2 * varianceMs;
    return Math.max(1, latencyMs + jitter);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

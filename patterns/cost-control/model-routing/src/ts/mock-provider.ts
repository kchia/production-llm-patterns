import type { LLMProvider } from "./types";

/** Configuration for the mock LLM provider */
export interface MockProviderConfig {
  /** Base latency in ms for the strong model */
  strongLatencyMs: number;
  /** Base latency in ms for the mid model */
  midLatencyMs: number;
  /** Base latency in ms for the weak model */
  weakLatencyMs: number;
  /** Latency jitter range in ms (±) */
  latencyJitterMs: number;
  /** Average output tokens per response */
  avgOutputTokens: number;
  /** Error rate (0–1) — fraction of calls that throw */
  errorRate: number;
  /** Which model IDs should error (empty = all can error based on errorRate) */
  errorModels: string[];
}

const DEFAULT_CONFIG: MockProviderConfig = {
  strongLatencyMs: 800,
  midLatencyMs: 400,
  weakLatencyMs: 150,
  latencyJitterMs: 50,
  avgOutputTokens: 200,
  errorRate: 0,
  errorModels: [],
};

/**
 * Mock LLM provider for testing and benchmarks.
 * Simulates realistic latency differences between model tiers
 * and supports configurable error injection.
 */
export class MockProvider implements LLMProvider {
  private config: MockProviderConfig;
  private callCount = 0;

  constructor(config: Partial<MockProviderConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async complete(
    modelId: string,
    prompt: string,
  ): Promise<{ response: string; inputTokens: number; outputTokens: number }> {
    this.callCount++;

    // Error injection
    if (this.config.errorRate > 0) {
      const shouldError =
        this.config.errorModels.length === 0 ||
        this.config.errorModels.includes(modelId);
      if (shouldError && Math.random() < this.config.errorRate) {
        throw new Error(`MockProvider: simulated error for model ${modelId}`);
      }
    }

    const baseLatency = this.getBaseLatency(modelId);
    const jitter =
      (Math.random() - 0.5) * 2 * this.config.latencyJitterMs;
    const latency = Math.max(1, baseLatency + jitter);

    // Simulate latency
    await new Promise((resolve) => setTimeout(resolve, latency));

    // Estimate input tokens from prompt length (~4 chars per token)
    const inputTokens = Math.ceil(prompt.length / 4);
    const outputTokens =
      this.config.avgOutputTokens +
      Math.floor((Math.random() - 0.5) * 40);

    return {
      response: `[${modelId}] Mock response for prompt (${inputTokens} input tokens)`,
      inputTokens,
      outputTokens: Math.max(10, outputTokens),
    };
  }

  private getBaseLatency(modelId: string): number {
    // Map model IDs to latency tiers based on naming conventions
    const id = modelId.toLowerCase();
    if (id.includes("mini") || id.includes("small") || id.includes("flash")) {
      return this.config.weakLatencyMs;
    }
    if (id.includes("sonnet") || id.includes("haiku") || id.includes("mid")) {
      return this.config.midLatencyMs;
    }
    return this.config.strongLatencyMs;
  }

  getCallCount(): number {
    return this.callCount;
  }

  resetCallCount(): void {
    this.callCount = 0;
  }
}

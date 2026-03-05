/**
 * Mock LLM provider for testing and benchmarks.
 * Simulates realistic LLM behavior with configurable latency,
 * token counts, and error injection.
 */

export interface MockProviderConfig {
  /** Simulated latency in ms (default: 100) */
  latencyMs?: number;
  /** Latency jitter range in ms (default: 20) */
  latencyJitterMs?: number;
  /** Simulated input token count (default: 50) */
  inputTokens?: number;
  /** Simulated output token count (default: 150) */
  outputTokens?: number;
  /** Error rate from 0 to 1 (default: 0) */
  errorRate?: number;
  /** Specific error to throw when error triggers */
  errorType?: "timeout" | "rate_limit" | "server_error";
}

export interface MockLLMResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  promptVersion?: number;
  promptHash?: string;
}

export class MockLLMProvider {
  private config: Required<MockProviderConfig>;

  constructor(config: MockProviderConfig = {}) {
    this.config = {
      latencyMs: config.latencyMs ?? 100,
      latencyJitterMs: config.latencyJitterMs ?? 20,
      inputTokens: config.inputTokens ?? 50,
      outputTokens: config.outputTokens ?? 150,
      errorRate: config.errorRate ?? 0,
      errorType: config.errorType ?? "server_error",
    };
  }

  async complete(
    prompt: string,
    metadata?: { promptVersion?: number; promptHash?: string }
  ): Promise<MockLLMResponse> {
    const jitter =
      (Math.random() - 0.5) * 2 * this.config.latencyJitterMs;
    const latency = Math.max(1, this.config.latencyMs + jitter);

    await new Promise((resolve) => setTimeout(resolve, latency));

    if (Math.random() < this.config.errorRate) {
      this.throwConfiguredError();
    }

    return {
      content: `Mock response to: ${prompt.slice(0, 50)}...`,
      inputTokens: this.config.inputTokens,
      outputTokens: this.config.outputTokens,
      latencyMs: Math.round(latency),
      promptVersion: metadata?.promptVersion,
      promptHash: metadata?.promptHash,
    };
  }

  private throwConfiguredError(): never {
    switch (this.config.errorType) {
      case "timeout":
        throw new Error("LLM request timed out");
      case "rate_limit":
        throw new Error("Rate limit exceeded (429)");
      case "server_error":
      default:
        throw new Error("Internal server error (500)");
    }
  }

  /** Update config for scenario-specific testing */
  configure(updates: Partial<MockProviderConfig>): void {
    Object.assign(this.config, updates);
  }
}

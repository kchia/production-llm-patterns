import { LLMProvider, LLMOptions, LLMResponse } from "./types.js";

export interface MockProviderConfig {
  latencyMs?: number;
  latencyJitterMs?: number; // adds random jitter up to this value
  inputTokensPerChar?: number; // approximate tokenization
  outputTokens?: number; // fixed output token count
  errorRate?: number; // 0–1 probability of throwing an error
  errorMessage?: string;
  responses?: string[]; // cycle through these responses; repeats last if exhausted
}

/**
 * Mock LLM provider for testing and benchmarks.
 * Simulates realistic latency, token counts, and error injection
 * without making real API calls.
 */
export class MockLLMProvider implements LLMProvider {
  private config: Required<MockProviderConfig>;
  private callCount = 0;

  constructor(config: MockProviderConfig = {}) {
    this.config = {
      latencyMs: config.latencyMs ?? 100,
      latencyJitterMs: config.latencyJitterMs ?? 20,
      inputTokensPerChar: config.inputTokensPerChar ?? 0.25,
      outputTokens: config.outputTokens ?? 150,
      errorRate: config.errorRate ?? 0,
      errorMessage: config.errorMessage ?? "Mock provider error",
      responses: config.responses ?? [],
    };
  }

  async complete(prompt: string, _options?: LLMOptions): Promise<LLMResponse> {
    const start = Date.now();

    // simulate network + inference latency
    const jitter = Math.random() * this.config.latencyJitterMs;
    await sleep(this.config.latencyMs + jitter);

    // inject errors at configured rate
    if (Math.random() < this.config.errorRate) {
      throw new Error(this.config.errorMessage);
    }

    const content = this.nextResponse(prompt);
    const latencyMs = Date.now() - start;

    this.callCount++;

    return {
      content,
      inputTokens: Math.ceil(prompt.length * this.config.inputTokensPerChar),
      outputTokens: this.config.outputTokens,
      latencyMs,
    };
  }

  private nextResponse(prompt: string): string {
    if (this.config.responses.length === 0) {
      return `Mock response for: ${prompt.slice(0, 50)}`;
    }
    const idx = Math.min(this.callCount, this.config.responses.length - 1);
    return this.config.responses[idx];
  }

  getTotalCalls(): number {
    return this.callCount;
  }

  reset(): void {
    this.callCount = 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

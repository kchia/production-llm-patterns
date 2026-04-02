/**
 * Mock LLM Provider — Cost Dashboard
 *
 * Simulates a provider response with configurable token counts, latency,
 * and error injection. Used by tests and benchmarks without real API calls.
 */

export interface MockProviderConfig {
  /** Base latency in ms before jitter is applied. Default: 200. */
  baseLatencyMs?: number;
  /** ±ms jitter added to every response. Default: 50. */
  jitterMs?: number;
  /** Fixed input token count to return. If omitted, derived from prompt length. */
  inputTokens?: number;
  /** Fixed output token count to return. Default: 150. */
  outputTokens?: number;
  /** Fraction of requests that throw an error (0–1). Default: 0. */
  errorRate?: number;
  /** Error message to throw on injected failures. */
  errorMessage?: string;
  /** If set, overrides model name in responses. */
  modelOverride?: string;
}

export interface MockResponse {
  content: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  latencyMs: number;
}

export class MockProvider {
  private config: Required<MockProviderConfig>;
  private requestCount = 0;

  constructor(config: MockProviderConfig = {}) {
    this.config = {
      baseLatencyMs: config.baseLatencyMs ?? 200,
      jitterMs: config.jitterMs ?? 50,
      inputTokens: config.inputTokens ?? 0,          // 0 = derive from prompt
      outputTokens: config.outputTokens ?? 150,
      errorRate: config.errorRate ?? 0,
      errorMessage: config.errorMessage ?? 'Mock provider error',
      modelOverride: config.modelOverride ?? '',
    };
  }

  async complete(prompt: string, model: string = 'gpt-4o'): Promise<MockResponse> {
    this.requestCount++;

    // Simulate latency
    const latencyMs = this.config.baseLatencyMs +
      (Math.random() * 2 - 1) * this.config.jitterMs;
    await new Promise(r => setTimeout(r, latencyMs));

    // Inject errors at configured rate
    if (Math.random() < this.config.errorRate) {
      throw new Error(this.config.errorMessage);
    }

    // Derive token counts. Real tokenizers use BPE; ~4 chars/token is a common heuristic.
    const inputTokens = this.config.inputTokens > 0
      ? this.config.inputTokens
      : Math.ceil(prompt.length / 4);
    const outputTokens = this.config.outputTokens;

    return {
      content: `Mock response to: ${prompt.slice(0, 50)}...`,
      model: this.config.modelOverride || model,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
      latencyMs: Math.round(latencyMs),
    };
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  reset(): void {
    this.requestCount = 0;
  }
}

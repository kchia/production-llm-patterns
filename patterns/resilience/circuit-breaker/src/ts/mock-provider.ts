/**
 * Mock LLM provider with configurable latency, token counts, and error injection.
 * Supports deterministic error sequences for testing circuit breaker state transitions.
 */

import { LLMRequest, LLMResponse, ProviderError } from './types.js';

export interface MockProviderConfig {
  /** Simulated response latency in ms. Default: 50 */
  latencyMs?: number;
  /** Simulated tokens per response. Default: 100 */
  tokensPerResponse?: number;
  /** Probabilistic failure rate (0.0 to 1.0). Default: 0.0 */
  failureRate?: number;
  /** HTTP status code to throw on failure. Default: 503 */
  failureStatusCode?: number;
  /** Custom error message on failure. */
  errorMessage?: string;
  /**
   * Deterministic sequence of outcomes. Each entry is either 'success' or a
   * numeric status code. Once exhausted, falls back to probabilistic behavior.
   */
  errorSequence?: Array<'success' | number>;
  /** Static response content. Default: generated from prompt. */
  responseContent?: string;
  /** Simulated model name. Default: 'mock-model' */
  model?: string;
}

export class MockProvider {
  private config: Required<
    Pick<MockProviderConfig, 'latencyMs' | 'tokensPerResponse' | 'failureRate' | 'failureStatusCode' | 'model'>
  > & MockProviderConfig;
  private callCount = 0;
  private sequenceIndex = 0;

  constructor(config: MockProviderConfig = {}) {
    this.config = {
      latencyMs: 50,
      tokensPerResponse: 100,
      failureRate: 0,
      failureStatusCode: 503,
      model: 'mock-model',
      ...config,
    };
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    const start = performance.now();

    // Simulate latency
    if (this.config.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.config.latencyMs));
    }

    // Deterministic sequence takes priority over probabilistic failure
    if (this.config.errorSequence && this.sequenceIndex < this.config.errorSequence.length) {
      const outcome = this.config.errorSequence[this.sequenceIndex++];
      if (outcome !== 'success') {
        throw new ProviderError(
          this.config.errorMessage ?? `Mock provider error (status ${outcome})`,
          outcome
        );
      }
    } else if (Math.random() < this.config.failureRate) {
      throw new ProviderError(
        this.config.errorMessage ?? `Mock provider error (status ${this.config.failureStatusCode})`,
        this.config.failureStatusCode
      );
    }

    const latencyMs = performance.now() - start;
    const inputTokens = Math.ceil(request.prompt.length / 4);

    return {
      content: this.config.responseContent ?? `Response to: ${request.prompt.slice(0, 50)}`,
      tokenUsage: {
        input: inputTokens,
        output: this.config.tokensPerResponse,
        total: inputTokens + this.config.tokensPerResponse,
      },
      latencyMs,
      model: this.config.model,
    };
  }

  getCallCount(): number {
    return this.callCount;
  }

  reset(): void {
    this.callCount = 0;
    this.sequenceIndex = 0;
  }

  updateConfig(update: Partial<MockProviderConfig>): void {
    Object.assign(this.config, update);
  }
}

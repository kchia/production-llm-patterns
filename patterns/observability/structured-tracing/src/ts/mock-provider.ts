/**
 * Mock LLM Provider for structured tracing tests and benchmarks.
 *
 * Simulates realistic LLM behavior with configurable latency, token counts,
 * and error injection. Designed to exercise all tracing paths without
 * requiring a real LLM API.
 */

import { LLMRequest, LLMResponse } from './types.js';

export interface MockProviderConfig {
  /** Simulated response latency in ms. Default: 50 */
  latencyMs?: number;

  /** Probability of failure 0.0–1.0. Default: 0.0 */
  failureRate?: number;

  /** Error message when failure triggered. Default: 'Provider error' */
  errorMessage?: string;

  /** HTTP status code on error. Default: 503 */
  failureStatusCode?: number;

  /** Simulated input tokens per request. Default: 100 */
  inputTokensPerRequest?: number;

  /** Simulated output tokens per request. Default: 200 */
  outputTokensPerRequest?: number;

  /** Model name in response. Default: 'mock-model' */
  model?: string;

  /** Static response content. Default: generated from prompt */
  responseContent?: string;

  /**
   * Deterministic error sequence for testing specific failure patterns.
   * 'success' = normal response, number = error with that status code.
   * Overrides failureRate when provided.
   */
  errorSequence?: Array<'success' | number>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class MockProvider {
  private config: Required<MockProviderConfig>;
  private callCount = 0;
  private sequenceIndex = 0;

  constructor(config: MockProviderConfig = {}) {
    this.config = {
      latencyMs: config.latencyMs ?? 50,
      failureRate: config.failureRate ?? 0.0,
      errorMessage: config.errorMessage ?? 'Provider error',
      failureStatusCode: config.failureStatusCode ?? 503,
      inputTokensPerRequest: config.inputTokensPerRequest ?? 100,
      outputTokensPerRequest: config.outputTokensPerRequest ?? 200,
      model: config.model ?? 'mock-model',
      responseContent: config.responseContent ?? '',
      errorSequence: config.errorSequence ?? [],
    };
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    const start = performance.now();
    this.callCount++;

    // Simulate latency
    if (this.config.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.latencyMs));
    }

    // Determine failure from sequence or rate
    const shouldFail = this.shouldFail();

    if (shouldFail !== false) {
      throw new ProviderError(
        this.config.errorMessage,
        typeof shouldFail === 'number' ? shouldFail : this.config.failureStatusCode,
      );
    }

    const latencyMs = performance.now() - start;
    const content =
      this.config.responseContent || `Mock response for: ${request.prompt.slice(0, 50)}`;

    return {
      content,
      model: request.model ?? this.config.model,
      usage: {
        inputTokens: this.config.inputTokensPerRequest,
        outputTokens: this.config.outputTokensPerRequest,
      },
      latencyMs,
    };
  }

  private shouldFail(): false | number {
    if (this.config.errorSequence.length > 0) {
      const entry = this.config.errorSequence[this.sequenceIndex % this.config.errorSequence.length];
      this.sequenceIndex++;
      if (entry === 'success') return false;
      return entry;
    }
    if (this.config.failureRate > 0 && Math.random() < this.config.failureRate) {
      return this.config.failureStatusCode;
    }
    return false;
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

/**
 * Retry with Budget — Mock LLM Provider
 *
 * Simulates an LLM provider with configurable latency, error rates,
 * error sequences, and token counts. Supports HTTP-status-aware errors
 * and Retry-After headers for testing budget behavior.
 */

import type { LLMRequest, LLMResponse } from './types.js';
import { ProviderError } from './types.js';

export interface MockProviderConfig {
  /** Simulated response latency in milliseconds. Default: 50. */
  latencyMs?: number;
  /** Probability of failure (0.0 – 1.0). Default: 0.0. */
  failureRate?: number;
  /** HTTP status code for failures. Default: 503. */
  failureStatusCode?: number;
  /** Error message when failure is triggered. Default: "Provider unavailable". */
  errorMessage?: string;
  /** If set, the provider returns a Retry-After header (in ms) on 429 errors. */
  retryAfterMs?: number;
  /** Simulated tokens used per response. Default: 100. */
  tokensPerResponse?: number;
  /** Model name to return in responses. Default: "mock-model". */
  modelName?: string;
  /** Static response content. Default: generates from prompt. */
  responseContent?: string;
  /**
   * A sequence of outcomes to replay in order. Each entry is either
   * 'success' or a status code (429, 500, 503, etc.). Once exhausted,
   * falls back to failureRate-based behavior.
   */
  errorSequence?: Array<'success' | number>;
}

export class MockProvider {
  private config: Required<Omit<MockProviderConfig, 'errorSequence'>> & {
    errorSequence: Array<'success' | number>;
  };
  private callCount = 0;
  private sequenceIndex = 0;

  constructor(config: MockProviderConfig = {}) {
    this.config = {
      latencyMs: config.latencyMs ?? 50,
      failureRate: config.failureRate ?? 0.0,
      failureStatusCode: config.failureStatusCode ?? 503,
      errorMessage: config.errorMessage ?? 'Provider unavailable',
      retryAfterMs: config.retryAfterMs ?? 0,
      tokensPerResponse: config.tokensPerResponse ?? 100,
      modelName: config.modelName ?? 'mock-model',
      responseContent: config.responseContent ?? '',
      errorSequence: config.errorSequence ?? [],
    };
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    this.callCount++;

    // Simulate latency
    if (this.config.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.latencyMs));
    }

    // Check error sequence first
    if (this.sequenceIndex < this.config.errorSequence.length) {
      const outcome = this.config.errorSequence[this.sequenceIndex];
      this.sequenceIndex++;

      if (outcome !== 'success') {
        const statusCode = outcome;
        const retryAfter =
          statusCode === 429 && this.config.retryAfterMs > 0
            ? this.config.retryAfterMs
            : undefined;
        throw new ProviderError(this.config.errorMessage, statusCode, {
          retryAfterMs: retryAfter,
        });
      }
      // 'success' falls through to return a response
    } else {
      // Probabilistic failure
      if (Math.random() < this.config.failureRate) {
        const statusCode = this.config.failureStatusCode;
        const retryAfter =
          statusCode === 429 && this.config.retryAfterMs > 0
            ? this.config.retryAfterMs
            : undefined;
        throw new ProviderError(this.config.errorMessage, statusCode, {
          retryAfterMs: retryAfter,
        });
      }
    }

    const content =
      this.config.responseContent ||
      `Mock response for: ${request.prompt.slice(0, 50)}`;

    return {
      content,
      tokensUsed: this.config.tokensPerResponse,
      model: this.config.modelName,
      finishReason: 'stop',
    };
  }

  /** Returns the total number of calls made to this provider. */
  getCallCount(): number {
    return this.callCount;
  }

  /** Resets the call counter and error sequence index. */
  reset(): void {
    this.callCount = 0;
    this.sequenceIndex = 0;
  }

  /** Updates configuration dynamically (useful mid-test). */
  updateConfig(partial: Partial<MockProviderConfig>): void {
    if (partial.latencyMs !== undefined) this.config.latencyMs = partial.latencyMs;
    if (partial.failureRate !== undefined)
      this.config.failureRate = partial.failureRate;
    if (partial.failureStatusCode !== undefined)
      this.config.failureStatusCode = partial.failureStatusCode;
    if (partial.errorMessage !== undefined)
      this.config.errorMessage = partial.errorMessage;
    if (partial.retryAfterMs !== undefined)
      this.config.retryAfterMs = partial.retryAfterMs;
    if (partial.errorSequence !== undefined) {
      this.config.errorSequence = partial.errorSequence;
      this.sequenceIndex = 0;
    }
  }
}

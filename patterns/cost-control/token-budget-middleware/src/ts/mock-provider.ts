/**
 * Token Budget Middleware — Mock LLM Provider
 *
 * Simulates an LLM provider with configurable latency, token counts,
 * and error injection. Used for testing and benchmarks — no API keys needed.
 */

import type { LLMRequest, LLMResponse } from './types.js';

export interface MockProviderConfig {
  /** Simulated response latency in milliseconds. Default: 50. */
  latencyMs?: number;

  /** Probability of failure (0.0–1.0). Default: 0.0. */
  failureRate?: number;

  /** Error message when failure is triggered. Default: "Provider unavailable". */
  errorMessage?: string;

  /** Simulated input tokens per request. Default: derived from prompt length. */
  inputTokensPerRequest?: number;

  /** Simulated output tokens per response. Default: 100. */
  outputTokensPerResponse?: number;

  /** Model name to return in responses. Default: "mock-model". */
  modelName?: string;

  /** Static response content. Default: generates from prompt. */
  responseContent?: string;

  /**
   * If set, output tokens vary randomly within ±range of outputTokensPerResponse.
   * Simulates the variable-length nature of real LLM outputs.
   */
  outputTokenVariance?: number;
}

export class MockProvider {
  private config: Required<MockProviderConfig>;
  private callCount = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;

  constructor(config: MockProviderConfig = {}) {
    this.config = {
      latencyMs: config.latencyMs ?? 50,
      failureRate: config.failureRate ?? 0.0,
      errorMessage: config.errorMessage ?? 'Provider unavailable',
      inputTokensPerRequest: config.inputTokensPerRequest ?? 0,
      outputTokensPerResponse: config.outputTokensPerResponse ?? 100,
      modelName: config.modelName ?? 'mock-model',
      responseContent: config.responseContent ?? '',
      outputTokenVariance: config.outputTokenVariance ?? 0,
    };
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    this.callCount++;

    // Simulate latency
    if (this.config.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.latencyMs));
    }

    // Simulate failure
    if (Math.random() < this.config.failureRate) {
      throw new Error(this.config.errorMessage);
    }

    // Derive input tokens from prompt if not explicitly configured
    const inputTokens =
      this.config.inputTokensPerRequest > 0
        ? this.config.inputTokensPerRequest
        : Math.ceil(request.prompt.length / 4);

    // Apply variance to output tokens to simulate real-world variability
    let outputTokens = this.config.outputTokensPerResponse;
    if (this.config.outputTokenVariance > 0) {
      const variance = this.config.outputTokenVariance;
      outputTokens += Math.floor(Math.random() * variance * 2) - variance;
      outputTokens = Math.max(1, outputTokens);
    }

    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;

    const content =
      this.config.responseContent ||
      `Mock response for: ${request.prompt.slice(0, 50)}`;

    return {
      content,
      tokensUsed: inputTokens + outputTokens,
      inputTokens,
      outputTokens,
      model: this.config.modelName,
      finishReason: 'stop',
    };
  }

  getCallCount(): number {
    return this.callCount;
  }

  getTotalInputTokens(): number {
    return this.totalInputTokens;
  }

  getTotalOutputTokens(): number {
    return this.totalOutputTokens;
  }

  reset(): void {
    this.callCount = 0;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
  }
}

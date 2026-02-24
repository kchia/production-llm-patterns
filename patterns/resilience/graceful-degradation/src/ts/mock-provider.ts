/**
 * Graceful Degradation — Mock LLM Provider
 *
 * Simulates an LLM provider with configurable latency, error rates,
 * and token counts. Used for testing and benchmarks — no API keys needed.
 */

import type { LLMRequest, LLMResponse } from './types.js';

export interface MockProviderConfig {
  /** Simulated response latency in milliseconds. Default: 50. */
  latencyMs?: number;

  /** Probability of failure (0.0 – 1.0). Default: 0.0. */
  failureRate?: number;

  /** Error message when failure is triggered. Default: "Provider unavailable". */
  errorMessage?: string;

  /** Simulated tokens used per response. Default: 100. */
  tokensPerResponse?: number;

  /** Model name to return in responses. Default: "mock-model". */
  modelName?: string;

  /** Static response content. Default: generates from prompt. */
  responseContent?: string;
}

export class MockProvider {
  private config: Required<MockProviderConfig>;
  private callCount = 0;

  constructor(config: MockProviderConfig = {}) {
    this.config = {
      latencyMs: config.latencyMs ?? 50,
      failureRate: config.failureRate ?? 0.0,
      errorMessage: config.errorMessage ?? 'Provider unavailable',
      tokensPerResponse: config.tokensPerResponse ?? 100,
      modelName: config.modelName ?? 'mock-model',
      responseContent: config.responseContent ?? '',
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

  /** Resets the call counter. */
  resetCallCount(): void {
    this.callCount = 0;
  }
}

/**
 * Creates a simple cache-based handler.
 * Returns cached content if the prompt has been seen before.
 */
export function createCacheHandler() {
  const cache = new Map<string, { content: string; cachedAt: number }>();

  return {
    handler: async (request: LLMRequest): Promise<LLMResponse> => {
      const entry = cache.get(request.prompt);
      if (!entry) {
        throw new Error('Cache miss');
      }
      return {
        content: entry.content,
        model: 'cache',
        finishReason: 'cache_hit',
      };
    },
    populate: (prompt: string, content: string) => {
      cache.set(prompt, { content, cachedAt: Date.now() });
    },
    clear: () => cache.clear(),
    size: () => cache.size,
  };
}

/**
 * Creates a rule-based handler that matches prompts against patterns.
 */
export function createRuleBasedHandler(
  rules: Array<{ pattern: RegExp; response: string }>
) {
  return async (request: LLMRequest): Promise<LLMResponse> => {
    for (const rule of rules) {
      if (rule.pattern.test(request.prompt)) {
        return {
          content: rule.response,
          model: 'rule-based',
          finishReason: 'rule_match',
        };
      }
    }
    throw new Error('No matching rule');
  };
}

/**
 * Creates a static handler that always returns the same response.
 * Zero dependencies, zero I/O — the last resort.
 */
export function createStaticHandler(content: string) {
  return async (_request: LLMRequest): Promise<LLMResponse> => {
    return {
      content,
      model: 'static',
      finishReason: 'static_fallback',
    };
  };
}

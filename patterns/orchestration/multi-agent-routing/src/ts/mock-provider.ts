/**
 * Mock LLM provider for testing and benchmarks.
 *
 * Supports configurable latency, token counts, routing behavior, and error injection.
 * No real API calls — everything is simulated.
 */

import type { LLMProvider, LLMCompletion, CompletionOptions } from "./types.js";

export interface MockProviderConfig {
  /** Simulated latency in ms. Default: 50. */
  latencyMs?: number;
  /** Jitter added to latency (±jitterMs). Default: 10. */
  jitterMs?: number;
  /** Simulated tokens per completion. Default: 120. */
  tokensPerCompletion?: number;
  /**
   * Error injection: throw this error on every Nth call (0 = never).
   * Used to test timeout and fallback paths.
   */
  errorEveryN?: number;
  /**
   * When set, the mock returns this as the routing classification response.
   * Useful for testing specific routing outcomes without parsing real LLM output.
   */
  routingOverride?: MockRoutingOverride;
  /**
   * Per-call response override. If provided, the mock cycles through these
   * responses in order, wrapping around. Used to simulate multi-turn scenarios.
   */
  responseSequence?: string[];
}

export interface MockRoutingOverride {
  agentId: string;
  confidence: number;
  reasoning: string;
}

export class MockLLMProvider implements LLMProvider {
  private callCount = 0;
  private responseIndex = 0;
  private config: Required<MockProviderConfig>;

  constructor(config: MockProviderConfig = {}) {
    this.config = {
      latencyMs: config.latencyMs ?? 50,
      jitterMs: config.jitterMs ?? 10,
      tokensPerCompletion: config.tokensPerCompletion ?? 120,
      errorEveryN: config.errorEveryN ?? 0,
      routingOverride: config.routingOverride ?? { agentId: "", confidence: 0, reasoning: "" },
      responseSequence: config.responseSequence ?? [],
    };
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<LLMCompletion> {
    this.callCount++;

    // Error injection: throw on every Nth call
    if (this.config.errorEveryN > 0 && this.callCount % this.config.errorEveryN === 0) {
      throw new Error(`MockLLMProvider: injected error on call ${this.callCount}`);
    }

    // Simulate latency with jitter
    const jitter = (Math.random() - 0.5) * 2 * this.config.jitterMs;
    const delay = Math.max(0, this.config.latencyMs + jitter);
    const start = Date.now();
    await sleep(delay);
    const latencyMs = Date.now() - start;

    const content = this.generateContent(prompt, options);

    return {
      content,
      tokensUsed: this.config.tokensPerCompletion,
      latencyMs,
    };
  }

  private generateContent(prompt: string, _options?: CompletionOptions): string {
    // If a routing override is set, return it as a JSON routing response.
    // The router calls complete() expecting JSON with {agentId, confidence, reasoning}.
    if (this.config.routingOverride.agentId) {
      return JSON.stringify({
        agentId: this.config.routingOverride.agentId,
        confidence: this.config.routingOverride.confidence,
        reasoning: this.config.routingOverride.reasoning,
      });
    }

    // If a response sequence is configured, cycle through it
    if (this.config.responseSequence.length > 0) {
      const response = this.config.responseSequence[this.responseIndex % this.config.responseSequence.length];
      this.responseIndex++;
      return response;
    }

    // Default: echo a truncated version of the prompt back
    return `Mock response to: "${prompt.slice(0, 80)}..."`;
  }

  /** Total number of complete() calls made against this provider. */
  get totalCalls(): number {
    return this.callCount;
  }

  /** Reset call counter (useful between test cases). */
  reset(): void {
    this.callCount = 0;
    this.responseIndex = 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

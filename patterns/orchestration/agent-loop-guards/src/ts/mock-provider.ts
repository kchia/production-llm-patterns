/**
 * Mock LLM Provider for Agent Loop Guards
 *
 * Simulates LLM behavior with configurable:
 * - Latency per call
 * - Token counts per response
 * - Tool call sequences (scripted or random)
 * - Error injection
 * - Loop simulation (repeated identical tool calls)
 */

import type { LLMProvider, LLMResponse, Message, ToolCall, ToolDefinition } from './types';

export interface MockProviderConfig {
  /** Base latency per call in ms */
  latencyMs?: number;
  /** Latency jitter range in ms (±) */
  latencyJitterMs?: number;
  /** Tokens to report per response */
  tokensPerResponse?: number;
  /** Scripted responses to return in order; cycles if exhausted */
  scriptedResponses?: LLMResponse[];
  /** If true, generates repeated identical tool calls to simulate a loop */
  simulateLoop?: boolean;
  /** Tool call to repeat when simulateLoop is true */
  loopToolCall?: ToolCall;
  /** Number of calls before the loop starts (simulate initial progress) */
  loopStartAfter?: number;
  /** Inject an error on specific turn numbers (0-indexed) */
  errorOnTurns?: number[];
  /** Custom error message */
  errorMessage?: string;
}

export class MockProvider implements LLMProvider {
  private config: Required<MockProviderConfig>;
  private callCount = 0;
  private scriptIndex = 0;

  constructor(config: MockProviderConfig = {}) {
    this.config = {
      latencyMs: config.latencyMs ?? 50,
      latencyJitterMs: config.latencyJitterMs ?? 10,
      tokensPerResponse: config.tokensPerResponse ?? 150,
      scriptedResponses: config.scriptedResponses ?? [],
      simulateLoop: config.simulateLoop ?? false,
      loopToolCall: config.loopToolCall ?? { name: 'search', arguments: { query: 'same query' } },
      loopStartAfter: config.loopStartAfter ?? 2,
      errorOnTurns: config.errorOnTurns ?? [],
      errorMessage: config.errorMessage ?? 'Mock provider error',
    };
  }

  async call(_messages: Message[], _tools: ToolDefinition[]): Promise<LLMResponse> {
    const currentCall = this.callCount++;

    // Simulate latency (skip setTimeout entirely when delay is 0
    // to avoid Node.js minimum timer resolution overhead in benchmarks)
    const jitter = (Math.random() - 0.5) * 2 * this.config.latencyJitterMs;
    const delay = Math.max(0, this.config.latencyMs + jitter);
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    // Error injection
    if (this.config.errorOnTurns.includes(currentCall)) {
      throw new Error(this.config.errorMessage);
    }

    // Scripted responses take priority
    if (this.config.scriptedResponses.length > 0) {
      const response = this.config.scriptedResponses[this.scriptIndex];
      this.scriptIndex = (this.scriptIndex + 1) % this.config.scriptedResponses.length;
      return { ...response, tokensUsed: response.tokensUsed ?? this.config.tokensPerResponse };
    }

    // Loop simulation
    if (this.config.simulateLoop && currentCall >= this.config.loopStartAfter) {
      return {
        toolCalls: [this.config.loopToolCall],
        tokensUsed: this.config.tokensPerResponse,
      };
    }

    // Default: return a text response with no tool calls (natural completion)
    return {
      text: `Response for turn ${currentCall}`,
      toolCalls: [],
      tokensUsed: this.config.tokensPerResponse,
    };
  }

  /** Reset call counter and script index for reuse */
  reset(): void {
    this.callCount = 0;
    this.scriptIndex = 0;
  }

  /** Get total calls made */
  getCallCount(): number {
    return this.callCount;
  }
}

// Mock LLM provider for testing and benchmarks.
// Supports configurable latency, error injection, and tool call response scenarios.

import {
  type LLMProvider,
  type Message,
  type RawToolCall,
  type ToolSchema,
} from './types.js';

export type MockResponseScenario =
  | { type: 'valid-call'; toolName: string; args: Record<string, unknown> }
  | { type: 'malformed-json' }
  | { type: 'wrong-type'; toolName: string; args: Record<string, unknown> }
  | { type: 'missing-required'; toolName: string; args: Record<string, unknown> }
  | { type: 'hallucinated-tool'; toolName: string }
  | { type: 'api-error'; message: string }
  | { type: 'repair-success'; toolName: string; args: Record<string, unknown> }
  | { type: 'no-tool-call'; content: string };

export interface MockProviderConfig {
  // Latency in ms added to each call. Default: 0
  latencyMs: number;
  // Sequence of scenarios to return, in order (cycles when exhausted)
  scenarios: MockResponseScenario[];
  // Token counts for cost tracking. Default: 500 input, 100 output
  inputTokens: number;
  outputTokens: number;
}

const DEFAULT_CONFIG: MockProviderConfig = {
  latencyMs: 0,
  scenarios: [{ type: 'valid-call', toolName: 'get_weather', args: { city: 'Seattle' } }],
  inputTokens: 500,
  outputTokens: 100,
};

export class MockLLMProvider implements LLMProvider {
  private config: MockProviderConfig;
  private callCount = 0;

  constructor(config: Partial<MockProviderConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async chat(messages: Message[], tools: ToolSchema[]): Promise<Message> {
    // Simulate latency
    if (this.config.latencyMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.config.latencyMs));
    }

    const scenario = this.config.scenarios[this.callCount % this.config.scenarios.length];
    this.callCount++;

    return this.buildResponse(scenario, tools);
  }

  private buildResponse(scenario: MockResponseScenario, _tools: ToolSchema[]): Message {
    switch (scenario.type) {
      case 'valid-call': {
        const toolCall: RawToolCall = {
          id: `call_${this.callCount}`,
          name: scenario.toolName,
          arguments: JSON.stringify(scenario.args),
        };
        return {
          role: 'assistant',
          content: '',
          tool_calls: [toolCall],
        };
      }

      case 'malformed-json': {
        // Simulates the model producing invalid JSON for arguments
        const toolCall: RawToolCall = {
          id: `call_${this.callCount}`,
          name: 'get_weather',
          arguments: '{city: "Seattle"',  // invalid JSON — missing closing brace and quotes
        };
        return {
          role: 'assistant',
          content: '',
          tool_calls: [toolCall],
        };
      }

      case 'wrong-type': {
        const toolCall: RawToolCall = {
          id: `call_${this.callCount}`,
          name: scenario.toolName,
          arguments: JSON.stringify(scenario.args),
        };
        return {
          role: 'assistant',
          content: '',
          tool_calls: [toolCall],
        };
      }

      case 'missing-required': {
        const toolCall: RawToolCall = {
          id: `call_${this.callCount}`,
          name: scenario.toolName,
          arguments: JSON.stringify(scenario.args),
        };
        return {
          role: 'assistant',
          content: '',
          tool_calls: [toolCall],
        };
      }

      case 'hallucinated-tool': {
        // The model calls a tool that was never provided in the schema
        const toolCall: RawToolCall = {
          id: `call_${this.callCount}`,
          name: scenario.toolName,
          arguments: JSON.stringify({ query: 'test' }),
        };
        return {
          role: 'assistant',
          content: '',
          tool_calls: [toolCall],
        };
      }

      case 'api-error':
        throw new Error(scenario.message);

      case 'repair-success': {
        const toolCall: RawToolCall = {
          id: `call_${this.callCount}`,
          name: scenario.toolName,
          arguments: JSON.stringify(scenario.args),
        };
        return {
          role: 'assistant',
          content: '',
          tool_calls: [toolCall],
        };
      }

      case 'no-tool-call':
        return {
          role: 'assistant',
          content: scenario.content,
        };

      default: {
        const _exhaustive: never = scenario;
        throw new Error(`Unknown scenario type: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /** Reset call counter (useful between test cases) */
  reset(): void {
    this.callCount = 0;
  }

  getCallCount(): number {
    return this.callCount;
  }
}

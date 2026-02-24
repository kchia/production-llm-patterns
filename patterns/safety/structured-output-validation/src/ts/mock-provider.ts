/**
 * Structured Output Validation — Mock LLM Provider
 *
 * Simulates an LLM provider with configurable structured output behavior:
 * - Valid JSON responses
 * - Malformed JSON (truncated, missing fields, wrong types)
 * - Markdown-wrapped JSON
 * - Non-JSON text responses
 * - Configurable latency and error injection
 *
 * No API keys needed. Used for testing and benchmarks.
 */

import type { LLMRequest, LLMResponse } from './types.js';

/** What kind of malformed output the mock should produce. */
export type OutputMode =
  | 'valid'              // Well-formed JSON matching the expected schema
  | 'truncated'          // JSON cut off mid-object (simulates max_tokens)
  | 'missing_field'      // Valid JSON but missing a required field
  | 'wrong_type'         // Valid JSON but a field has the wrong type
  | 'extra_text'         // Valid JSON surrounded by prose text
  | 'markdown_wrapped'   // Valid JSON inside ```json code fence
  | 'invalid_json'       // Syntactically broken JSON (unbalanced braces, trailing commas)
  | 'non_json'           // Plain text, no JSON at all
  | 'refusal';           // Model refusal message, no structured output

export interface MockProviderConfig {
  /** Simulated response latency in milliseconds. Default: 10. */
  latencyMs?: number;

  /** Probability of throwing an error (network/API failure). Default: 0.0. */
  failureRate?: number;

  /** Error message when failure triggers. Default: "Provider unavailable". */
  errorMessage?: string;

  /** Simulated tokens used per response. Default: 50. */
  tokensPerResponse?: number;

  /** Model name in responses. Default: "mock-structured". */
  modelName?: string;

  /**
   * Output mode controlling what the mock returns.
   * Can be a single mode or an array — if array, cycles through them per call.
   */
  outputMode?: OutputMode | OutputMode[];

  /**
   * The valid JSON object to use as the base for responses.
   * Default: { "name": "Alice", "age": 30, "active": true }
   */
  validOutput?: Record<string, unknown>;
}

const DEFAULT_VALID_OUTPUT = { name: 'Alice', age: 30, active: true };

export class MockProvider {
  private config: Required<Omit<MockProviderConfig, 'outputMode' | 'validOutput'>> & {
    outputModes: OutputMode[];
    validOutput: Record<string, unknown>;
  };
  private callCount = 0;

  constructor(config: MockProviderConfig = {}) {
    const modes = config.outputMode
      ? Array.isArray(config.outputMode) ? config.outputMode : [config.outputMode]
      : ['valid' as OutputMode];

    this.config = {
      latencyMs: config.latencyMs ?? 10,
      failureRate: config.failureRate ?? 0.0,
      errorMessage: config.errorMessage ?? 'Provider unavailable',
      tokensPerResponse: config.tokensPerResponse ?? 50,
      modelName: config.modelName ?? 'mock-structured',
      outputModes: modes,
      validOutput: config.validOutput ?? DEFAULT_VALID_OUTPUT,
    };
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    this.callCount++;

    // Simulate latency
    if (this.config.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.latencyMs));
    }

    // Simulate network/API failure
    if (Math.random() < this.config.failureRate) {
      throw new Error(this.config.errorMessage);
    }

    // Cycle through output modes
    const modeIndex = (this.callCount - 1) % this.config.outputModes.length;
    const mode = this.config.outputModes[modeIndex];
    const content = this.generateOutput(mode);

    return {
      content,
      tokensUsed: this.config.tokensPerResponse,
      model: this.config.modelName,
      finishReason: mode === 'truncated' ? 'length' : 'stop',
    };
  }

  private generateOutput(mode: OutputMode): string {
    const valid = this.config.validOutput;
    const validJson = JSON.stringify(valid);

    switch (mode) {
      case 'valid':
        return validJson;

      case 'truncated': {
        // Cut JSON roughly in half to simulate max_tokens truncation
        const cutPoint = Math.floor(validJson.length * 0.6);
        return validJson.slice(0, cutPoint);
      }

      case 'missing_field': {
        // Remove the first key from the object
        const keys = Object.keys(valid);
        if (keys.length === 0) return '{}';
        const partial = { ...valid };
        delete partial[keys[0]];
        return JSON.stringify(partial);
      }

      case 'wrong_type': {
        // Stringify numeric values, numericize string values
        const mutated = { ...valid };
        for (const [key, value] of Object.entries(mutated)) {
          if (typeof value === 'number') {
            mutated[key] = String(value);
            break;
          }
          if (typeof value === 'string') {
            mutated[key] = 999;
            break;
          }
        }
        return JSON.stringify(mutated);
      }

      case 'extra_text':
        return `Here is the data you requested:\n${validJson}\nI hope this helps!`;

      case 'markdown_wrapped':
        return `\`\`\`json\n${validJson}\n\`\`\``;

      case 'invalid_json': {
        // Trailing comma and missing closing brace
        const inner = validJson.slice(1, -1);
        return `{${inner},}`;
      }

      case 'non_json':
        return 'I apologize, but I cannot provide the requested information in the specified format.';

      case 'refusal':
        return 'I\'m sorry, but I can\'t assist with that request due to safety guidelines.';

      default:
        return validJson;
    }
  }

  /** Total calls made to this provider instance. */
  getCallCount(): number {
    return this.callCount;
  }

  /** Reset the call counter. */
  resetCallCount(): void {
    this.callCount = 0;
  }
}

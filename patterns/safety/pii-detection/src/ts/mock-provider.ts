/**
 * Mock LLM Provider for PII Detection pattern
 *
 * Simulates an LLM API with configurable latency, token counts,
 * error injection, and optional PII echoing for testing detection.
 */

import type { MockProviderConfig, MockLLMResponse } from './types.js';

/** Sample PII strings for injection into test scenarios */
const SAMPLE_PII = {
  ssn: '123-45-6789',
  creditCard: '4111-1111-1111-1111',
  email: 'john.doe@example.com',
  phone: '(555) 123-4567',
  person: 'John Smith',
  ipAddress: '192.168.1.100',
};

export class MockLLMProvider {
  private config: Required<MockProviderConfig>;

  constructor(config: MockProviderConfig = {}) {
    this.config = {
      latencyMs: config.latencyMs ?? 50,
      outputTokens: config.outputTokens ?? 100,
      errorToThrow: config.errorToThrow ?? (null as unknown as Error),
      responseText: config.responseText ?? '',
    };
  }

  /** Simulate an LLM completion call */
  async complete(input: string): Promise<MockLLMResponse> {
    const start = performance.now();

    // Simulate network latency
    if (this.config.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.latencyMs));
    }

    // Error injection
    if (this.config.errorToThrow) {
      throw this.config.errorToThrow;
    }

    const responseText = this.config.responseText || input;
    const latencyMs = performance.now() - start;

    // Rough token estimate: ~4 chars per token
    const inputTokens = Math.ceil(input.length / 4);
    const outputTokens = this.config.outputTokens;

    return {
      text: responseText,
      usage: { inputTokens, outputTokens },
      latencyMs,
    };
  }

  /**
   * Generate a response that contains PII — useful for testing
   * output-side detection.
   */
  async completeWithPII(
    input: string,
    piiTypes: (keyof typeof SAMPLE_PII)[] = ['ssn', 'email', 'person']
  ): Promise<MockLLMResponse> {
    const piiSnippets = piiTypes
      .map((type) => SAMPLE_PII[type])
      .join(', ');

    const responseWithPII = `Based on the query, the contact is ${piiSnippets}. ${input}`;

    const originalResponse = this.config.responseText;
    this.config.responseText = responseWithPII;

    const result = await this.complete(input);

    this.config.responseText = originalResponse;
    return result;
  }

  /** Update config for mid-test scenario changes */
  updateConfig(updates: Partial<MockProviderConfig>): void {
    Object.assign(this.config, updates);
  }
}

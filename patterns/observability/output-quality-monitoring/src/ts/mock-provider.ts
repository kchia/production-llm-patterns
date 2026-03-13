/**
 * Output Quality Monitoring — Mock LLM Provider
 *
 * Simulates an LLM provider with configurable quality degradation,
 * latency, token counts, and error injection. Designed for testing
 * the quality monitoring pipeline without real API calls.
 */

import { LLMInteraction } from './types.js';

export interface MockProviderConfig {
  /** Base latency in ms for each call */
  baseLatencyMs: number;
  /** Random latency jitter added on top of base (0-1, fraction of base) */
  latencyJitter: number;
  /** Base quality level for generated outputs (0.0-1.0) */
  baseQuality: number;
  /** Fraction of calls that return errors (0.0-1.0) */
  errorRate: number;
  /** Average input tokens per request */
  avgInputTokens: number;
  /** Average output tokens per request */
  avgOutputTokens: number;
  /** Optional: quality degradation per call (simulates drift) */
  qualityDegradationPerCall: number;
}

export const DEFAULT_MOCK_CONFIG: MockProviderConfig = {
  baseLatencyMs: 200,
  latencyJitter: 0.2,
  baseQuality: 0.9,
  errorRate: 0,
  avgInputTokens: 500,
  avgOutputTokens: 200,
  qualityDegradationPerCall: 0,
};

/**
 * Predefined output quality tiers. The mock provider selects words
 * and structure based on the current quality level to produce outputs
 * that score differently against deterministic scorers.
 */
const QUALITY_TEMPLATES = {
  high: [
    'The analysis shows that {topic} demonstrates significant impact across multiple dimensions. Key findings include concrete metrics and specific data points.',
    'Based on the available evidence, {topic} has measurable effects. The primary factors are well-documented with supporting data.',
    'Research indicates {topic} operates through several well-understood mechanisms. The evidence base includes quantitative measurements.',
  ],
  medium: [
    'The topic of {topic} has some important aspects. There are various factors to consider when looking at this.',
    '{topic} is relevant in several ways. Some analysis suggests there are multiple considerations.',
    'Looking at {topic}, there are things to note. The situation involves different elements.',
  ],
  low: [
    '{topic} is a thing that exists.',
    'Something about {topic}.',
    '{topic}.',
  ],
};

export class MockProvider {
  private config: MockProviderConfig;
  private callCount = 0;
  private currentQuality: number;

  constructor(config: Partial<MockProviderConfig> = {}) {
    this.config = { ...DEFAULT_MOCK_CONFIG, ...config };
    this.currentQuality = this.config.baseQuality;
  }

  async complete(input: string, model = 'mock-model', promptTemplate = 'default'): Promise<LLMInteraction> {
    this.callCount++;

    // Apply degradation
    this.currentQuality = Math.max(
      0,
      this.config.baseQuality - (this.callCount * this.config.qualityDegradationPerCall)
    );

    // Simulate latency
    const jitter = this.config.baseLatencyMs * this.config.latencyJitter * (Math.random() - 0.5) * 2;
    const latency = Math.max(1, this.config.baseLatencyMs + jitter);
    await sleep(latency);

    // Simulate errors
    if (Math.random() < this.config.errorRate) {
      throw new ProviderError('Mock provider simulated error', 500);
    }

    // Generate output based on current quality
    const output = this.generateOutput(input, this.currentQuality);

    // Token counts with slight randomness
    const inputTokens = Math.round(this.config.avgInputTokens * (0.8 + Math.random() * 0.4));
    const outputTokens = Math.round(this.config.avgOutputTokens * (0.8 + Math.random() * 0.4));

    return {
      id: `mock-${this.callCount}-${Date.now()}`,
      input,
      output,
      model,
      promptTemplate,
      metadata: {
        provider: 'mock',
        qualityLevel: this.currentQuality.toFixed(3),
        callNumber: String(this.callCount),
      },
      timestamp: Date.now(),
      latencyMs: Math.round(latency),
      tokenCount: { input: inputTokens, output: outputTokens },
    };
  }

  private generateOutput(input: string, quality: number): string {
    const topic = input.slice(0, 50);

    let templates: string[];
    if (quality >= 0.7) {
      templates = QUALITY_TEMPLATES.high;
    } else if (quality >= 0.4) {
      templates = QUALITY_TEMPLATES.medium;
    } else {
      templates = QUALITY_TEMPLATES.low;
    }

    const template = templates[Math.floor(Math.random() * templates.length)];
    return template.replace('{topic}', topic);
  }

  /** Reset call count and quality level */
  reset(): void {
    this.callCount = 0;
    this.currentQuality = this.config.baseQuality;
  }

  getCallCount(): number {
    return this.callCount;
  }

  getCurrentQuality(): number {
    return this.currentQuality;
  }
}

export class ProviderError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'ProviderError';
    this.statusCode = statusCode;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

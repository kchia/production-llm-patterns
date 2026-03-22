/**
 * Mock LLM provider for testing and benchmarks.
 * Supports configurable latency, token counts, error injection,
 * and variant-specific quality simulation.
 */

import type { LLMProvider } from './types.js';

export interface MockProviderConfig {
  /** Base latency in ms (before jitter) */
  baseLatencyMs?: number;
  /** Random jitter range ±ms added to base latency */
  latencyJitterMs?: number;
  /** Average input tokens per request */
  avgInputTokens?: number;
  /** Average output tokens per request */
  avgOutputTokens?: number;
  /** Fraction of calls that throw an error (0.0–1.0) */
  errorRate?: number;
  /** Error message to throw when error is injected */
  errorMessage?: string;
  /**
   * Quality simulation: base quality score (0–1) this provider returns.
   * Multiplied with the injected qualityMetric to simulate variant differences.
   */
  qualityBias?: number;
  /**
   * If set, responses include this prefix before the normal output.
   * Simulates prompts that return preamble text before structured output —
   * a common regression when prompt wording changes.
   */
  preamble?: string;
}

export class MockLLMProvider implements LLMProvider {
  private config: Required<MockProviderConfig>;
  private callCount = 0;

  constructor(config: MockProviderConfig = {}) {
    this.config = {
      baseLatencyMs: config.baseLatencyMs ?? 200,
      latencyJitterMs: config.latencyJitterMs ?? 50,
      avgInputTokens: config.avgInputTokens ?? 150,
      avgOutputTokens: config.avgOutputTokens ?? 100,
      errorRate: config.errorRate ?? 0,
      errorMessage: config.errorMessage ?? 'Provider error',
      qualityBias: config.qualityBias ?? 1.0,
      preamble: config.preamble ?? '',
    };
  }

  async complete(
    prompt: string,
    input: string,
  ): Promise<{
    output: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  }> {
    this.callCount++;

    const start = Date.now();

    // Simulate latency. When baseLatencyMs=0, skip the sleep so benchmarks
    // can measure pattern overhead without event loop noise.
    const jitter = (Math.random() - 0.5) * 2 * this.config.latencyJitterMs;
    const latency = Math.max(0, this.config.baseLatencyMs + jitter);
    if (latency > 0) await sleep(latency);

    // Inject errors
    if (Math.random() < this.config.errorRate) {
      throw new Error(this.config.errorMessage);
    }

    const actualLatency = Date.now() - start;

    // Token count with ±20% variation
    const inputTokens = Math.round(
      this.config.avgInputTokens * (0.8 + Math.random() * 0.4),
    );
    const outputTokens = Math.round(
      this.config.avgOutputTokens * (0.8 + Math.random() * 0.4),
    );

    // Build output — preamble simulates prompt regressions
    const output = this.config.preamble
      ? `${this.config.preamble}\n${generateOutput(prompt, input)}`
      : generateOutput(prompt, input);

    return { output, inputTokens, outputTokens, latencyMs: actualLatency };
  }

  getCallCount(): number {
    return this.callCount;
  }

  reset(): void {
    this.callCount = 0;
  }
}

function generateOutput(prompt: string, input: string): string {
  // Deterministic-ish output for testing; varies enough to simulate real responses
  return `Response to: ${input.slice(0, 40)} [prompt hash: ${hashString(prompt)}]`;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 10000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

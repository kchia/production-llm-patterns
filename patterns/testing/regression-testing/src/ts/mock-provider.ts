/**
 * Mock LLM Provider for Regression Testing
 *
 * Simulates LLM responses with configurable latency, token counts,
 * error injection, and deterministic output mapping. Supports version-aware
 * output to simulate prompt/model changes between regression runs.
 */

import { ProviderResponse } from "./types";

export interface MockProviderConfig {
  /** Base latency in ms */
  latencyMs?: number;
  /** Max random jitter added to base latency */
  latencyJitterMs?: number;
  /** Average input tokens per request */
  avgInputTokens?: number;
  /** Average output tokens per request */
  avgOutputTokens?: number;
  /** Fraction of requests that throw errors (0.0 – 1.0) */
  errorRate?: number;
  /** Custom error factory */
  errorFactory?: () => Error;
  /** Deterministic output map: input → output */
  outputMap?: Map<string, string>;
  /** Default output when input isn't in outputMap */
  defaultOutput?: string;
  /** Simulate timeout by never resolving */
  hangForever?: boolean;
}

const DEFAULTS = {
  latencyMs: 50,
  latencyJitterMs: 20,
  avgInputTokens: 100,
  avgOutputTokens: 200,
  errorRate: 0,
  defaultOutput: "This is a mock LLM response.",
} as const;

export interface MockProvider {
  (input: string): Promise<ProviderResponse>;
  getCallCount: () => number;
  resetCallCount: () => void;
}

export function createMockProvider(
  config: MockProviderConfig = {}
): MockProvider {
  const opts = { ...DEFAULTS, ...config };
  let callCount = 0;

  const provider = async (input: string): Promise<ProviderResponse> => {
    callCount++;

    if (config.hangForever) {
      return new Promise(() => {});
    }

    if (opts.errorRate > 0 && Math.random() < opts.errorRate) {
      const err = config.errorFactory
        ? config.errorFactory()
        : new Error("Mock provider error: simulated failure");
      throw err;
    }

    const jitter = Math.random() * opts.latencyJitterMs;
    const totalLatency = opts.latencyMs + jitter;
    await sleep(totalLatency);

    const output = config.outputMap?.get(input) ?? opts.defaultOutput;

    const inputTokens =
      opts.avgInputTokens > 0
        ? opts.avgInputTokens
        : Math.ceil(input.split(/\s+/).length * 1.3);
    const outputTokens =
      opts.avgOutputTokens > 0
        ? opts.avgOutputTokens
        : Math.ceil(output.split(/\s+/).length * 1.3);

    return {
      output,
      latencyMs: totalLatency,
      tokenUsage: { input: inputTokens, output: outputTokens },
    };
  };

  provider.getCallCount = () => callCount;
  provider.resetCallCount = () => {
    callCount = 0;
  };

  return provider;
}

/**
 * Creates two providers that simulate a prompt version change.
 * The "before" provider returns baseline outputs, the "after" provider
 * returns modified outputs for specific inputs (simulating a regression
 * or improvement on certain categories).
 */
export function createVersionedProviders(config: {
  baselineOutputs: Map<string, string>;
  changedOutputs: Map<string, string>;
  latencyMs?: number;
}): { baseline: MockProvider; current: MockProvider } {
  const merged = new Map(config.baselineOutputs);
  for (const [k, v] of config.changedOutputs) {
    merged.set(k, v);
  }

  return {
    baseline: createMockProvider({
      outputMap: config.baselineOutputs,
      latencyMs: config.latencyMs ?? 10,
      latencyJitterMs: 0,
    }),
    current: createMockProvider({
      outputMap: merged,
      latencyMs: config.latencyMs ?? 10,
      latencyJitterMs: 0,
    }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

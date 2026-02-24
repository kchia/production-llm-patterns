/**
 * Mock LLM Provider for Eval Harness
 *
 * Simulates LLM responses with configurable latency, token counts,
 * error injection, and deterministic output mapping.
 */

import { ProviderResponse } from "./types";

export interface MockProviderConfig {
  /** Base latency in ms — actual latency is base + random jitter */
  latencyMs?: number;
  /** Max random jitter added to base latency */
  latencyJitterMs?: number;
  /** Average input tokens per request (used for token counting) */
  avgInputTokens?: number;
  /** Average output tokens per request */
  avgOutputTokens?: number;
  /** Fraction of requests that throw errors (0.0 – 1.0) */
  errorRate?: number;
  /** Custom error to throw when error is injected */
  errorFactory?: () => Error;
  /** Deterministic output map: input → output. Falls back to default output if not found. */
  outputMap?: Map<string, string>;
  /** Default output when input isn't in outputMap */
  defaultOutput?: string;
  /** If set, adds this prefix to every output */
  outputPrefix?: string;
  /** Simulate timeout by never resolving (for timeout testing) */
  hangForever?: boolean;
}

const DEFAULTS: Required<
  Omit<MockProviderConfig, "outputMap" | "errorFactory" | "outputPrefix" | "hangForever">
> = {
  latencyMs: 50,
  latencyJitterMs: 20,
  avgInputTokens: 100,
  avgOutputTokens: 200,
  errorRate: 0,
  defaultOutput: "This is a mock LLM response.",
};

export function createMockProvider(config: MockProviderConfig = {}) {
  const opts = { ...DEFAULTS, ...config };
  let callCount = 0;

  const provider = async (input: string): Promise<ProviderResponse> => {
    callCount++;

    // Hang forever (for timeout testing)
    if (config.hangForever) {
      return new Promise(() => {});
    }

    // Error injection
    if (opts.errorRate > 0 && Math.random() < opts.errorRate) {
      const err = config.errorFactory
        ? config.errorFactory()
        : new Error("Mock provider error: simulated failure");
      throw err;
    }

    // Simulate latency
    const jitter = Math.random() * opts.latencyJitterMs;
    const totalLatency = opts.latencyMs + jitter;
    await sleep(totalLatency);

    // Determine output
    let output = config.outputMap?.get(input) ?? opts.defaultOutput;
    if (config.outputPrefix) {
      output = config.outputPrefix + output;
    }

    // Estimate tokens (simple word-based approximation)
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

  // Expose call count for testing
  provider.getCallCount = () => callCount;
  provider.resetCallCount = () => {
    callCount = 0;
  };

  return provider;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

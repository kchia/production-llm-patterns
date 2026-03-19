import { Scorer, Trace } from './types.js';

export interface MockScorerConfig {
  name: string;
  samplingRate?: number;
  /** Fixed score to return. If omitted, score is randomized. */
  fixedScore?: number;
  /** Simulated scorer latency in ms. Default: 50 */
  latencyMs?: number;
  /** Probability that the scorer throws an error. Default: 0 */
  errorRate?: number;
  /** If provided, score drifts by this amount per call (simulates degradation). */
  driftPerCall?: number;
}

/**
 * Mock scorer for testing. Supports configurable latency, fixed/random scores,
 * error injection, and drift simulation.
 */
export class MockScorer implements Scorer {
  readonly name: string;
  readonly samplingRate: number;

  private readonly config: Required<MockScorerConfig>;
  private callCount = 0;

  constructor(config: MockScorerConfig) {
    this.name = config.name;
    this.samplingRate = config.samplingRate ?? 1.0;
    this.config = {
      name: config.name,
      samplingRate: config.samplingRate ?? 1.0,
      fixedScore: config.fixedScore ?? -1,
      latencyMs: config.latencyMs ?? 50,
      errorRate: config.errorRate ?? 0,
      driftPerCall: config.driftPerCall ?? 0,
    };
  }

  async score(_trace: Trace): Promise<number> {
    await sleep(this.config.latencyMs);

    if (Math.random() < this.config.errorRate) {
      throw new Error(`MockScorer(${this.name}): injected error`);
    }

    this.callCount++;

    let base =
      this.config.fixedScore >= 0 ? this.config.fixedScore : Math.random();

    // Apply drift — score degrades by driftPerCall each call, clamped to [0, 1]
    const drift = this.config.driftPerCall * this.callCount;
    return Math.max(0, Math.min(1, base - drift));
  }

  getCallCount(): number {
    return this.callCount;
  }

  reset(): void {
    this.callCount = 0;
  }
}

/**
 * Mock LLM provider for integration tests. Returns configurable responses
 * with optional latency and error injection.
 */
export interface MockLLMConfig {
  response?: string;
  latencyMs?: number;
  errorRate?: number;
}

export class MockLLMProvider {
  private readonly config: Required<MockLLMConfig>;
  private callCount = 0;

  constructor(config: MockLLMConfig = {}) {
    this.config = {
      response: config.response ?? 'Mock LLM response',
      latencyMs: config.latencyMs ?? 10,
      errorRate: config.errorRate ?? 0,
    };
  }

  async complete(prompt: string): Promise<string> {
    await sleep(this.config.latencyMs);
    this.callCount++;

    if (Math.random() < this.config.errorRate) {
      throw new Error('MockLLMProvider: injected error');
    }

    return `${this.config.response} [prompt_len=${prompt.length}]`;
  }

  getCallCount(): number {
    return this.callCount;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

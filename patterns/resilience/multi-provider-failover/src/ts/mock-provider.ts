import type { LLMRequest, LLMResponse, ProviderHandler } from './types.js';
import { ProviderError } from './types.js';

export interface MockProviderConfig {
  name: string;
  /** Base latency in ms. Actual latency adds ±20% jitter. */
  latencyMs?: number;
  /** Fraction of requests that fail (0-1). Default: 0. */
  failureRate?: number;
  /** HTTP status code to return on failure. Default: 503. */
  failureStatusCode?: number;
  /** Average tokens per response. Default: 100. */
  avgTokens?: number;
  /** Model name string. Default: "mock-model". */
  model?: string;
}

/**
 * Mock LLM provider for testing and benchmarks.
 * Supports configurable latency, failure rate, and error injection.
 */
export class MockProvider {
  private requestCount = 0;
  private readonly config: Required<MockProviderConfig>;

  // Injectable failure schedule — overrides failureRate when set.
  // Each entry is consumed in order; true = fail, false = succeed.
  private failureSchedule: boolean[] = [];

  constructor(config: MockProviderConfig) {
    this.config = {
      name: config.name,
      latencyMs: config.latencyMs ?? 200,
      failureRate: config.failureRate ?? 0,
      failureStatusCode: config.failureStatusCode ?? 503,
      avgTokens: config.avgTokens ?? 100,
      model: config.model ?? 'mock-model',
    };
  }

  /** Set a deterministic failure schedule for testing. */
  setFailureSchedule(schedule: boolean[]): void {
    this.failureSchedule = [...schedule];
  }

  /** Update config at runtime (useful for injecting failures mid-benchmark). */
  updateConfig(partial: Partial<MockProviderConfig>): void {
    Object.assign(this.config, partial);
  }

  get name(): string {
    return this.config.name;
  }

  get handler(): ProviderHandler {
    return this.handle.bind(this);
  }

  async handle(request: LLMRequest): Promise<LLMResponse> {
    this.requestCount++;
    const start = performance.now();

    // Simulate latency with ±20% jitter
    const jitter = 1 + (Math.random() * 0.4 - 0.2);
    const delay = this.config.latencyMs * jitter;
    await sleep(delay);

    // Determine failure: schedule takes priority over random rate
    const shouldFail =
      this.failureSchedule.length > 0
        ? this.failureSchedule.shift()!
        : Math.random() < this.config.failureRate;

    if (shouldFail) {
      throw new ProviderError(
        `${this.config.name} returned ${this.config.failureStatusCode}`,
        this.config.failureStatusCode,
        this.config.name,
      );
    }

    const latencyMs = performance.now() - start;
    const tokens =
      this.config.avgTokens + Math.floor(Math.random() * 20 - 10);

    return {
      content: `Response from ${this.config.name}: ${request.prompt.slice(0, 50)}`,
      tokensUsed: Math.max(1, tokens),
      model: this.config.model,
      finishReason: 'stop',
      latencyMs,
    };
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  reset(): void {
    this.requestCount = 0;
    this.failureSchedule = [];
  }
}

/** Create a mock provider that always times out. */
export function createTimeoutProvider(
  name: string,
  timeoutMs: number,
): MockProvider {
  const provider = new MockProvider({
    name,
    // Latency set well above any reasonable timeout
    latencyMs: timeoutMs * 10,
  });
  return provider;
}

/** Create a provider that fails with a specific status code. */
export function createFailingProvider(
  name: string,
  statusCode: number,
): MockProvider {
  return new MockProvider({
    name,
    failureRate: 1.0,
    failureStatusCode: statusCode,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

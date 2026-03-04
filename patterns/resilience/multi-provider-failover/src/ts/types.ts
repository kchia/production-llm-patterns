/** Standard LLM request — provider-agnostic. */
export interface LLMRequest {
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  metadata?: Record<string, unknown>;
}

/** Standard LLM response — each provider handler normalizes to this shape. */
export interface LLMResponse {
  content: string;
  tokensUsed: number;
  model: string;
  finishReason: 'stop' | 'length' | 'error';
  latencyMs: number;
}

/** A function that takes a request and returns a response. */
export type ProviderHandler = (request: LLMRequest) => Promise<LLMResponse>;

/**
 * Error categories determine routing behavior:
 * - retryable: try same provider again with backoff (429, 529)
 * - failover: try next provider immediately (500, 502, 503, 504, timeout)
 * - fatal: stop — no provider can help (400, 401, 403)
 */
export type ErrorCategory = 'retryable' | 'failover' | 'fatal';

/** An error thrown by a provider, with enough context for classification. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly provider: string,
    public readonly isTimeout: boolean = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** All providers exhausted without a successful response. */
export class AllProvidersExhaustedError extends Error {
  constructor(
    public readonly attempts: ProviderAttempt[],
    public readonly request: LLMRequest,
  ) {
    const summary = attempts
      .map((a) => `${a.provider}: ${a.error?.message ?? 'unknown'}`)
      .join(', ');
    super(`All providers exhausted: ${summary}`);
    this.name = 'AllProvidersExhaustedError';
  }
}

/** Provider health states. */
export type ProviderStatus = 'healthy' | 'cooldown' | 'unknown';

/** Snapshot of a single provider's health. */
export interface ProviderHealth {
  name: string;
  status: ProviderStatus;
  successRate: number;
  avgLatencyMs: number;
  totalRequests: number;
  cooldownUntil: number | null;
  consecutiveFailures: number;
}

/** Record of a single attempt during failover. */
export interface ProviderAttempt {
  provider: string;
  status: 'success' | 'failover' | 'retryable' | 'fatal';
  latencyMs: number;
  error?: Error;
  errorCategory?: ErrorCategory;
}

/** Result returned to the caller after the failover router finishes. */
export interface FailoverResult {
  response: LLMResponse;
  provider: string;
  attempts: ProviderAttempt[];
  failoverOccurred: boolean;
  totalLatencyMs: number;
}

/** Configuration for a single provider in the ring. */
export interface ProviderConfig {
  name: string;
  handler: ProviderHandler;
  /** Lower number = higher priority. Default: index in the array. */
  priority?: number;
  /** Per-provider timeout override in ms. */
  timeout?: number;
}

/** Top-level failover router configuration. */
export interface FailoverRouterConfig {
  providers: ProviderConfig[];
  /** Per-provider request timeout in ms. Default: 30000. */
  timeout?: number;
  /** How long a failed provider stays in cooldown, in ms. Default: 60000. */
  cooldownMs?: number;
  /** Failure rate threshold (0-1) that triggers automatic cooldown. Default: 0.5. */
  failureThreshold?: number;
  /** Number of recent requests in the sliding window. Default: 10. */
  windowSize?: number;
  /** Max providers to try per request. Default: providers.length. */
  maxFailovers?: number;
  /** Called when failover occurs. */
  onFailover?: (from: string, to: string, error: Error) => void;
  /** Called when a provider enters or exits cooldown. */
  onProviderCooldown?: (provider: string, entering: boolean) => void;
}

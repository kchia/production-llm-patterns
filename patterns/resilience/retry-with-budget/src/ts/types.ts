/**
 * Retry with Budget — Type Definitions
 *
 * Core types for the retry-with-budget pattern.
 * Framework-agnostic, no external dependencies.
 */

/** A request to an LLM provider. */
export interface LLMRequest {
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  metadata?: Record<string, unknown>;
}

/** A response from an LLM provider. */
export interface LLMResponse {
  content: string;
  tokensUsed?: number;
  model?: string;
  finishReason?: string;
}

/** An error from an LLM provider with HTTP status semantics. */
export class ProviderError extends Error {
  public readonly statusCode: number;
  public readonly retryAfterMs?: number;
  public readonly isRetryable: boolean;

  constructor(
    message: string,
    statusCode: number,
    options?: { retryAfterMs?: number; isRetryable?: boolean }
  ) {
    super(message);
    this.name = 'ProviderError';
    this.statusCode = statusCode;
    this.retryAfterMs = options?.retryAfterMs;
    // Default retryable classification based on status code
    this.isRetryable =
      options?.isRetryable ?? [429, 500, 502, 503].includes(statusCode);
  }
}

/** Configuration for the token bucket that controls retry budget. */
export interface TokenBucketConfig {
  /** Maximum tokens in the bucket. Default: 100. */
  maxTokens: number;
  /** Tokens added per successful request. Default: 0.1. */
  tokenRatio: number;
  /** Passive refill interval in milliseconds. Default: 1000. */
  refillIntervalMs: number;
  /** Tokens added per refill interval. Default: 1. */
  refillAmount: number;
}

/** Jitter strategy for randomizing backoff delays. */
export type JitterMode = 'full' | 'equal' | 'none';

/** Full configuration for RetryWithBudget. */
export interface RetryWithBudgetConfig {
  /** Maximum attempts per request, including the initial attempt. Default: 3. */
  maxAttempts?: number;
  /** Base delay for exponential backoff in milliseconds. Default: 200. */
  initialDelayMs?: number;
  /** Maximum backoff delay in milliseconds. Default: 30000. */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff. Default: 2. */
  backoffMultiplier?: number;
  /** Jitter strategy. Default: 'full'. */
  jitterMode?: JitterMode;
  /** Token bucket configuration for the retry budget. */
  budgetConfig?: Partial<TokenBucketConfig>;
  /** HTTP status codes that are retryable. Default: [429, 500, 502, 503]. */
  retryableStatuses?: number[];
  /** Callback fired on each retry attempt. */
  onRetry?: (event: RetryEvent) => void;
  /** Callback fired when the budget is exhausted. */
  onBudgetExhausted?: (event: BudgetExhaustedEvent) => void;
}

/** Information about a single retry attempt. */
export interface RetryEvent {
  attempt: number;
  maxAttempts: number;
  error: Error;
  delayMs: number;
  budgetRemaining: number;
}

/** Fired when a retry is skipped because the budget is exhausted. */
export interface BudgetExhaustedEvent {
  attempt: number;
  maxAttempts: number;
  error: Error;
  budgetRemaining: number;
  budgetMax: number;
}

/** The result of executing a request through the retry handler. */
export interface RetryResult {
  response: LLMResponse;
  attempts: number;
  totalLatencyMs: number;
  retriesUsed: number;
  budgetRemaining: number;
}

/** Error thrown when all retry attempts are exhausted. */
export class RetriesExhaustedError extends Error {
  public readonly attempts: AttemptRecord[];
  public readonly totalLatencyMs: number;
  public readonly budgetExhausted: boolean;

  constructor(
    attempts: AttemptRecord[],
    totalLatencyMs: number,
    budgetExhausted: boolean
  ) {
    const reason = budgetExhausted ? 'budget exhausted' : 'max attempts reached';
    const summary = attempts
      .map((a) => `attempt ${a.attempt}: ${a.error.message} (${a.latencyMs}ms)`)
      .join('; ');
    super(`All retries exhausted (${reason}): ${summary}`);
    this.name = 'RetriesExhaustedError';
    this.attempts = attempts;
    this.totalLatencyMs = totalLatencyMs;
    this.budgetExhausted = budgetExhausted;
  }
}

/** Record of a single attempt within the retry loop. */
export interface AttemptRecord {
  attempt: number;
  error: Error;
  latencyMs: number;
  delayMs: number;
}

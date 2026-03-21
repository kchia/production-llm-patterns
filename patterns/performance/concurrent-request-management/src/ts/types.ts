/**
 * Types for the Concurrent Request Management pattern.
 *
 * Key design: separate RPM and TPM controls because they exhaust at different
 * rates and reset on different schedules. A 25-concurrent semaphore with no
 * token bucket will happily blow through your TPM limit with large-context requests.
 */

export interface ConcurrencyManagerConfig {
  /** Max in-flight requests at any moment. Default: 10. */
  maxConcurrent: number;
  /** Max requests per minute. Set to ~80% of provider limit. Default: 500. */
  maxRequestsPerMinute: number;
  /** Max input+output tokens per minute. Set to ~80% of provider limit. Default: 80_000. */
  maxTokensPerMinute: number;
  /** Max retry attempts on 429 or transient errors. Default: 4. */
  maxRetries: number;
  /** Base delay for exponential backoff in ms. Default: 1000. */
  baseRetryDelayMs: number;
  /** Maximum delay cap in ms. Default: 60_000. */
  maxRetryDelayMs: number;
  /**
   * Jitter factor for backoff: actual delay = calculated ± (calculated × factor).
   * 0.25 = ±25%, which desynchronizes retry waves across instances. Default: 0.25.
   */
  jitterFactor: number;
}

export interface LLMRequest {
  /** Estimated input token count. Used to pre-check TPM budget before execution. */
  estimatedInputTokens: number;
  /** Estimated output token count. Combined with input for TPM accounting. Default: 0. */
  estimatedOutputTokens?: number;
  /** Callable that performs the actual LLM API call. */
  execute: () => Promise<LLMResponse>;
  /** Optional identifier for logging and metrics. */
  requestId?: string;
}

export interface LLMResponse {
  content: string;
  /** Actual token counts from provider response, used to update TPM bucket accurately. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface ConcurrencyMetrics {
  /** Number of requests currently in flight (holding semaphore slots). */
  inFlight: number;
  /** Current token consumption rate per minute (rolling). */
  tokensUsedThisWindow: number;
  /** Current request count in the rolling RPM window. */
  requestsUsedThisWindow: number;
  /** Total requests completed since manager was created. */
  totalCompleted: number;
  /** Total requests rejected with errors (exhausted retries). */
  totalFailed: number;
  /** Total 429 / rate-limit errors encountered (before retries). */
  totalRateLimitHits: number;
  /** Total successful retries. */
  totalRetriesSucceeded: number;
}

export interface RetryContext {
  attempt: number;
  lastError: Error;
  requestId: string;
}

/** Error thrown when a request exceeds the maximum retry count. */
export class MaxRetriesExceededError extends Error {
  constructor(
    public readonly requestId: string,
    public readonly attempts: number,
    public readonly lastError: Error,
  ) {
    super(
      `Request ${requestId} failed after ${attempts} attempt(s): ${lastError.message}`,
    );
    this.name = "MaxRetriesExceededError";
  }
}

/** Error thrown when a request estimates more tokens than the configured per-minute limit. */
export class TokenBudgetExceededError extends Error {
  constructor(
    public readonly requestId: string,
    public readonly estimatedTokens: number,
    public readonly limitTokens: number,
  ) {
    super(
      `Request ${requestId} estimates ${estimatedTokens} tokens, exceeding per-minute limit of ${limitTokens}`,
    );
    this.name = "TokenBudgetExceededError";
  }
}

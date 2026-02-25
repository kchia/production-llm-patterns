/**
 * Retry with Budget — RetryWithBudget
 *
 * Wraps LLM provider calls with exponential backoff, jitter, and a
 * shared token bucket that caps aggregate retry volume. Prevents retry
 * storms from amplifying outages while still recovering from transient
 * failures.
 *
 * Framework-agnostic. No external dependencies.
 */

import type {
  LLMRequest,
  LLMResponse,
  RetryWithBudgetConfig,
  TokenBucketConfig,
  JitterMode,
  RetryResult,
  AttemptRecord,
} from './types.js';
import { ProviderError, RetriesExhaustedError } from './types.js';

// ── Token Bucket ──────────────────────────────────────────────────────

/**
 * Token bucket that controls aggregate retry volume.
 *
 * Successes add tokens; retries consume tokens. When the bucket drops
 * below half capacity, retries are paused. A passive refill timer adds
 * tokens over time to recover from sustained failures.
 */
export class TokenBucket {
  private tokens: number;
  private readonly config: TokenBucketConfig;
  private refillTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<TokenBucketConfig> = {}) {
    this.config = {
      maxTokens: config.maxTokens ?? 100,
      tokenRatio: config.tokenRatio ?? 0.1,
      refillIntervalMs: config.refillIntervalMs ?? 1000,
      refillAmount: config.refillAmount ?? 1,
    };
    this.tokens = this.config.maxTokens;
    this.startRefill();
  }

  /** Try to consume a token for a retry. Returns false if budget is exhausted. */
  tryConsume(): boolean {
    // Pause retries when below 50% capacity — this is the storm-prevention
    // threshold. Below half, the system is under sustained failure and retries
    // are unlikely to help.
    if (this.tokens < this.config.maxTokens * 0.5) {
      return false;
    }
    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }

  /** Record a successful request, adding tokens back to the bucket. */
  recordSuccess(): void {
    this.tokens = Math.min(
      this.config.maxTokens,
      this.tokens + this.config.tokenRatio
    );
  }

  /** Current number of tokens available. */
  remaining(): number {
    return this.tokens;
  }

  /** Maximum bucket capacity. */
  max(): number {
    return this.config.maxTokens;
  }

  /** Clean up the refill timer. Call this when done with the bucket. */
  destroy(): void {
    if (this.refillTimer !== null) {
      clearInterval(this.refillTimer);
      this.refillTimer = null;
    }
  }

  /** Reset bucket to full capacity. */
  reset(): void {
    this.tokens = this.config.maxTokens;
  }

  private startRefill(): void {
    if (this.config.refillIntervalMs <= 0 || this.config.refillAmount <= 0) {
      return;
    }
    this.refillTimer = setInterval(() => {
      this.tokens = Math.min(
        this.config.maxTokens,
        this.tokens + this.config.refillAmount
      );
    }, this.config.refillIntervalMs);
    // Don't let the timer keep the process alive
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timer = this.refillTimer as any;
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
  }
}

// ── Backoff Calculator ────────────────────────────────────────────────

/** Calculate backoff delay for a given attempt number. */
export function calculateBackoff(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  multiplier: number,
  jitterMode: JitterMode
): number {
  // Exponential: initialDelay * multiplier^attempt
  const exponentialDelay = initialDelayMs * Math.pow(multiplier, attempt);
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  switch (jitterMode) {
    case 'full':
      // Uniform random between 0 and the calculated delay.
      // Produces the widest spread of retry times — best for preventing
      // correlated retries across clients.
      return Math.random() * cappedDelay;
    case 'equal':
      // Half fixed + half random. Guarantees a minimum delay while still
      // adding randomization.
      return cappedDelay / 2 + (Math.random() * cappedDelay) / 2;
    case 'none':
      return cappedDelay;
  }
}

// ── Error Classification ──────────────────────────────────────────────

/** Determine if an error is retryable based on status code. */
export function isRetryableError(
  error: unknown,
  retryableStatuses: number[]
): boolean {
  if (error instanceof ProviderError) {
    return retryableStatuses.includes(error.statusCode);
  }
  // Network-level errors (no status code) are generally retryable
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('econnreset') ||
      msg.includes('econnrefused') ||
      msg.includes('etimedout') ||
      msg.includes('socket hang up') ||
      msg.includes('network')
    );
  }
  return false;
}

/** Extract Retry-After delay from a ProviderError, if present. */
function getRetryAfterMs(error: unknown): number | undefined {
  if (error instanceof ProviderError && error.retryAfterMs) {
    return error.retryAfterMs;
  }
  return undefined;
}

// ── Retry Handler ─────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  maxAttempts: 3,
  initialDelayMs: 200,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
  jitterMode: 'full' as JitterMode,
  retryableStatuses: [429, 500, 502, 503],
} as const;

const DEFAULT_BUDGET_CONFIG: TokenBucketConfig = {
  maxTokens: 100,
  tokenRatio: 0.1,
  refillIntervalMs: 1000,
  refillAmount: 1,
};

export class RetryWithBudget {
  private readonly maxAttempts: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly backoffMultiplier: number;
  private readonly jitterMode: JitterMode;
  private readonly retryableStatuses: number[];
  private readonly budget: TokenBucket;
  private readonly onRetry?: RetryWithBudgetConfig['onRetry'];
  private readonly onBudgetExhausted?: RetryWithBudgetConfig['onBudgetExhausted'];

  constructor(config: RetryWithBudgetConfig = {}) {
    this.maxAttempts = config.maxAttempts ?? DEFAULT_CONFIG.maxAttempts;
    this.initialDelayMs = config.initialDelayMs ?? DEFAULT_CONFIG.initialDelayMs;
    this.maxDelayMs = config.maxDelayMs ?? DEFAULT_CONFIG.maxDelayMs;
    this.backoffMultiplier =
      config.backoffMultiplier ?? DEFAULT_CONFIG.backoffMultiplier;
    this.jitterMode = config.jitterMode ?? DEFAULT_CONFIG.jitterMode;
    this.retryableStatuses =
      config.retryableStatuses ?? [...DEFAULT_CONFIG.retryableStatuses];
    this.budget = new TokenBucket({
      ...DEFAULT_BUDGET_CONFIG,
      ...config.budgetConfig,
    });
    this.onRetry = config.onRetry;
    this.onBudgetExhausted = config.onBudgetExhausted;
  }

  /**
   * Execute a provider call with retry logic and budget enforcement.
   *
   * The `fn` parameter is the actual provider call — it receives the
   * request and returns a promise of the response. This keeps the retry
   * handler decoupled from any specific provider.
   */
  async execute(
    request: LLMRequest,
    fn: (request: LLMRequest) => Promise<LLMResponse>
  ): Promise<RetryResult> {
    const startTime = performance.now();
    const attempts: AttemptRecord[] = [];
    let lastError: Error | null = null;
    let budgetExhausted = false;

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const attemptStart = performance.now();

      try {
        const response = await fn(request);
        this.budget.recordSuccess();

        return {
          response,
          attempts: attempt + 1,
          totalLatencyMs: performance.now() - startTime,
          retriesUsed: attempt,
          budgetRemaining: this.budget.remaining(),
        };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const attemptLatency = performance.now() - attemptStart;
        lastError = error;

        // Non-retryable errors fail immediately
        if (!isRetryableError(error, this.retryableStatuses)) {
          throw error;
        }

        // Calculate backoff delay, honoring Retry-After if present
        const computedDelay = calculateBackoff(
          attempt,
          this.initialDelayMs,
          this.maxDelayMs,
          this.backoffMultiplier,
          this.jitterMode
        );
        const retryAfter = getRetryAfterMs(error);
        // Honor Retry-After but cap at 2x maxDelayMs to avoid buggy headers
        const delay = retryAfter
          ? Math.min(retryAfter, this.maxDelayMs * 2)
          : computedDelay;

        attempts.push({ attempt, error, latencyMs: attemptLatency, delayMs: delay });

        // Check if there are more attempts available
        if (attempt + 1 >= this.maxAttempts) {
          break;
        }

        // Check retry budget before waiting
        if (!this.budget.tryConsume()) {
          budgetExhausted = true;
          this.onBudgetExhausted?.({
            attempt: attempt + 1,
            maxAttempts: this.maxAttempts,
            error,
            budgetRemaining: this.budget.remaining(),
            budgetMax: this.budget.max(),
          });
          break;
        }

        // Emit retry event
        this.onRetry?.({
          attempt: attempt + 1,
          maxAttempts: this.maxAttempts,
          error,
          delayMs: delay,
          budgetRemaining: this.budget.remaining(),
        });

        // Wait before retrying
        await sleep(delay);
      }
    }

    throw new RetriesExhaustedError(
      attempts,
      performance.now() - startTime,
      budgetExhausted
    );
  }

  /** Access the underlying token bucket for monitoring. */
  getBudget(): TokenBucket {
    return this.budget;
  }

  /** Clean up resources (stops the refill timer). */
  destroy(): void {
    this.budget.destroy();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-exports
export { ProviderError, RetriesExhaustedError } from './types.js';
export type {
  LLMRequest,
  LLMResponse,
  RetryWithBudgetConfig,
  TokenBucketConfig,
  JitterMode,
  RetryResult,
  RetryEvent,
  BudgetExhaustedEvent,
  AttemptRecord,
} from './types.js';

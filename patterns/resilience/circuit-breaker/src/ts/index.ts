/**
 * Circuit Breaker for LLM providers.
 *
 * Monitors failure rates in a sliding window and transitions between
 * CLOSED → OPEN → HALF_OPEN → CLOSED to protect against cascading failures.
 */

import {
  CircuitBreakerConfig,
  CircuitOpenError,
  CircuitState,
  RequestEvent,
  StateChangeEvent,
  WindowEntry,
  WindowStats,
  LLMRequest,
  LLMResponse,
} from './types.js';

export { MockProvider } from './mock-provider.js';
export type { MockProviderConfig } from './mock-provider.js';
export {
  CircuitBreakerConfig,
  CircuitOpenError,
  CircuitState,
  RequestEvent,
  StateChangeEvent,
  WindowStats,
  LLMRequest,
  LLMResponse,
  ProviderError,
} from './types.js';

// --- Sliding Window ---

export class SlidingWindow {
  private entries: WindowEntry[] = [];
  private readonly maxSize: number;
  private readonly maxAgeMs: number;

  constructor(maxSize: number, maxAgeMs: number) {
    this.maxSize = maxSize;
    this.maxAgeMs = maxAgeMs;
  }

  record(success: boolean): void {
    const now = Date.now();
    this.entries.push({ success, timestamp: now });
    this.evict(now);
  }

  getStats(): WindowStats {
    this.evict(Date.now());
    const total = this.entries.length;
    const failures = this.entries.filter((e) => !e.success).length;
    const successes = total - failures;
    const failureRate = total === 0 ? 0 : (failures / total) * 100;
    return { total, failures, successes, failureRate };
  }

  reset(): void {
    this.entries = [];
  }

  private evict(now: number): void {
    const cutoff = now - this.maxAgeMs;
    // Remove entries older than maxAgeMs
    this.entries = this.entries.filter((e) => e.timestamp >= cutoff);
    // Trim to maxSize, keeping the most recent entries
    if (this.entries.length > this.maxSize) {
      this.entries = this.entries.slice(this.entries.length - this.maxSize);
    }
  }
}

// --- Circuit Breaker ---

const DEFAULTS: Required<
  Pick<
    CircuitBreakerConfig,
    | 'failureThreshold'
    | 'resetTimeoutMs'
    | 'halfOpenMaxAttempts'
    | 'minimumRequests'
    | 'windowSize'
    | 'windowDurationMs'
  >
> = {
  failureThreshold: 50,
  resetTimeoutMs: 30_000,
  halfOpenMaxAttempts: 3,
  minimumRequests: 10,
  windowSize: 100,
  windowDurationMs: 60_000,
};

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private readonly window: SlidingWindow;
  private readonly config: typeof DEFAULTS & CircuitBreakerConfig;

  // Tracks when the circuit opened — used to calculate reset timeout
  private openedAt = 0;
  private lastFailureRate = 0;

  // Half-open probe tracking
  private halfOpenSuccesses = 0;

  // Timer for reset timeout (OPEN → HALF_OPEN)
  private resetTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: CircuitBreakerConfig = {}) {
    this.config = { ...DEFAULTS, ...config };
    this.window = new SlidingWindow(
      this.config.windowSize,
      this.config.windowDurationMs
    );
  }

  /**
   * Execute a request through the circuit breaker.
   * Throws CircuitOpenError if the circuit is open.
   */
  async execute<T extends LLMResponse>(
    request: LLMRequest,
    fn: (request: LLMRequest) => Promise<T>
  ): Promise<T> {
    // Fast-fail if circuit is open
    if (this.state === CircuitState.OPEN) {
      const now = Date.now();
      const elapsed = now - this.openedAt;
      const remaining = Math.max(0, this.config.resetTimeoutMs - elapsed);

      // Check if reset timeout has passed — transition to half-open
      if (elapsed >= this.config.resetTimeoutMs) {
        this.transitionTo(CircuitState.HALF_OPEN);
      } else {
        throw new CircuitOpenError({
          resetTimeoutMs: this.config.resetTimeoutMs,
          failureRate: this.lastFailureRate,
          remainingMs: remaining,
        });
      }
    }

    const start = performance.now();

    try {
      const result = await fn(request);
      this.onSuccess(performance.now() - start);
      return result;
    } catch (error) {
      const isFailure = this.config.isFailure
        ? this.config.isFailure(error)
        : this.defaultIsFailure(error);

      if (isFailure) {
        this.onFailure(performance.now() - start, error);
      } else {
        // Non-failure errors (e.g., 400 bad request) still count as success
        // for circuit breaker purposes — the provider is healthy, the request was bad
        this.onSuccess(performance.now() - start);
      }
      throw error;
    }
  }

  getState(): CircuitState {
    // Check if reset timeout has expired while in OPEN state
    if (
      this.state === CircuitState.OPEN &&
      Date.now() - this.openedAt >= this.config.resetTimeoutMs
    ) {
      this.transitionTo(CircuitState.HALF_OPEN);
    }
    return this.state;
  }

  getStats(): WindowStats {
    return this.window.getStats();
  }

  /** Clean up timers to prevent process-hanging in tests and shutdown. */
  destroy(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }

  private onSuccess(latencyMs: number): void {
    this.config.onSuccess?.({
      state: this.state,
      latencyMs,
      timestamp: Date.now(),
    });

    if (this.state === CircuitState.HALF_OPEN) {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.config.halfOpenMaxAttempts) {
        this.transitionTo(CircuitState.CLOSED);
      }
    } else {
      this.window.record(true);
    }
  }

  private onFailure(latencyMs: number, error: unknown): void {
    this.config.onFailure?.({
      state: this.state,
      latencyMs,
      timestamp: Date.now(),
      error,
    });

    if (this.state === CircuitState.HALF_OPEN) {
      // Any failure during half-open immediately reopens
      this.transitionTo(CircuitState.OPEN);
      return;
    }

    this.window.record(false);
    this.evaluateThreshold();
  }

  private evaluateThreshold(): void {
    if (this.state !== CircuitState.CLOSED) return;

    const stats = this.window.getStats();
    if (
      stats.total >= this.config.minimumRequests &&
      stats.failureRate >= this.config.failureThreshold
    ) {
      this.lastFailureRate = stats.failureRate;
      this.transitionTo(CircuitState.OPEN);
    }
  }

  private transitionTo(newState: CircuitState): void {
    const from = this.state;
    if (from === newState) return;

    this.state = newState;

    if (newState === CircuitState.OPEN) {
      this.openedAt = Date.now();
      this.scheduleResetTimeout();
    } else if (newState === CircuitState.HALF_OPEN) {
      this.halfOpenSuccesses = 0;
      this.clearResetTimer();
    } else if (newState === CircuitState.CLOSED) {
      this.window.reset();
      this.halfOpenSuccesses = 0;
      this.clearResetTimer();
    }

    const stats = this.window.getStats();
    this.config.onStateChange?.({
      from,
      to: newState,
      failureRate: newState === CircuitState.OPEN ? this.lastFailureRate : stats.failureRate,
      timestamp: Date.now(),
    });
  }

  private scheduleResetTimeout(): void {
    this.clearResetTimer();
    this.resetTimer = setTimeout(() => {
      if (this.state === CircuitState.OPEN) {
        this.transitionTo(CircuitState.HALF_OPEN);
      }
    }, this.config.resetTimeoutMs);

    // unref() prevents this timer from keeping the Node.js process alive
    const timer = this.resetTimer as unknown as { unref?: () => void };
    timer.unref?.();
  }

  private clearResetTimer(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }

  // Default: 5xx status codes and timeouts are failures.
  // 4xx (client errors) are NOT failures — the provider is healthy.
  private defaultIsFailure(error: unknown): boolean {
    if (error && typeof error === 'object' && 'statusCode' in error) {
      const status = (error as { statusCode: number }).statusCode;
      return status >= 500;
    }
    // Network errors, timeouts — treat as failures
    return true;
  }
}

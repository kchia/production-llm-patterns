import type {
  ErrorCategory,
  FailoverResult,
  FailoverRouterConfig,
  LLMRequest,
  ProviderAttempt,
  ProviderConfig,
  ProviderHealth,
  ProviderStatus,
} from './types.js';
import { AllProvidersExhaustedError, ProviderError } from './types.js';

/**
 * Sliding window that tracks recent request outcomes for a single provider.
 * Used to calculate failure rate and trigger automatic cooldown.
 */
class HealthWindow {
  private entries: { success: boolean; latencyMs: number; timestamp: number }[] = [];

  constructor(private readonly maxSize: number) {}

  record(success: boolean, latencyMs: number): void {
    this.entries.push({ success, latencyMs, timestamp: Date.now() });
    if (this.entries.length > this.maxSize) {
      this.entries.shift();
    }
  }

  get failureRate(): number {
    if (this.entries.length === 0) return 0;
    const failures = this.entries.filter((e) => !e.success).length;
    return failures / this.entries.length;
  }

  get avgLatencyMs(): number {
    if (this.entries.length === 0) return 0;
    const sum = this.entries.reduce((acc, e) => acc + e.latencyMs, 0);
    return sum / this.entries.length;
  }

  get totalRequests(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }
}

/** Internal state for a single provider. */
interface ProviderState {
  config: ProviderConfig;
  health: HealthWindow;
  cooldownUntil: number | null;
  consecutiveFailures: number;
}

/**
 * FailoverRouter — routes LLM requests across multiple providers
 * with automatic failover, error classification, and health tracking.
 */
export class FailoverRouter {
  private readonly providers: ProviderState[];
  private readonly timeout: number;
  private readonly cooldownMs: number;
  private readonly failureThreshold: number;
  private readonly maxFailovers: number;
  private readonly onFailover?: (from: string, to: string, error: Error) => void;
  private readonly onProviderCooldown?: (provider: string, entering: boolean) => void;

  constructor(config: FailoverRouterConfig) {
    if (config.providers.length === 0) {
      throw new Error('At least one provider is required');
    }

    this.timeout = config.timeout ?? 30_000;
    this.cooldownMs = config.cooldownMs ?? 60_000;
    this.failureThreshold = config.failureThreshold ?? 0.5;
    this.maxFailovers = config.maxFailovers ?? config.providers.length;
    this.onFailover = config.onFailover;
    this.onProviderCooldown = config.onProviderCooldown;

    const windowSize = config.windowSize ?? 10;

    // Sort by priority (lower = higher priority), preserving insertion order for equal priorities
    this.providers = [...config.providers]
      .sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity))
      .map((c) => ({
        config: c,
        health: new HealthWindow(windowSize),
        cooldownUntil: null,
        consecutiveFailures: 0,
      }));
  }

  /**
   * Execute an LLM request with automatic failover across providers.
   * Tries providers in priority order, skipping those in cooldown.
   */
  async complete(request: LLMRequest): Promise<FailoverResult> {
    const attempts: ProviderAttempt[] = [];
    const overallStart = performance.now();
    let failoverCount = 0;

    for (const state of this.providers) {
      if (failoverCount >= this.maxFailovers) break;

      // Skip providers in cooldown
      if (this.isInCooldown(state)) {
        continue;
      }

      const providerTimeout = state.config.timeout ?? this.timeout;
      const attemptStart = performance.now();

      try {
        const response = await withTimeout(
          state.config.handler(request),
          providerTimeout,
          state.config.name,
        );

        const latencyMs = performance.now() - attemptStart;

        // Record success
        state.health.record(true, latencyMs);
        state.consecutiveFailures = 0;

        attempts.push({
          provider: state.config.name,
          status: 'success',
          latencyMs,
        });

        return {
          response,
          provider: state.config.name,
          attempts,
          failoverOccurred: attempts.length > 1,
          totalLatencyMs: performance.now() - overallStart,
        };
      } catch (err) {
        const latencyMs = performance.now() - attemptStart;
        const error = err instanceof Error ? err : new Error(String(err));
        const category = classifyError(error);

        // Record failure
        state.health.record(false, latencyMs);
        state.consecutiveFailures++;

        attempts.push({
          provider: state.config.name,
          status: category,
          latencyMs,
          error,
          errorCategory: category,
        });

        // Check if this provider should enter cooldown
        this.maybeEnterCooldown(state);

        if (category === 'fatal') {
          // Fatal errors won't be helped by trying another provider
          throw new AllProvidersExhaustedError(attempts, request);
        }

        if (category === 'retryable') {
          // For retryable errors, we still move to the next provider
          // rather than retrying the same one — retry-with-backoff
          // on the same provider is the Retry with Budget pattern's job
        }

        // Notify about failover
        failoverCount++;
        const nextProvider = this.findNextAvailable(state);
        if (nextProvider && this.onFailover) {
          this.onFailover(state.config.name, nextProvider.config.name, error);
        }
      }
    }

    throw new AllProvidersExhaustedError(attempts, request);
  }

  /** Get health snapshot for all providers. */
  getProviderHealth(): Map<string, ProviderHealth> {
    const result = new Map<string, ProviderHealth>();
    for (const state of this.providers) {
      result.set(state.config.name, {
        name: state.config.name,
        status: this.getStatus(state),
        successRate: 1 - state.health.failureRate,
        avgLatencyMs: state.health.avgLatencyMs,
        totalRequests: state.health.totalRequests,
        cooldownUntil: state.cooldownUntil,
        consecutiveFailures: state.consecutiveFailures,
      });
    }
    return result;
  }

  /** Manually reset a provider's health state and remove cooldown. */
  resetProvider(name: string): void {
    const state = this.providers.find((p) => p.config.name === name);
    if (!state) throw new Error(`Unknown provider: ${name}`);
    state.health.clear();
    state.cooldownUntil = null;
    state.consecutiveFailures = 0;
    this.onProviderCooldown?.(name, false);
  }

  private isInCooldown(state: ProviderState): boolean {
    if (state.cooldownUntil === null) return false;
    if (Date.now() >= state.cooldownUntil) {
      // Cooldown expired — provider re-enters as "unknown" and will be tried
      state.cooldownUntil = null;
      this.onProviderCooldown?.(state.config.name, false);
      return false;
    }
    return true;
  }

  private maybeEnterCooldown(state: ProviderState): void {
    // Enter cooldown if failure rate exceeds threshold and we have enough data
    if (
      state.health.totalRequests >= 3 &&
      state.health.failureRate >= this.failureThreshold
    ) {
      state.cooldownUntil = Date.now() + this.cooldownMs;
      this.onProviderCooldown?.(state.config.name, true);
    }
  }

  private findNextAvailable(
    current: ProviderState,
  ): ProviderState | undefined {
    const idx = this.providers.indexOf(current);
    for (let i = idx + 1; i < this.providers.length; i++) {
      if (!this.isInCooldown(this.providers[i])) {
        return this.providers[i];
      }
    }
    return undefined;
  }

  private getStatus(state: ProviderState): ProviderStatus {
    if (this.isInCooldown(state)) return 'cooldown';
    if (state.health.totalRequests === 0) return 'unknown';
    return 'healthy';
  }
}

/**
 * Classify an error into routing categories.
 * This determines whether we retry the same provider, try the next, or give up.
 */
export function classifyError(error: Error): ErrorCategory {
  if (error instanceof ProviderError) {
    if (error.isTimeout) return 'failover';

    const code = error.statusCode;

    // Rate limits — retryable on the same provider with backoff
    if (code === 429 || code === 529) return 'retryable';

    // Client errors — the request itself is broken, no provider can help
    if (code >= 400 && code < 500) return 'fatal';

    // Server errors — try another provider
    if (code >= 500) return 'failover';
  }

  // Timeouts and network errors → failover
  if (
    error.message.includes('timeout') ||
    error.message.includes('ECONNREFUSED') ||
    error.message.includes('ENOTFOUND')
  ) {
    return 'failover';
  }

  // Unknown errors default to failover — safer than fatal
  return 'failover';
}

/** Race a promise against a timeout. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  providerName: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new ProviderError(
          `${providerName} timed out after ${ms}ms`,
          0,
          providerName,
          true,
        ),
      );
    }, ms);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

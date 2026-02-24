/**
 * Graceful Degradation — DegradationChain
 *
 * Walks an ordered chain of quality tiers to produce the best available response.
 * When the primary LLM provider fails, the chain falls through to progressively
 * lower-quality but more reliable alternatives.
 *
 * Framework-agnostic. No external dependencies.
 */

import type {
  LLMRequest,
  DegradationChainConfig,
  DegradationResult,
  TierAttempt,
} from './types.js';
import { AllTiersExhaustedError } from './types.js';

export class DegradationChain {
  private readonly config: Required<
    Pick<DegradationChainConfig, 'globalTimeoutMs' | 'minQuality'>
  > &
    DegradationChainConfig;

  constructor(config: DegradationChainConfig) {
    if (!config.tiers || config.tiers.length === 0) {
      throw new Error('DegradationChain requires at least one tier');
    }

    this.config = {
      ...config,
      globalTimeoutMs: config.globalTimeoutMs ?? 5000,
      minQuality: config.minQuality ?? 0.0,
    };
  }

  /**
   * Execute the degradation chain for a request.
   * Walks tiers in order until one succeeds or all are exhausted.
   */
  async execute(request: LLMRequest): Promise<DegradationResult> {
    const chainStart = performance.now();
    const attempts: TierAttempt[] = [];

    for (let i = 0; i < this.config.tiers.length; i++) {
      const tier = this.config.tiers[i];

      // Check global timeout
      const elapsed = performance.now() - chainStart;
      if (elapsed >= this.config.globalTimeoutMs) {
        // Record remaining tiers as skipped
        for (let j = i; j < this.config.tiers.length; j++) {
          attempts.push({
            tier: this.config.tiers[j].name,
            status: 'timeout',
            latencyMs: 0,
            error: 'Global timeout exceeded',
          });
        }
        break;
      }

      // Skip tiers below minimum quality
      if (tier.qualityScore < this.config.minQuality) {
        attempts.push({
          tier: tier.name,
          status: 'skipped_quality',
          latencyMs: 0,
          error: `Quality ${tier.qualityScore} below minimum ${this.config.minQuality}`,
        });
        continue;
      }

      // Skip unhealthy tiers
      if (tier.isHealthy && !tier.isHealthy()) {
        attempts.push({
          tier: tier.name,
          status: 'skipped_unhealthy',
          latencyMs: 0,
          error: 'Tier reported unhealthy',
        });
        continue;
      }

      // Attempt the tier with its per-tier timeout
      const tierStart = performance.now();
      const remainingGlobal = this.config.globalTimeoutMs - elapsed;
      const effectiveTimeout = Math.min(tier.timeoutMs, remainingGlobal);

      try {
        const response = await withTimeout(
          tier.handler(request),
          effectiveTimeout
        );
        const tierLatency = performance.now() - tierStart;

        attempts.push({
          tier: tier.name,
          status: 'success',
          latencyMs: tierLatency,
        });

        const result: DegradationResult = {
          response,
          tier: tier.name,
          quality: tier.qualityScore,
          latencyMs: performance.now() - chainStart,
          degraded: i > 0,
          attemptedTiers: attempts,
        };

        // Fire degradation callback if not the primary tier
        if (i > 0 && this.config.onDegradation) {
          this.config.onDegradation(result);
        }

        return result;
      } catch (err) {
        const tierLatency = performance.now() - tierStart;
        const isTimeout =
          err instanceof Error && err.message === 'Operation timed out';

        attempts.push({
          tier: tier.name,
          status: isTimeout ? 'timeout' : 'failure',
          latencyMs: tierLatency,
          error: err instanceof Error ? err.message : String(err),
        });
        // Continue to next tier
      }
    }

    throw new AllTiersExhaustedError(attempts);
  }
}

/**
 * Wraps a promise with a timeout.
 * Rejects with "Operation timed out" if the promise doesn't resolve in time.
 *
 * Uses setTimeout+clearTimeout instead of Promise.race to avoid leaking
 * the original promise (Promise.race doesn't cancel the losing promise).
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) {
    return Promise.reject(new Error('Operation timed out'));
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Operation timed out'));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export { AllTiersExhaustedError } from './types.js';
export type {
  LLMRequest,
  LLMResponse,
  DegradationTier,
  DegradationChainConfig,
  DegradationResult,
  TierAttempt,
} from './types.js';

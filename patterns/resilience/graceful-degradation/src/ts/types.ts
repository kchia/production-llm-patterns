/**
 * Graceful Degradation — Type Definitions
 *
 * Core types for the degradation chain pattern.
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

/**
 * A single degradation tier in the chain.
 *
 * Each tier wraps a handler function that attempts to produce a response.
 * Tiers are tried in order — first success wins.
 */
export interface DegradationTier {
  /** Human-readable name for logging and metrics (e.g., "primary", "cache"). */
  name: string;

  /** The handler that attempts to produce a response. Throw or reject to signal failure. */
  handler: (request: LLMRequest) => Promise<LLMResponse>;

  /** Quality score from 0.0 (worst) to 1.0 (best). Used for filtering and metrics. */
  qualityScore: number;

  /** Per-tier timeout in milliseconds. The handler is aborted if it exceeds this. */
  timeoutMs: number;

  /** Optional health check. If it returns false, this tier is skipped entirely. */
  isHealthy?: () => boolean;
}

/** Configuration for the DegradationChain. */
export interface DegradationChainConfig {
  /** Ordered array of tiers. First tier is highest quality, last is the safety net. */
  tiers: DegradationTier[];

  /** Global timeout across all tiers combined, in milliseconds. Default: 5000. */
  globalTimeoutMs?: number;

  /** Minimum acceptable quality score. Tiers below this are skipped. Default: 0.0. */
  minQuality?: number;

  /** Callback fired when a non-primary tier serves the response. */
  onDegradation?: (result: DegradationResult) => void;
}

/** The result of walking the degradation chain. */
export interface DegradationResult {
  /** The LLM response content. */
  response: LLMResponse;

  /** Which tier served this response. */
  tier: string;

  /** Quality score of the tier that served. */
  quality: number;

  /** Total latency in milliseconds from chain start to response. */
  latencyMs: number;

  /** True if the response came from any tier other than the first. */
  degraded: boolean;

  /** Metadata about tiers that were attempted but failed. */
  attemptedTiers: TierAttempt[];
}

/** Record of a single tier attempt. */
export interface TierAttempt {
  tier: string;
  status: 'success' | 'failure' | 'timeout' | 'skipped_unhealthy' | 'skipped_quality';
  latencyMs: number;
  error?: string;
}

/** Error thrown when every tier in the chain fails. */
export class AllTiersExhaustedError extends Error {
  public readonly attempts: TierAttempt[];

  constructor(attempts: TierAttempt[]) {
    const summary = attempts
      .map((a) => `${a.tier}: ${a.status}${a.error ? ` (${a.error})` : ''}`)
      .join(', ');
    super(`All degradation tiers exhausted: ${summary}`);
    this.name = 'AllTiersExhaustedError';
    this.attempts = attempts;
  }
}

/**
 * cost-tracker — Type Definitions
 *
 * Shared types for computing and accumulating LLM API costs.
 * Framework-agnostic. No external dependencies.
 *
 * Designed to be imported by pattern implementations that need
 * cost computation without pulling in the full cost-dashboard pattern.
 */

// ─── Price Table ──────────────────────────────────────────────────────────────

/** Per-model pricing. All prices in USD per 1M tokens. */
export interface ModelPrice {
  model: string;
  /** USD per 1,000,000 input tokens. */
  inputPricePerMillion: number;
  /** USD per 1,000,000 output tokens. */
  outputPricePerMillion: number;
}

// ─── Token Usage ──────────────────────────────────────────────────────────────

/** Token counts for a single LLM request/response pair. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// ─── Cost Record ──────────────────────────────────────────────────────────────

/**
 * Cost attributed to a single LLM call.
 * Produced by CostTracker.record(); consumed by SpendAccumulator.
 */
export interface CostRecord {
  model: string;
  usage: TokenUsage;
  /** Computed cost in USD. */
  costUsd: number;
  /** Unix timestamp (ms) of this record. */
  timestamp: number;
  /** Arbitrary attribution label — user ID, feature name, etc. */
  label?: string;
}

// ─── Accumulator Snapshot ─────────────────────────────────────────────────────

/** Running totals for a spend accumulator. */
export interface SpendSnapshot {
  /** Label this snapshot covers (or "all" for the global accumulator). */
  label: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRequests: number;
}

// ─── Configuration ────────────────────────────────────────────────────────────

export interface CostTrackerConfig {
  /**
   * Price table used for cost computation. Defaults to BUILT_IN_PRICES.
   * Override when provider pricing has changed or you're testing.
   */
  prices?: ModelPrice[];

  /**
   * Fallback price used when the model isn't found in the price table.
   * Defaults to gpt-4o pricing (conservative over-estimate for unknowns).
   */
  unknownModelPrice?: ModelPrice;

  /**
   * Custom token estimator for use before a real provider call.
   * Defaults to the 4-chars-per-token heuristic.
   */
  estimateTokens?: (text: string) => number;
}

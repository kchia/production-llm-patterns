/**
 * cost-tracker — Core Implementation
 *
 * Three exports:
 *   1. BUILT_IN_PRICES       — model price table (authoritative source of truth)
 *   2. CostTracker           — computes cost for a single LLM call
 *   3. SpendAccumulator      — running totals grouped by label
 *
 * Usage pattern:
 *   const tracker = new CostTracker({ prices: BUILT_IN_PRICES });
 *   const record  = tracker.record({ model, inputTokens, outputTokens });
 *   accumulator.add(record);
 *   const snapshot = accumulator.snapshot("user-123");
 */

import type {
  CostRecord,
  CostTrackerConfig,
  ModelPrice,
  SpendSnapshot,
  TokenUsage,
} from './types.js';

// ─── Built-in Price Table ─────────────────────────────────────────────────────

/**
 * Prices in USD per 1M tokens. Verified against provider docs January 2026.
 * Production deployments should refresh this on a schedule — prices change.
 *
 * Canonical source: used by token-budget-middleware, model-routing, and
 * cost-dashboard. Import from here instead of hardcoding in each pattern.
 */
export const BUILT_IN_PRICES: ModelPrice[] = [
  { model: 'gpt-4o',            inputPricePerMillion: 2.50,  outputPricePerMillion: 10.00 },
  { model: 'gpt-4o-mini',       inputPricePerMillion: 0.15,  outputPricePerMillion: 0.60  },
  { model: 'claude-sonnet-4-6', inputPricePerMillion: 3.00,  outputPricePerMillion: 15.00 },
  { model: 'claude-haiku-4-5',  inputPricePerMillion: 0.80,  outputPricePerMillion: 4.00  },
];

// ─── Token Estimator ──────────────────────────────────────────────────────────

/**
 * Estimate token count from raw text before making a provider call.
 *
 * Uses the 4-chars-per-token heuristic (English text). This over-estimates
 * slightly compared to tiktoken — intentional, since it's safer to over-count
 * when making budget decisions than to under-count.
 *
 * Exported so patterns can import one canonical implementation.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Cost Computation ─────────────────────────────────────────────────────────

/**
 * Compute the USD cost for a known token usage + model.
 *
 * @param inputTokens  — tokens in the prompt/context
 * @param outputTokens — tokens in the completion
 * @param price        — the ModelPrice entry for this model
 * @returns USD cost (may be very small — use toFixed(6) when displaying)
 */
export function computeCost(
  inputTokens: number,
  outputTokens: number,
  price: ModelPrice,
): number {
  const inputCost  = (inputTokens  / 1_000_000) * price.inputPricePerMillion;
  const outputCost = (outputTokens / 1_000_000) * price.outputPricePerMillion;
  return inputCost + outputCost;
}

// ─── CostTracker ──────────────────────────────────────────────────────────────

/**
 * Computes and records cost for individual LLM calls.
 *
 * Stateless beyond the price table — each call to record() returns a CostRecord
 * that callers can pass to a SpendAccumulator or log directly.
 */
export class CostTracker {
  private readonly prices: Map<string, ModelPrice>;
  private readonly unknownModelPrice: ModelPrice;
  private readonly _estimateTokens: (text: string) => number;

  constructor(config: CostTrackerConfig = {}) {
    const priceList = config.prices ?? BUILT_IN_PRICES;
    this.prices = new Map(priceList.map(p => [p.model, p]));

    // Conservative fallback: over-count is safer than under-count for budgets
    this.unknownModelPrice = config.unknownModelPrice ?? {
      model: 'unknown',
      inputPricePerMillion: 2.50,
      outputPricePerMillion: 10.00,
    };

    this._estimateTokens = config.estimateTokens ?? estimateTokens;
  }

  /**
   * Look up a model's price. Returns the fallback price for unknown models
   * rather than throwing — callers don't need to handle unknown model errors.
   */
  getPrice(model: string): ModelPrice {
    return this.prices.get(model) ?? { ...this.unknownModelPrice, model };
  }

  /**
   * Record the cost of a completed LLM call.
   *
   * Call this after the provider responds (with real token counts).
   * For pre-call estimates, use estimateTokens() directly.
   */
  record(params: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    label?: string;
    timestamp?: number;
  }): CostRecord {
    const { model, inputTokens, outputTokens, label, timestamp } = params;
    const price = this.getPrice(model);
    const costUsd = computeCost(inputTokens, outputTokens, price);

    const usage: TokenUsage = {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };

    return {
      model,
      usage,
      costUsd,
      timestamp: timestamp ?? Date.now(),
      label,
    };
  }

  /**
   * Estimate the cost of a prompt before calling the provider.
   *
   * Useful for budget-check gates — pair with record() to compare estimate vs. actual.
   */
  estimate(params: {
    model: string;
    promptText: string;
    expectedOutputTokens?: number;
  }): { estimatedInputTokens: number; estimatedOutputTokens: number; estimatedCostUsd: number } {
    const estimatedInputTokens = this._estimateTokens(params.promptText);
    const estimatedOutputTokens = params.expectedOutputTokens ?? 256;
    const price = this.getPrice(params.model);
    const estimatedCostUsd = computeCost(estimatedInputTokens, estimatedOutputTokens, price);
    return { estimatedInputTokens, estimatedOutputTokens, estimatedCostUsd };
  }
}

// ─── SpendAccumulator ─────────────────────────────────────────────────────────

/**
 * Accumulates CostRecords into running totals grouped by label.
 *
 * Useful for per-user, per-feature, or per-session cost tracking without
 * pulling in the full cost-dashboard pattern's store+query+alert infrastructure.
 *
 * Not thread-safe — single-process only. For multi-process aggregation,
 * use the cost-dashboard pattern's SpendStore instead.
 */
export class SpendAccumulator {
  // label → running totals
  private readonly totals: Map<string, SpendSnapshot> = new Map();

  add(record: CostRecord): void {
    const label = record.label ?? 'unlabeled';
    const existing = this.totals.get(label);

    if (existing) {
      existing.totalCostUsd      += record.costUsd;
      existing.totalInputTokens  += record.usage.inputTokens;
      existing.totalOutputTokens += record.usage.outputTokens;
      existing.totalRequests     += 1;
    } else {
      this.totals.set(label, {
        label,
        totalCostUsd:      record.costUsd,
        totalInputTokens:  record.usage.inputTokens,
        totalOutputTokens: record.usage.outputTokens,
        totalRequests:     1,
      });
    }
  }

  /** Returns the snapshot for a specific label. Returns zeroed snapshot if not found. */
  snapshot(label: string): SpendSnapshot {
    return this.totals.get(label) ?? {
      label,
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalRequests: 0,
    };
  }

  /** Returns snapshots for all labels. */
  allSnapshots(): SpendSnapshot[] {
    return Array.from(this.totals.values());
  }

  /** Returns the global total across all labels. */
  globalTotal(): SpendSnapshot {
    const snapshots = this.allSnapshots();
    return {
      label: 'all',
      totalCostUsd:      snapshots.reduce((s, x) => s + x.totalCostUsd, 0),
      totalInputTokens:  snapshots.reduce((s, x) => s + x.totalInputTokens, 0),
      totalOutputTokens: snapshots.reduce((s, x) => s + x.totalOutputTokens, 0),
      totalRequests:     snapshots.reduce((s, x) => s + x.totalRequests, 0),
    };
  }

  /** Resets all accumulated state. Useful between test runs. */
  reset(): void {
    this.totals.clear();
  }
}

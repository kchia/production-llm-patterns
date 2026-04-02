/**
 * Cost Dashboard — Type Definitions
 *
 * Typed around the collection → aggregation → query pipeline.
 * Every LLM call produces a CostEvent; SpendStore persists and rolls up;
 * QueryAPI surfaces aggregates; AlertEngine checks thresholds.
 */

/** A recorded cost event for a single LLM request. */
export interface CostEvent {
  timestamp: Date;
  requestId: string;
  /** Mandatory attribution dimension — requests without this go to "unknown". */
  feature: string;
  model: string;
  promptVersion: string;
  userId?: string;
  teamId?: string;
  inputTokens: number;
  outputTokens: number;
  /** Computed from token counts × model price table at time of recording. */
  costUsd: number;
  latencyMs: number;
  /** Extensible map for arbitrary dimensions (environment, region, experiment). */
  tags: Record<string, string>;
}

/** Per-model pricing used to compute costUsd at record time. */
export interface ModelPrice {
  model: string;
  inputPricePerMillionTokens: number;
  outputPricePerMillionTokens: number;
  /** When this price entry was last fetched/verified. */
  fetchedAt: Date;
}

/** Aggregated spend for a single dimension value over a time range. */
export interface SpendSummary {
  /** The groupBy dimension value (e.g., "document-analysis" for feature groupBy). */
  dimensionValue: string;
  totalCostUsd: number;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgCostPerRequestUsd: number;
  startTime: Date;
  endTime: Date;
}

export type GroupByDimension = 'feature' | 'model' | 'user' | 'promptVersion' | 'team';

export interface QueryParams {
  groupBy: GroupByDimension;
  startTime: Date;
  endTime: Date;
  filters?: {
    feature?: string;
    model?: string;
    userId?: string;
    teamId?: string;
  };
  /** If provided, only return rows with spend above this threshold. */
  minCostUsd?: number;
}

export interface AlertConfig {
  /**
   * Fire a spike alert when current-window spend exceeds baseline × this multiplier.
   * Default: 2.5
   */
  spikeSensitivity: number;
  /**
   * Fire a concentration alert when one dimension accounts for more than this
   * fraction of total spend. Default: 0.40
   */
  concentrationRiskThreshold: number;
  /**
   * Lookback window for computing the baseline rolling average (in hours).
   * Default: 168 (7 days).
   */
  baselineWindowHours: number;
  /**
   * Current window size for spike detection (in hours). Default: 1.
   */
  currentWindowHours: number;
}

export type AlertType = 'spike' | 'concentrationRisk' | 'missingTags' | 'priceTableStale';
export type AlertSeverity = 'warning' | 'critical';

export interface Alert {
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  /** Dimension/value pair that triggered the alert (e.g., {feature: "document-analysis"}). */
  context: Record<string, string | number>;
  firedAt: Date;
}

export interface CostDashboardConfig {
  /**
   * Tags that must be present on every event. Missing tags produce a warning
   * and the event is recorded with those dimensions set to "unknown".
   */
  requiredTags: string[];
  /**
   * How long to retain raw CostEvents before they're eligible for deletion
   * (after rollup). Default: 90 days.
   */
  retentionDays: number;
  /**
   * Pre-aggregated rollup granularity in minutes. Finer = better time resolution,
   * more storage. Default: 60.
   */
  rollupIntervalMinutes: number;
  /**
   * How often to refresh the model price table in milliseconds. Default: 3_600_000 (1h).
   * Staleness leads to cost miscalculation vs. the actual provider invoice.
   */
  priceRefreshIntervalMs: number;
  /** Alert configuration. */
  alertConfig: AlertConfig;
}

export const DEFAULT_CONFIG: CostDashboardConfig = {
  requiredTags: ['feature'],
  retentionDays: 90,
  rollupIntervalMinutes: 60,
  priceRefreshIntervalMs: 3_600_000,
  alertConfig: {
    spikeSensitivity: 2.5,
    concentrationRiskThreshold: 0.40,
    baselineWindowHours: 168,
    currentWindowHours: 1,
  },
};

/**
 * Built-in price table. Production systems should refresh this from an external
 * source (e.g., the provider's pricing API) rather than hardcoding.
 *
 * Prices in USD per 1M tokens (input / output). Accurate as of early 2026;
 * verify against provider docs before relying on this for financial reporting.
 */
export const BUILT_IN_PRICES: ModelPrice[] = [
  { model: 'gpt-4o',              inputPricePerMillionTokens: 2.50,  outputPricePerMillionTokens: 10.00, fetchedAt: new Date('2026-01-01') },
  { model: 'gpt-4o-mini',         inputPricePerMillionTokens: 0.15,  outputPricePerMillionTokens: 0.60,  fetchedAt: new Date('2026-01-01') },
  { model: 'claude-sonnet-4-6',   inputPricePerMillionTokens: 3.00,  outputPricePerMillionTokens: 15.00, fetchedAt: new Date('2026-01-01') },
  { model: 'claude-haiku-4-5',    inputPricePerMillionTokens: 0.80,  outputPricePerMillionTokens: 4.00,  fetchedAt: new Date('2026-01-01') },
];

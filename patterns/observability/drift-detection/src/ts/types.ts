/**
 * Drift Detection — type definitions
 *
 * Covers the core observation/alert types plus distribution statistics
 * used for both baseline and current-window comparison.
 */

export type DriftDimension = 'input-length' | 'output-length' | 'output-score' | 'latency';

export type DriftSeverity = 'warning' | 'critical';

/**
 * One observation per LLM request/response cycle.
 * `outputScore` is optional — only populated when an eval harness is plugged in.
 */
export interface DriftObservation {
  requestId: string;
  timestamp: number;        // Unix ms
  inputLength: number;      // prompt character length (proxy for input distribution)
  outputLength: number;     // response character length
  outputScore?: number;     // normalized 0–1, e.g. from eval harness
  latencyMs: number;
  metadata?: Record<string, unknown>;
}

/**
 * Descriptive stats for a window of observations on a single dimension.
 */
export interface DistributionStats {
  mean: number;
  stdDev: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
  sampleCount: number;
}

/**
 * Fired when a dimension's drift score exceeds the configured threshold.
 */
export interface DriftAlert {
  dimension: DriftDimension;
  /** Normalized drift magnitude 0–1. Higher = more drift. */
  score: number;
  severity: DriftSeverity;
  windowStart: number;    // Unix ms of oldest sample in current window
  windowEnd: number;      // Unix ms of newest sample in current window
  baselineStats: DistributionStats;
  currentStats: DistributionStats;
}

export interface DriftDetectorConfig {
  /**
   * Number of observations needed to establish the baseline.
   * @default 1000
   */
  baselineWindowSize: number;

  /**
   * Rolling window size for comparison against baseline.
   * @default 500
   */
  currentWindowSize: number;

  /**
   * Normalized drift score (0–1) that triggers a DriftAlert.
   * @default 0.15
   */
  scoreThreshold: number;

  /**
   * Critical threshold — anything above this fires a 'critical' alert.
   * @default 0.30
   */
  criticalThreshold: number;

  /**
   * Minimum current-window samples before any alert can fire.
   * Prevents cold-start false positives.
   * @default 100
   */
  minSamplesForAlert: number;

  /**
   * Which dimensions to monitor. Omit dimensions that aren't relevant to your use case.
   * @default ['input-length', 'output-length', 'latency']
   */
  dimensions: DriftDimension[];

  /**
   * Optional callback invoked whenever an alert fires.
   */
  onAlert?: (alert: DriftAlert) => void;
}

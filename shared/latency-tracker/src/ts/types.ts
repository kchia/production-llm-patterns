/**
 * latency-tracker — Type Definitions
 *
 * Shared types for measuring and accumulating LLM request latencies.
 * Framework-agnostic. No external dependencies.
 *
 * Designed to be imported by pattern implementations that need
 * latency measurement or percentile computation without pulling in
 * the full latency-budget pattern's deadline propagation machinery.
 */

// ─── Single Sample ────────────────────────────────────────────────────────────

/**
 * A single latency observation produced by LatencyAccumulator.record().
 */
export interface LatencyRecord {
  /** Observed latency in milliseconds. */
  latencyMs: number;
  /** Unix timestamp (ms) of when this measurement was taken. */
  timestamp: number;
  /** Arbitrary attribution label — provider name, step name, feature, etc. */
  label?: string;
}

// ─── Statistics ───────────────────────────────────────────────────────────────

/**
 * Descriptive statistics computed from a set of latency samples.
 *
 * All values in milliseconds. count=0 produces all-zero stats — callers
 * should check count before trusting min/max/percentiles.
 */
export interface LatencyStats {
  count: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  /** Median (50th percentile). */
  p50Ms: number;
  /** 95th percentile — typical SLA threshold. */
  p95Ms: number;
  /** 99th percentile — tail latency sentinel. */
  p99Ms: number;
}

// ─── Accumulator Snapshot ─────────────────────────────────────────────────────

/**
 * Per-label snapshot returned by LatencyAccumulator.allStats().
 */
export interface LatencyAccumulatorSnapshot {
  label: string;
  stats: LatencyStats;
}

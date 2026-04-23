/**
 * latency-tracker — Core Implementation
 *
 * Four exports:
 *   1. Stopwatch              — precise elapsed-time measurement (performance.now())
 *   2. computeStats           — percentile computation from an array of samples
 *   3. LatencyAccumulator     — grouped latency samples by label (per-feature, per-user)
 *   4. SlidingWindowRecorder  — fixed-size rolling window for per-provider health tracking
 *
 * Usage pattern:
 *   const sw = new Stopwatch();
 *   const response = await provider.complete(request);
 *   const latencyMs = sw.stop();
 *   accumulator.record(latencyMs, 'provider-a');
 *   const stats = accumulator.stats('provider-a');
 *   // stats.p99Ms, stats.meanMs, ...
 */

import type {
  LatencyAccumulatorSnapshot,
  LatencyRecord,
  LatencyStats,
} from './types.js';

export type { LatencyAccumulatorSnapshot, LatencyRecord, LatencyStats };

// ─── Stopwatch ────────────────────────────────────────────────────────────────

/**
 * Wraps performance.now() for precise, monotonic elapsed-time measurement.
 *
 * performance.now() is preferred over Date.now() for latency measurement:
 * it's unaffected by system clock adjustments and has sub-millisecond precision.
 * It resets on process start, so values are only meaningful relative to each other.
 */
export class Stopwatch {
  private readonly startMs: number;
  private endMs: number | null = null;

  constructor() {
    this.startMs = performance.now();
  }

  /** Convenience factory — equivalent to `new Stopwatch()`. */
  static start(): Stopwatch {
    return new Stopwatch();
  }

  /**
   * Milliseconds elapsed since construction (or last reset).
   * If stop() was called, returns the frozen elapsed value.
   */
  elapsed(): number {
    if (this.endMs !== null) return this.endMs - this.startMs;
    return performance.now() - this.startMs;
  }

  /**
   * Stop the timer and return elapsed milliseconds.
   * Subsequent calls to elapsed() return the same frozen value.
   */
  stop(): number {
    if (this.endMs === null) {
      this.endMs = performance.now();
    }
    return this.endMs - this.startMs;
  }
}

// ─── Statistics ───────────────────────────────────────────────────────────────

/**
 * Compute descriptive statistics from an array of latency samples (in ms).
 *
 * Uses linear interpolation for percentiles (same method as NumPy's default).
 * Returns all-zero stats for an empty array — check count before trusting percentiles.
 *
 * @param samples  Raw latency values in milliseconds.
 */
export function computeStats(samples: number[]): LatencyStats {
  if (samples.length === 0) {
    return { count: 0, minMs: 0, maxMs: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);

  return {
    count,
    minMs: sorted[0],
    maxMs: sorted[count - 1],
    meanMs: sum / count,
    p50Ms: interpolatedPercentile(sorted, 0.50),
    p95Ms: interpolatedPercentile(sorted, 0.95),
    p99Ms: interpolatedPercentile(sorted, 0.99),
  };
}

/**
 * Linear interpolation between the two nearest ranked values.
 * This matches NumPy's default 'linear' method and produces smooth estimates
 * that don't jump when a single sample straddles a percentile boundary.
 */
function interpolatedPercentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0];

  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);

  if (lo === hi) return sorted[lo];

  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

// ─── LatencyAccumulator ───────────────────────────────────────────────────────

/**
 * Accumulates latency samples grouped by label, computing percentile stats on demand.
 *
 * Analogous to SpendAccumulator in cost-tracker — groups records by an arbitrary
 * string label (provider name, step name, user ID, feature flag, etc.).
 *
 * All samples are retained in memory — suitable for request-lifecycle aggregation
 * or short-lived analysis windows. For long-running processes, prefer
 * SlidingWindowRecorder or drain with reset() between reporting intervals.
 */
export class LatencyAccumulator {
  private readonly samples: Map<string, number[]> = new Map();

  /**
   * Record a latency observation and return it as a LatencyRecord.
   *
   * @param latencyMs  Observed latency in milliseconds.
   * @param label      Optional grouping key. Unlabeled samples accumulate under 'unlabeled'.
   */
  record(latencyMs: number, label?: string): LatencyRecord {
    const key = label ?? 'unlabeled';

    const existing = this.samples.get(key);
    if (existing) {
      existing.push(latencyMs);
    } else {
      this.samples.set(key, [latencyMs]);
    }

    return { latencyMs, timestamp: Date.now(), label };
  }

  /**
   * Compute statistics for a specific label.
   * Returns all-zero stats if the label has no samples.
   */
  stats(label?: string): LatencyStats {
    const key = label ?? 'unlabeled';
    return computeStats(this.samples.get(key) ?? []);
  }

  /** Returns per-label stats snapshots for all recorded labels. */
  allStats(): LatencyAccumulatorSnapshot[] {
    return Array.from(this.samples.entries()).map(([label, samples]) => ({
      label,
      stats: computeStats(samples),
    }));
  }

  /** Total number of samples across all labels. */
  totalCount(): number {
    let total = 0;
    for (const samples of this.samples.values()) {
      total += samples.length;
    }
    return total;
  }

  /** Resets all accumulated state. Useful between reporting intervals or test runs. */
  reset(): void {
    this.samples.clear();
  }
}

// ─── SlidingWindowRecorder ───────────────────────────────────────────────────

/**
 * Fixed-size rolling window of recent latency samples.
 *
 * The oldest sample is evicted when the window is full. Useful for per-provider
 * health tracking where stale data should age out — e.g., "what's my p99 over
 * the last N requests?" rather than "what's my p99 since startup?".
 *
 * This mirrors the HealthWindow in multi-provider-failover — a canonical
 * implementation to import instead of reimplementing in each pattern.
 */
export class SlidingWindowRecorder {
  private readonly samples: number[] = [];

  /**
   * @param maxSize  Maximum number of samples to retain. Defaults to 100.
   */
  constructor(private readonly maxSize: number = 100) {
    if (maxSize < 1) throw new RangeError('maxSize must be ≥ 1');
  }

  /** Add a latency sample, evicting the oldest if the window is full. */
  record(latencyMs: number): void {
    this.samples.push(latencyMs);
    if (this.samples.length > this.maxSize) {
      // shift() is O(n) but windows are typically small (10–200 entries).
      // A circular buffer would be O(1) but adds ~30 lines of complexity — not worth it here.
      this.samples.shift();
    }
  }

  /** Compute statistics for all samples currently in the window. */
  stats(): LatencyStats {
    return computeStats(this.samples);
  }

  /** Number of samples currently in the window. */
  get count(): number {
    return this.samples.length;
  }

  /** Clear all samples. */
  reset(): void {
    this.samples.length = 0;
  }
}

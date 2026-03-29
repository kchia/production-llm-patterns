/**
 * Drift Detection
 *
 * Detects statistical drift in LLM input/output distributions over time.
 * Compares a rolling current window against a pinned baseline snapshot
 * using normalized distance metrics per configured dimension.
 *
 * Core abstraction: DriftDetector
 *   .observe(observation) — ingest one request/response data point
 *   .forceBaselineSnapshot() — pin current distribution as new baseline
 *   .getBaseline() / .getCurrentWindow() — inspect stats
 */

import type {
  DriftAlert,
  DriftDetectorConfig,
  DriftDimension,
  DriftObservation,
  DistributionStats,
} from './types.js';

export type { DriftAlert, DriftDetectorConfig, DriftDimension, DriftObservation, DistributionStats };

const DEFAULTS: DriftDetectorConfig = {
  baselineWindowSize: 1000,
  currentWindowSize: 500,
  scoreThreshold: 0.15,
  criticalThreshold: 0.30,
  minSamplesForAlert: 100,
  dimensions: ['input-length', 'output-length', 'latency'],
};

// ─── Internal helpers ──────────────────────────────────────────────────────

function extractDimensionValue(obs: DriftObservation, dim: DriftDimension): number | undefined {
  switch (dim) {
    case 'input-length':  return obs.inputLength;
    case 'output-length': return obs.outputLength;
    case 'output-score':  return obs.outputScore;
    case 'latency':       return obs.latencyMs;
  }
}

function computeStats(values: number[]): DistributionStats {
  if (values.length === 0) {
    return { mean: 0, stdDev: 0, p50: 0, p95: 0, min: 0, max: 0, sampleCount: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((sum, v) => sum + v, 0) / n;
  const variance = sorted.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);

  // Percentile helper — linear interpolation
  const pct = (p: number): number => {
    const idx = (p / 100) * (n - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };

  return {
    mean,
    stdDev,
    p50: pct(50),
    p95: pct(95),
    min: sorted[0],
    max: sorted[n - 1],
    sampleCount: n,
  };
}

/**
 * Normalized drift score between two distributions.
 *
 * Uses a simplified Wasserstein-1 approximation: mean shift normalized by
 * baseline standard deviation. Capped at 1.0. Returns 0 if baseline stdDev
 * is 0 (perfectly constant baseline — no drift detectable).
 *
 * This is an intentional approximation — full Wasserstein requires sorted
 * sample matching and is expensive at runtime. The mean-shift normalization
 * is a documented and widely-used proxy for moderate-variance distributions.
 */
function computeDriftScore(baseline: DistributionStats, current: DistributionStats): number {
  if (baseline.stdDev === 0) return 0;
  const meanShift = Math.abs(current.mean - baseline.mean);
  return Math.min(meanShift / (baseline.stdDev * 3), 1.0);
}

// ─── CircularBuffer ────────────────────────────────────────────────────────

/**
 * Fixed-capacity circular buffer for a single numeric dimension.
 * Uses a typed array for memory efficiency at scale.
 */
class CircularBuffer {
  private readonly data: Float64Array;
  private head = 0;
  private count = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.data = new Float64Array(capacity);
  }

  push(value: number): void {
    this.data[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  toArray(): number[] {
    if (this.count < this.capacity) {
      // Buffer not yet full — return in insertion order
      return Array.from(this.data.slice(0, this.count));
    }
    // Full buffer — unwrap from head
    const result = new Array<number>(this.capacity);
    for (let i = 0; i < this.capacity; i++) {
      result[i] = this.data[(this.head + i) % this.capacity];
    }
    return result;
  }

  get size(): number {
    return this.count;
  }
}

// ─── DriftDetector ─────────────────────────────────────────────────────────

export class DriftDetector {
  private readonly config: DriftDetectorConfig;

  // Baseline: filled once then pinned (until forceBaselineSnapshot)
  private baselineBuffers: Map<DriftDimension, CircularBuffer> = new Map();
  private baselineStats: Map<DriftDimension, DistributionStats> = new Map();
  private baselineTimestamp: number | null = null;
  private baselineLocked = false;

  // Current window: rolling
  private currentBuffers: Map<DriftDimension, CircularBuffer> = new Map();
  private currentWindowStart = 0;
  private currentWindowEnd = 0;

  constructor(config: Partial<DriftDetectorConfig> = {}) {
    this.config = { ...DEFAULTS, ...config };

    for (const dim of this.config.dimensions) {
      this.baselineBuffers.set(dim, new CircularBuffer(this.config.baselineWindowSize));
      this.currentBuffers.set(dim, new CircularBuffer(this.config.currentWindowSize));
    }
  }

  /**
   * Ingest one observation. Returns a DriftAlert if drift is detected,
   * or null if everything is within bounds.
   *
   * Alert suppression during cold start: no alert fires until the current
   * window has at least `minSamplesForAlert` observations. This prevents
   * false positives on restart or deployment.
   */
  observe(obs: DriftObservation): DriftAlert | null {
    if (this.currentWindowStart === 0) this.currentWindowStart = obs.timestamp;
    this.currentWindowEnd = obs.timestamp;

    for (const dim of this.config.dimensions) {
      const value = extractDimensionValue(obs, dim);
      if (value === undefined || isNaN(value)) continue;

      const baselineBuf = this.baselineBuffers.get(dim)!;
      const currentBuf = this.currentBuffers.get(dim)!;

      // Phase 1: Fill baseline first; once full, lock it
      if (!this.baselineLocked) {
        baselineBuf.push(value);
        if (baselineBuf.size >= this.config.baselineWindowSize) {
          this._lockBaseline();
        }
        // Don't add to current window until baseline is established
        continue;
      }

      currentBuf.push(value);
    }

    if (!this.baselineLocked) return null;

    // Enforce minimum samples before alerting
    const minCurrentSize = Math.min(
      ...this.config.dimensions.map((d) => this.currentBuffers.get(d)?.size ?? 0),
    );
    if (minCurrentSize < this.config.minSamplesForAlert) return null;

    return this._checkForAlert(obs);
  }

  private _lockBaseline(): void {
    this.baselineLocked = true;
    this.baselineTimestamp = Date.now();
    for (const dim of this.config.dimensions) {
      const stats = computeStats(this.baselineBuffers.get(dim)!.toArray());
      this.baselineStats.set(dim, stats);
    }
  }

  private _checkForAlert(obs: DriftObservation): DriftAlert | null {
    for (const dim of this.config.dimensions) {
      const baseline = this.baselineStats.get(dim);
      if (!baseline || baseline.sampleCount === 0) continue;

      const currentValues = this.currentBuffers.get(dim)!.toArray();
      if (currentValues.length === 0) continue;

      const current = computeStats(currentValues);
      const score = computeDriftScore(baseline, current);

      if (score >= this.config.scoreThreshold) {
        const severity = score >= this.config.criticalThreshold ? 'critical' : 'warning';
        const alert: DriftAlert = {
          dimension: dim,
          score,
          severity,
          windowStart: this.currentWindowStart,
          windowEnd: obs.timestamp,
          baselineStats: baseline,
          currentStats: current,
        };

        this.config.onAlert?.(alert);
        return alert;
      }
    }
    return null;
  }

  /**
   * Pin the current window as the new baseline.
   *
   * Call this after an intentional change (model upgrade, prompt update)
   * to prevent the old baseline from firing false positives. Document
   * every call in your deployment runbook.
   */
  forceBaselineSnapshot(): void {
    for (const dim of this.config.dimensions) {
      const currentValues = this.currentBuffers.get(dim)!.toArray();
      if (currentValues.length === 0) continue;

      // Copy current window values into baseline buffer
      const newBaselineBuf = new CircularBuffer(this.config.baselineWindowSize);
      for (const v of currentValues) newBaselineBuf.push(v);
      this.baselineBuffers.set(dim, newBaselineBuf);
      this.baselineStats.set(dim, computeStats(currentValues));
    }
    this.baselineTimestamp = Date.now();
    this.baselineLocked = true;

    // Reset current window to start fresh comparison
    for (const dim of this.config.dimensions) {
      this.currentBuffers.set(dim, new CircularBuffer(this.config.currentWindowSize));
    }
    this.currentWindowStart = 0;
    this.currentWindowEnd = 0;
  }

  getBaseline(): Map<DriftDimension, DistributionStats> | null {
    if (!this.baselineLocked) return null;
    return new Map(this.baselineStats);
  }

  getCurrentWindow(): Map<DriftDimension, DistributionStats> | null {
    if (!this.baselineLocked) return null;
    const result = new Map<DriftDimension, DistributionStats>();
    for (const dim of this.config.dimensions) {
      result.set(dim, computeStats(this.currentBuffers.get(dim)!.toArray()));
    }
    return result;
  }

  /** Age of the current baseline in milliseconds. */
  getBaselineAgeMs(): number | null {
    if (this.baselineTimestamp === null) return null;
    return Date.now() - this.baselineTimestamp;
  }

  /** Reset to factory state — clears baseline and current window. */
  reset(): void {
    this.baselineLocked = false;
    this.baselineTimestamp = null;
    this.currentWindowStart = 0;
    this.currentWindowEnd = 0;
    for (const dim of this.config.dimensions) {
      this.baselineBuffers.set(dim, new CircularBuffer(this.config.baselineWindowSize));
      this.currentBuffers.set(dim, new CircularBuffer(this.config.currentWindowSize));
      this.baselineStats.delete(dim);
    }
  }
}

// ─── Convenience factory ───────────────────────────────────────────────────

export function createDriftDetector(config?: Partial<DriftDetectorConfig>): DriftDetector {
  return new DriftDetector(config);
}

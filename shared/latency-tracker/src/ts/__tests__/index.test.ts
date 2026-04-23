/**
 * latency-tracker — Unit Tests
 *
 * Covers: Stopwatch timing, computeStats percentiles, LatencyAccumulator
 *         accumulation/grouping/reset, SlidingWindowRecorder window eviction.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  Stopwatch,
  computeStats,
  LatencyAccumulator,
  SlidingWindowRecorder,
} from '../index.js';

// ─── Stopwatch ────────────────────────────────────────────────────────────────

describe('Stopwatch', () => {
  it('elapsed() increases over time', async () => {
    const sw = new Stopwatch();
    await new Promise((r) => setTimeout(r, 20));
    expect(sw.elapsed()).toBeGreaterThan(10);
  });

  it('stop() returns elapsed and freezes it', async () => {
    const sw = new Stopwatch();
    await new Promise((r) => setTimeout(r, 20));
    const stopped = sw.stop();
    expect(stopped).toBeGreaterThan(10);
    // Calling elapsed() after stop() returns same frozen value
    const later = sw.elapsed();
    expect(later).toBe(stopped);
  });

  it('stop() called twice returns same value', async () => {
    const sw = new Stopwatch();
    const first = sw.stop();
    await new Promise((r) => setTimeout(r, 10));
    const second = sw.stop();
    expect(second).toBe(first);
  });

  it('Stopwatch.start() is equivalent to new Stopwatch()', async () => {
    const sw = Stopwatch.start();
    await new Promise((r) => setTimeout(r, 15));
    expect(sw.elapsed()).toBeGreaterThan(10);
  });
});

// ─── computeStats ─────────────────────────────────────────────────────────────

describe('computeStats', () => {
  it('returns all zeros for empty array', () => {
    const stats = computeStats([]);
    expect(stats.count).toBe(0);
    expect(stats.minMs).toBe(0);
    expect(stats.maxMs).toBe(0);
    expect(stats.meanMs).toBe(0);
    expect(stats.p50Ms).toBe(0);
    expect(stats.p99Ms).toBe(0);
  });

  it('handles single-element array', () => {
    const stats = computeStats([42]);
    expect(stats.count).toBe(1);
    expect(stats.minMs).toBe(42);
    expect(stats.maxMs).toBe(42);
    expect(stats.meanMs).toBe(42);
    expect(stats.p50Ms).toBe(42);
    expect(stats.p99Ms).toBe(42);
  });

  it('computes correct min, max, mean', () => {
    const stats = computeStats([10, 20, 30, 40, 50]);
    expect(stats.minMs).toBe(10);
    expect(stats.maxMs).toBe(50);
    expect(stats.meanMs).toBe(30);
    expect(stats.count).toBe(5);
  });

  it('does not mutate the input array', () => {
    const samples = [30, 10, 20];
    computeStats(samples);
    expect(samples).toEqual([30, 10, 20]);
  });

  it('p50 is median for odd-length array', () => {
    // [10, 20, 30] sorted — median = 20
    const stats = computeStats([30, 10, 20]);
    expect(stats.p50Ms).toBeCloseTo(20, 5);
  });

  it('p50 interpolates for even-length array', () => {
    // [10, 20, 30, 40] — p50 idx = 1.5, interpolates 20 and 30 → 25
    const stats = computeStats([10, 20, 30, 40]);
    expect(stats.p50Ms).toBeCloseTo(25, 5);
  });

  it('p95 and p99 are near the tail', () => {
    // 100 uniform samples [1..100]
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    const stats = computeStats(samples);
    expect(stats.p95Ms).toBeCloseTo(95.05, 1);
    expect(stats.p99Ms).toBeCloseTo(99.01, 1);
  });

  it('p99 ≥ p95 ≥ p50 ≥ minMs for any input', () => {
    const samples = [5, 2, 8, 1, 9, 3, 7, 4, 6, 10];
    const stats = computeStats(samples);
    expect(stats.p99Ms).toBeGreaterThanOrEqual(stats.p95Ms);
    expect(stats.p95Ms).toBeGreaterThanOrEqual(stats.p50Ms);
    expect(stats.p50Ms).toBeGreaterThanOrEqual(stats.minMs);
  });

  it('handles samples that are already sorted', () => {
    const stats = computeStats([1, 2, 3, 4, 5]);
    expect(stats.minMs).toBe(1);
    expect(stats.maxMs).toBe(5);
  });

  it('handles duplicate values', () => {
    const stats = computeStats([100, 100, 100, 100]);
    expect(stats.minMs).toBe(100);
    expect(stats.maxMs).toBe(100);
    expect(stats.meanMs).toBe(100);
    expect(stats.p99Ms).toBe(100);
  });
});

// ─── LatencyAccumulator ───────────────────────────────────────────────────────

describe('LatencyAccumulator', () => {
  let acc: LatencyAccumulator;

  beforeEach(() => {
    acc = new LatencyAccumulator();
  });

  it('returns zero stats for unknown label', () => {
    const stats = acc.stats('nobody');
    expect(stats.count).toBe(0);
    expect(stats.meanMs).toBe(0);
  });

  it('record() returns a LatencyRecord with correct fields', () => {
    const record = acc.record(123, 'provider-a');
    expect(record.latencyMs).toBe(123);
    expect(record.label).toBe('provider-a');
    expect(typeof record.timestamp).toBe('number');
  });

  it('accumulates samples under the same label', () => {
    acc.record(100, 'svc');
    acc.record(200, 'svc');
    acc.record(300, 'svc');

    const stats = acc.stats('svc');
    expect(stats.count).toBe(3);
    expect(stats.meanMs).toBeCloseTo(200, 5);
    expect(stats.minMs).toBe(100);
    expect(stats.maxMs).toBe(300);
  });

  it('keeps separate samples per label', () => {
    acc.record(10, 'fast');
    acc.record(1000, 'slow');

    expect(acc.stats('fast').meanMs).toBe(10);
    expect(acc.stats('slow').meanMs).toBe(1000);
  });

  it('unlabeled samples accumulate under "unlabeled"', () => {
    acc.record(50);
    const stats = acc.stats('unlabeled');
    expect(stats.count).toBe(1);
    expect(stats.meanMs).toBe(50);
  });

  it('allStats() returns one entry per label', () => {
    acc.record(100, 'a');
    acc.record(200, 'a');
    acc.record(300, 'b');

    const all = acc.allStats();
    expect(all).toHaveLength(2);
    const labels = all.map((s) => s.label).sort();
    expect(labels).toEqual(['a', 'b']);
  });

  it('totalCount() sums across all labels', () => {
    acc.record(100, 'a');
    acc.record(200, 'a');
    acc.record(300, 'b');

    expect(acc.totalCount()).toBe(3);
  });

  it('reset() clears all accumulated state', () => {
    acc.record(100, 'a');
    acc.record(200, 'b');
    acc.reset();

    expect(acc.allStats()).toHaveLength(0);
    expect(acc.totalCount()).toBe(0);
    expect(acc.stats('a').count).toBe(0);
  });
});

// ─── SlidingWindowRecorder ───────────────────────────────────────────────────

describe('SlidingWindowRecorder', () => {
  it('starts with count 0', () => {
    const w = new SlidingWindowRecorder(10);
    expect(w.count).toBe(0);
    expect(w.stats().count).toBe(0);
  });

  it('records samples up to maxSize', () => {
    const w = new SlidingWindowRecorder(5);
    for (let i = 1; i <= 5; i++) w.record(i * 10);
    expect(w.count).toBe(5);
  });

  it('evicts oldest sample when window is full', () => {
    const w = new SlidingWindowRecorder(3);
    w.record(1);
    w.record(2);
    w.record(3);
    w.record(100); // evicts 1

    const stats = w.stats();
    expect(stats.count).toBe(3);
    expect(stats.minMs).toBe(2); // 1 was evicted
    expect(stats.maxMs).toBe(100);
  });

  it('stats() reflects only the current window', () => {
    const w = new SlidingWindowRecorder(2);
    w.record(10);
    w.record(20);
    w.record(30); // evicts 10

    // Only [20, 30] are in window
    const stats = w.stats();
    expect(stats.minMs).toBe(20);
    expect(stats.meanMs).toBe(25);
  });

  it('reset() clears the window', () => {
    const w = new SlidingWindowRecorder(5);
    w.record(100);
    w.record(200);
    w.reset();

    expect(w.count).toBe(0);
    expect(w.stats().count).toBe(0);
  });

  it('throws RangeError for maxSize < 1', () => {
    expect(() => new SlidingWindowRecorder(0)).toThrow(RangeError);
  });

  it('window of size 1 always holds only the latest sample', () => {
    const w = new SlidingWindowRecorder(1);
    w.record(50);
    w.record(999);

    const stats = w.stats();
    expect(stats.count).toBe(1);
    expect(stats.p99Ms).toBe(999);
  });
});

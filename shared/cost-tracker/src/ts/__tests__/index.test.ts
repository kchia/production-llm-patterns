/**
 * cost-tracker — Unit Tests
 *
 * Covers: price lookup, cost computation, token estimation,
 *         CostTracker.record/estimate, SpendAccumulator add/snapshot/global.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  BUILT_IN_PRICES,
  CostTracker,
  SpendAccumulator,
  computeCost,
  estimateTokens,
} from '../index.js';

// ─── computeCost ──────────────────────────────────────────────────────────────

describe('computeCost', () => {
  const gpt4oPrice = BUILT_IN_PRICES.find(p => p.model === 'gpt-4o')!;

  it('returns 0 for zero tokens', () => {
    expect(computeCost(0, 0, gpt4oPrice)).toBe(0);
  });

  it('calculates input cost correctly', () => {
    // 1M input tokens at $2.50/1M = $2.50
    expect(computeCost(1_000_000, 0, gpt4oPrice)).toBeCloseTo(2.50, 6);
  });

  it('calculates output cost correctly', () => {
    // 1M output tokens at $10/1M = $10
    expect(computeCost(0, 1_000_000, gpt4oPrice)).toBeCloseTo(10.00, 6);
  });

  it('sums input and output costs', () => {
    // 500K input at $2.50/1M = $1.25; 100K output at $10/1M = $1.00; total = $2.25
    expect(computeCost(500_000, 100_000, gpt4oPrice)).toBeCloseTo(2.25, 6);
  });

  it('handles fractional token counts correctly', () => {
    // 1000 input tokens at $2.50/1M = $0.0025
    const price = { model: 'test', inputPricePerMillion: 2.50, outputPricePerMillion: 10.00 };
    expect(computeCost(1_000, 0, price)).toBeCloseTo(0.0025, 6);
  });
});

// ─── estimateTokens ───────────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates ~1 token per 4 chars (ceiling)', () => {
    // "Hello" = 5 chars → ceil(5/4) = 2
    expect(estimateTokens('Hello')).toBe(2);
    // 4 chars → exactly 1
    expect(estimateTokens('test')).toBe(1);
    // 8 chars → exactly 2
    expect(estimateTokens('12345678')).toBe(2);
  });

  it('over-estimates rather than under-estimates for budget safety', () => {
    // 5-char string: ceil(5/4) = 2, which is > 5/4 = 1.25
    expect(estimateTokens('Hello')).toBeGreaterThanOrEqual(5 / 4);
  });
});

// ─── CostTracker ──────────────────────────────────────────────────────────────

describe('CostTracker', () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker();
  });

  describe('getPrice', () => {
    it('returns correct price for known model', () => {
      const price = tracker.getPrice('gpt-4o');
      expect(price.inputPricePerMillion).toBe(2.50);
      expect(price.outputPricePerMillion).toBe(10.00);
    });

    it('returns fallback price for unknown model', () => {
      const price = tracker.getPrice('unknown-future-model');
      // Should not throw; returns conservative default
      expect(price.inputPricePerMillion).toBeGreaterThan(0);
      expect(price.model).toBe('unknown-future-model');
    });
  });

  describe('record', () => {
    it('returns a CostRecord with correct token totals', () => {
      const record = tracker.record({
        model: 'gpt-4o-mini',
        inputTokens: 1000,
        outputTokens: 200,
      });

      expect(record.usage.inputTokens).toBe(1000);
      expect(record.usage.outputTokens).toBe(200);
      expect(record.usage.totalTokens).toBe(1200);
    });

    it('computes costUsd for gpt-4o-mini correctly', () => {
      // 1000 input at $0.15/1M = $0.00015; 200 output at $0.60/1M = $0.00012; total = $0.00027
      const record = tracker.record({
        model: 'gpt-4o-mini',
        inputTokens: 1000,
        outputTokens: 200,
      });

      expect(record.costUsd).toBeCloseTo(0.00027, 6);
    });

    it('attaches label when provided', () => {
      const record = tracker.record({
        model: 'gpt-4o',
        inputTokens: 100,
        outputTokens: 50,
        label: 'feature-x',
      });

      expect(record.label).toBe('feature-x');
    });

    it('uses provided timestamp', () => {
      const ts = 1700000000000;
      const record = tracker.record({
        model: 'gpt-4o',
        inputTokens: 100,
        outputTokens: 50,
        timestamp: ts,
      });

      expect(record.timestamp).toBe(ts);
    });

    it('defaults to current timestamp when not provided', () => {
      const before = Date.now();
      const record = tracker.record({ model: 'gpt-4o', inputTokens: 10, outputTokens: 10 });
      const after = Date.now();

      expect(record.timestamp).toBeGreaterThanOrEqual(before);
      expect(record.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('estimate', () => {
    it('estimates token count from prompt text', () => {
      const result = tracker.estimate({
        model: 'gpt-4o',
        promptText: 'This is a test prompt.',
      });

      expect(result.estimatedInputTokens).toBeGreaterThan(0);
      expect(result.estimatedOutputTokens).toBeGreaterThan(0);
      expect(result.estimatedCostUsd).toBeGreaterThan(0);
    });

    it('uses custom expected output tokens', () => {
      const result = tracker.estimate({
        model: 'gpt-4o',
        promptText: 'Short prompt.',
        expectedOutputTokens: 1000,
      });

      expect(result.estimatedOutputTokens).toBe(1000);
    });
  });

  describe('custom prices', () => {
    it('uses custom price table when provided', () => {
      const customTracker = new CostTracker({
        prices: [{ model: 'my-model', inputPricePerMillion: 1.0, outputPricePerMillion: 2.0 }],
      });

      const record = customTracker.record({
        model: 'my-model',
        inputTokens: 1_000_000,
        outputTokens: 0,
      });

      expect(record.costUsd).toBeCloseTo(1.0, 6);
    });
  });
});

// ─── SpendAccumulator ─────────────────────────────────────────────────────────

describe('SpendAccumulator', () => {
  let tracker: CostTracker;
  let accumulator: SpendAccumulator;

  beforeEach(() => {
    tracker = new CostTracker();
    accumulator = new SpendAccumulator();
  });

  it('returns zero snapshot for unknown label', () => {
    const snap = accumulator.snapshot('nobody');
    expect(snap.totalCostUsd).toBe(0);
    expect(snap.totalRequests).toBe(0);
  });

  it('accumulates costs for a label', () => {
    const r1 = tracker.record({ model: 'gpt-4o-mini', inputTokens: 500, outputTokens: 100, label: 'user-a' });
    const r2 = tracker.record({ model: 'gpt-4o-mini', inputTokens: 500, outputTokens: 100, label: 'user-a' });
    accumulator.add(r1);
    accumulator.add(r2);

    const snap = accumulator.snapshot('user-a');
    expect(snap.totalRequests).toBe(2);
    expect(snap.totalInputTokens).toBe(1000);
    expect(snap.totalOutputTokens).toBe(200);
    expect(snap.totalCostUsd).toBeCloseTo(r1.costUsd * 2, 9);
  });

  it('keeps separate totals per label', () => {
    accumulator.add(tracker.record({ model: 'gpt-4o', inputTokens: 1000, outputTokens: 100, label: 'a' }));
    accumulator.add(tracker.record({ model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 100, label: 'b' }));

    const snapA = accumulator.snapshot('a');
    const snapB = accumulator.snapshot('b');

    // gpt-4o costs more than gpt-4o-mini
    expect(snapA.totalCostUsd).toBeGreaterThan(snapB.totalCostUsd);
    expect(snapA.totalRequests).toBe(1);
    expect(snapB.totalRequests).toBe(1);
  });

  it('defaults unlabeled records to "unlabeled" bucket', () => {
    accumulator.add(tracker.record({ model: 'gpt-4o', inputTokens: 100, outputTokens: 50 }));
    const snap = accumulator.snapshot('unlabeled');
    expect(snap.totalRequests).toBe(1);
  });

  it('globalTotal sums across all labels', () => {
    accumulator.add(tracker.record({ model: 'gpt-4o', inputTokens: 1000, outputTokens: 100, label: 'x' }));
    accumulator.add(tracker.record({ model: 'gpt-4o', inputTokens: 1000, outputTokens: 100, label: 'y' }));

    const global = accumulator.globalTotal();
    expect(global.totalRequests).toBe(2);
    expect(global.totalInputTokens).toBe(2000);
  });

  it('reset clears all accumulated state', () => {
    accumulator.add(tracker.record({ model: 'gpt-4o', inputTokens: 100, outputTokens: 50, label: 'a' }));
    accumulator.reset();

    expect(accumulator.allSnapshots()).toHaveLength(0);
    expect(accumulator.globalTotal().totalCostUsd).toBe(0);
  });

  it('allSnapshots returns one entry per label', () => {
    accumulator.add(tracker.record({ model: 'gpt-4o', inputTokens: 100, outputTokens: 50, label: 'a' }));
    accumulator.add(tracker.record({ model: 'gpt-4o', inputTokens: 100, outputTokens: 50, label: 'a' }));
    accumulator.add(tracker.record({ model: 'gpt-4o', inputTokens: 100, outputTokens: 50, label: 'b' }));

    const snapshots = accumulator.allSnapshots();
    expect(snapshots).toHaveLength(2);
    const labels = snapshots.map(s => s.label).sort();
    expect(labels).toEqual(['a', 'b']);
  });
});

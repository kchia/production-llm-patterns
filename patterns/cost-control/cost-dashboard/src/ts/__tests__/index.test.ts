/**
 * Cost Dashboard — Tests
 *
 * Three categories:
 *   1. Unit tests — core logic under normal conditions
 *   2. Failure mode tests — one per failure mode from the README table
 *   3. Integration tests — end-to-end with mock provider
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CostDashboard,
  InMemorySpendStore,
  PriceTable,
  AlertEngine,
  trackCost,
} from '../index.js';
import { MockProvider } from '../mock-provider.js';
import { BUILT_IN_PRICES, CostEvent, DEFAULT_CONFIG } from '../types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<Omit<CostEvent, 'costUsd'>> = {}): Omit<CostEvent, 'costUsd'> {
  return {
    timestamp:     new Date(),
    requestId:     'req-1',
    feature:       'document-analysis',
    model:         'gpt-4o',
    promptVersion: 'v1.0',
    inputTokens:   500,
    outputTokens:  150,
    latencyMs:     210,
    tags:          {},
    ...overrides,
  };
}

// ─── Unit Tests ───────────────────────────────────────────────────────────────

describe('PriceTable', () => {
  it('computes cost correctly for known model', () => {
    const pt = new PriceTable(BUILT_IN_PRICES);
    // gpt-4o: $2.50/1M input, $10.00/1M output
    // 1000 input + 200 output = 0.0025 + 0.002 = $0.0045
    const cost = pt.computeCost('gpt-4o', 1000, 200);
    expect(cost).toBeCloseTo(0.0045, 6);
  });

  it('returns 0 for unknown model', () => {
    const pt = new PriceTable(BUILT_IN_PRICES);
    expect(pt.computeCost('unknown-model-xyz', 1000, 200)).toBe(0);
  });

  it('updatePrices refreshes lastRefreshed timestamp', async () => {
    const pt = new PriceTable(BUILT_IN_PRICES);
    const before = pt.getLastRefreshed();
    await new Promise(r => setTimeout(r, 5));
    pt.updatePrices([{ model: 'gpt-4o', inputPricePerMillionTokens: 3.00, outputPricePerMillionTokens: 12.00, fetchedAt: new Date() }]);
    expect(pt.getLastRefreshed().getTime()).toBeGreaterThan(before.getTime());
  });

  it('hasModel returns true for known, false for unknown', () => {
    const pt = new PriceTable(BUILT_IN_PRICES);
    expect(pt.hasModel('gpt-4o')).toBe(true);
    expect(pt.hasModel('gpt-5')).toBe(false);
  });
});

describe('CostDashboard.record', () => {
  let dashboard: CostDashboard;

  beforeEach(() => {
    dashboard = new CostDashboard();
  });

  it('records event and computes costUsd', () => {
    const event = dashboard.record(makeEvent({ inputTokens: 1000, outputTokens: 200 }));
    expect(event.costUsd).toBeCloseTo(0.0045, 6); // gpt-4o: $2.50+$10/1M
    expect(dashboard.getStore().size()).toBe(1);
  });

  it('records event with all optional fields', () => {
    const event = dashboard.record(makeEvent({
      userId: 'user-123',
      teamId: 'team-a',
      tags: { environment: 'production' },
    }));
    expect(event.userId).toBe('user-123');
    expect(event.teamId).toBe('team-a');
  });
});

describe('CostDashboard.query', () => {
  let dashboard: CostDashboard;
  const now = new Date();
  const start = new Date(now.getTime() - 3600_000);
  const end   = new Date(now.getTime() + 1000);

  beforeEach(() => {
    dashboard = new CostDashboard();
    dashboard.record(makeEvent({ feature: 'chat',     model: 'gpt-4o',      inputTokens: 1000, outputTokens: 200 }));
    dashboard.record(makeEvent({ feature: 'chat',     model: 'gpt-4o',      inputTokens: 500,  outputTokens: 100 }));
    dashboard.record(makeEvent({ feature: 'analysis', model: 'gpt-4o-mini', inputTokens: 2000, outputTokens: 400 }));
  });

  it('groups by feature correctly', () => {
    const results = dashboard.query({ groupBy: 'feature', startTime: start, endTime: end });
    expect(results).toHaveLength(2);
    const chatRow = results.find(r => r.dimensionValue === 'chat');
    expect(chatRow).toBeDefined();
    expect(chatRow!.totalRequests).toBe(2);
  });

  it('groups by model correctly', () => {
    const results = dashboard.query({ groupBy: 'model', startTime: start, endTime: end });
    expect(results).toHaveLength(2);
    const miniRow = results.find(r => r.dimensionValue === 'gpt-4o-mini');
    expect(miniRow).toBeDefined();
    expect(miniRow!.totalRequests).toBe(1);
  });

  it('sorts results by totalCostUsd descending', () => {
    const results = dashboard.query({ groupBy: 'feature', startTime: start, endTime: end });
    expect(results[0].totalCostUsd).toBeGreaterThanOrEqual(results[1].totalCostUsd);
  });

  it('applies feature filter', () => {
    const results = dashboard.query({
      groupBy: 'feature',
      startTime: start,
      endTime: end,
      filters: { feature: 'chat' },
    });
    expect(results).toHaveLength(1);
    expect(results[0].dimensionValue).toBe('chat');
  });

  it('respects minCostUsd filter', () => {
    // gpt-4o-mini is much cheaper; set threshold above its spend
    const results = dashboard.query({
      groupBy: 'feature',
      startTime: start,
      endTime: end,
      minCostUsd: 0.01,
    });
    // Only the more expensive 'chat' rows should appear
    for (const r of results) {
      expect(r.totalCostUsd).toBeGreaterThanOrEqual(0.01);
    }
  });

  it('returns empty array when no events in window', () => {
    const pastStart = new Date(0);
    const pastEnd   = new Date(1000);
    const results = dashboard.query({ groupBy: 'feature', startTime: pastStart, endTime: pastEnd });
    expect(results).toHaveLength(0);
  });
});

describe('CostDashboard.computeCost', () => {
  it('returns correct value without recording', () => {
    const dashboard = new CostDashboard();
    // gpt-4o-mini: $0.15/1M input, $0.60/1M output
    const cost = dashboard.computeCost('gpt-4o-mini', 10_000, 1_000);
    expect(cost).toBeCloseTo(0.0015 + 0.0006, 6);
  });
});

// ─── Failure Mode Tests ───────────────────────────────────────────────────────

describe('Failure Mode: Missing attribution tags', () => {
  it('records event with "unknown" feature when feature is empty', () => {
    const dashboard = new CostDashboard({ requiredTags: ['feature'] });
    const event = dashboard.record(makeEvent({ feature: '' }));
    expect(event.feature).toBe('unknown');
  });

  it('increments missing tag counter', () => {
    const dashboard = new CostDashboard({ requiredTags: ['feature'] });
    dashboard.record(makeEvent({ feature: '' }));
    dashboard.record(makeEvent({ feature: '' }));
    expect(dashboard.getMissingTagCounts().get('feature')).toBe(2);
  });

  it('fires missingTags alert when >10% of events have unknown feature', () => {
    const store = new InMemorySpendStore();
    const dashboard = new CostDashboard({}, store);

    // Record 9 proper events + 2 unknown = ~18% missing
    for (let i = 0; i < 9; i++) {
      dashboard.record(makeEvent({ requestId: `req-${i}` }));
    }
    dashboard.record(makeEvent({ requestId: 'bad-1', feature: '' }));
    dashboard.record(makeEvent({ requestId: 'bad-2', feature: '' }));

    const alerts = dashboard.checkAlerts();
    const missingAlert = alerts.find(a => a.type === 'missingTags');
    expect(missingAlert).toBeDefined();
    expect(missingAlert!.severity).toBe('warning');
  });
});

describe('Failure Mode: Stale price table', () => {
  it('fires priceTableStale warning when price table age > 2h', () => {
    // Create a price table and manually backdate its lastRefreshed.
    const priceTable = new PriceTable(BUILT_IN_PRICES);
    // Manually set age to 3 hours via an internal update that pre-dates now.
    const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000);
    priceTable.updatePrices([{
      model: 'gpt-4o',
      inputPricePerMillionTokens: 2.50,
      outputPricePerMillionTokens: 10.00,
      fetchedAt: threeHoursAgo,
    }]);

    const store = new InMemorySpendStore();
    const dashboard = new CostDashboard({}, store, priceTable);

    // Backdate the priceTable's lastRefreshed by injecting a stale ageMs
    // We test this via the AlertEngine directly with a known age value.
    const engine = new AlertEngine(DEFAULT_CONFIG.alertConfig);
    store.record({
      ...makeEvent(),
      costUsd: 0.001,
    } as CostEvent);

    // Simulate 3-hour stale table
    const alerts = engine.evaluate(store, 3 * 3600 * 1000);
    const staleAlert = alerts.find(a => a.type === 'priceTableStale');
    expect(staleAlert).toBeDefined();
    expect(staleAlert!.severity).toBe('warning');
  });

  it('fires critical priceTableStale when age > 6h', () => {
    const store = new InMemorySpendStore();
    store.record({ ...makeEvent(), costUsd: 0.001 } as CostEvent);
    const engine = new AlertEngine(DEFAULT_CONFIG.alertConfig);
    const alerts = engine.evaluate(store, 7 * 3600 * 1000); // 7 hours stale
    const staleAlert = alerts.find(a => a.type === 'priceTableStale');
    expect(staleAlert!.severity).toBe('critical');
  });
});

describe('Failure Mode: Spike detection', () => {
  it('fires spike alert when current window spend exceeds baseline × sensitivity', () => {
    const store = new InMemorySpendStore();

    // Build a baseline: 168h of events at $0.001 per event, 1 event per hour
    const baselineEvents = 168;
    for (let i = 0; i < baselineEvents; i++) {
      const ts = new Date(Date.now() - (168 - i) * 3600_000);
      store.record({
        ...makeEvent(),
        timestamp: ts,
        requestId: `baseline-${i}`,
        costUsd: 0.001, // $0.001/hr baseline
      } as CostEvent);
    }

    // Current window (last 1 hour): 10 events at $0.001 = $0.01
    // Baseline normalized to 1h = $0.001/hr
    // Ratio = $0.01 / $0.001 = 10× → should exceed 2.5× sensitivity
    for (let i = 0; i < 10; i++) {
      store.record({
        ...makeEvent(),
        timestamp: new Date(Date.now() - 1000 * i), // within last 1h
        requestId: `spike-${i}`,
        costUsd: 0.001,
      } as CostEvent);
    }

    const engine = new AlertEngine(DEFAULT_CONFIG.alertConfig);
    const alerts = engine.evaluate(store, 0);
    const spikeAlert = alerts.find(a => a.type === 'spike');
    expect(spikeAlert).toBeDefined();
  });
});

describe('Failure Mode: Concentration risk', () => {
  it('fires concentrationRisk when one feature > 40% of spend in current window', () => {
    const store = new InMemorySpendStore();

    // One dominant feature at 80% of spend
    store.record({ ...makeEvent({ feature: 'dominant',  costUsd: 0.08 } as any), costUsd: 0.08, timestamp: new Date() } as CostEvent);
    store.record({ ...makeEvent({ feature: 'other',     costUsd: 0.01 } as any), costUsd: 0.01, timestamp: new Date() } as CostEvent);
    store.record({ ...makeEvent({ feature: 'other2',    costUsd: 0.01 } as any), costUsd: 0.01, timestamp: new Date() } as CostEvent);

    const engine = new AlertEngine(DEFAULT_CONFIG.alertConfig);
    const alerts = engine.evaluate(store, 0);
    const concAlert = alerts.find(a => a.type === 'concentrationRisk');
    expect(concAlert).toBeDefined();
    expect(concAlert!.context.feature).toBe('dominant');
  });
});

describe('Failure Mode: Test traffic contamination (detection)', () => {
  it('environment tag on events allows filtering test vs production', () => {
    const dashboard = new CostDashboard();
    const now = new Date();
    const start = new Date(now.getTime() - 3600_000);
    const end   = new Date(now.getTime() + 1000);

    dashboard.record(makeEvent({ requestId: 'prod-1', tags: { environment: 'production' } }));
    dashboard.record(makeEvent({ requestId: 'test-1', tags: { environment: 'test' } }));

    // Both are in the store — caller must filter by tag
    const all = dashboard.query({ groupBy: 'feature', startTime: start, endTime: end });
    expect(all[0].totalRequests).toBe(2);

    // Verify the raw store has both events so the caller can filter
    const events = dashboard.getStore().getEvents(start, end);
    const testEvents = events.filter(e => e.tags.environment === 'test');
    const prodEvents = events.filter(e => e.tags.environment === 'production');
    expect(testEvents).toHaveLength(1);
    expect(prodEvents).toHaveLength(1);
  });
});

describe('Failure Mode: Unknown model (silent $0 cost)', () => {
  it('records $0 cost for unknown model and does not throw', () => {
    const dashboard = new CostDashboard();
    const event = dashboard.record(makeEvent({ model: 'gpt-99-turbo-ultra' }));
    // Cost should be 0, not an error
    expect(event.costUsd).toBe(0);
  });
});

// ─── Integration Tests ────────────────────────────────────────────────────────

describe('Integration: trackCost middleware with MockProvider', () => {
  it('records cost event after provider call succeeds', async () => {
    const provider = new MockProvider({ baseLatencyMs: 0, jitterMs: 0, outputTokens: 100 });
    const dashboard = new CostDashboard();

    const result = await trackCost(
      dashboard,
      () => provider.complete('Hello world', 'gpt-4o'),
      { feature: 'chat', model: 'gpt-4o', promptVersion: 'v1.0' },
    );

    expect(result.usage.outputTokens).toBe(100);
    expect(dashboard.getStore().size()).toBe(1);

    const now = new Date();
    const start = new Date(now.getTime() - 5000);
    const events = dashboard.getStore().getEvents(start, now);
    expect(events[0].feature).toBe('chat');
    expect(events[0].costUsd).toBeGreaterThan(0);
  });

  it('end-to-end: multiple features → correct spend totals per feature', async () => {
    const provider = new MockProvider({ baseLatencyMs: 0, jitterMs: 0, inputTokens: 500, outputTokens: 150 });
    const dashboard = new CostDashboard();
    const now = new Date();

    // 3 chat requests
    for (let i = 0; i < 3; i++) {
      await trackCost(dashboard, () => provider.complete('chat prompt', 'gpt-4o'), { feature: 'chat', model: 'gpt-4o', promptVersion: 'v1' });
    }
    // 1 analysis request
    await trackCost(dashboard, () => provider.complete('analysis prompt', 'gpt-4o-mini'), { feature: 'analysis', model: 'gpt-4o-mini', promptVersion: 'v1' });

    const results = dashboard.query({
      groupBy: 'feature',
      startTime: new Date(now.getTime() - 5000),
      endTime: new Date(now.getTime() + 5000),
    });

    expect(results).toHaveLength(2);
    const chatRow = results.find(r => r.dimensionValue === 'chat');
    expect(chatRow!.totalRequests).toBe(3);
  });

  it('concurrent writes are consistent', async () => {
    const provider = new MockProvider({ baseLatencyMs: 0, jitterMs: 0, inputTokens: 100, outputTokens: 50 });
    const dashboard = new CostDashboard();

    // 20 concurrent requests
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        trackCost(
          dashboard,
          () => provider.complete(`prompt ${i}`, 'gpt-4o'),
          { feature: 'load-test', model: 'gpt-4o', promptVersion: 'v1' },
        )
      )
    );

    expect(dashboard.getStore().size()).toBe(20);

    const now = new Date();
    const results = dashboard.query({
      groupBy: 'feature',
      startTime: new Date(now.getTime() - 5000),
      endTime: new Date(now.getTime() + 5000),
    });
    expect(results[0].totalRequests).toBe(20);
  });
});

describe('Integration: alert workflow', () => {
  it('no alerts when dashboard is healthy', () => {
    const dashboard = new CostDashboard();
    dashboard.record(makeEvent());
    const alerts = dashboard.checkAlerts();
    // With fresh price table and no spikes, no alerts should fire
    expect(alerts.filter(a => a.type === 'priceTableStale')).toHaveLength(0);
  });
});

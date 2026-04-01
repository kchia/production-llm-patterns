import { describe, it, expect, beforeEach } from 'vitest';
import { IndexMaintenanceScheduler, DEFAULT_CONFIG } from '../index.js';
import { MockVectorStoreAdapter } from '../mock-provider.js';
import type { MaintenanceConfig } from '../types.js';

const COLLECTION = 'test-collection';

function makeScheduler(
  adapter: MockVectorStoreAdapter,
  overrides: Partial<MaintenanceConfig> = {},
) {
  return new IndexMaintenanceScheduler(adapter, {
    ...DEFAULT_CONFIG,
    maintenanceCooldownMs: 0, // disable cooldown in most tests
    ...overrides,
  });
}

// ─── Unit tests ──────────────────────────────────────────────────────────────

describe('IndexHealthMetrics calculation', () => {
  it('computes tombstone_ratio correctly', async () => {
    const adapter = new MockVectorStoreAdapter();
    adapter.configure(COLLECTION, {
      totalVectors: 100_000,
      deletedVectors: 20_000,
    });
    const scheduler = makeScheduler(adapter);
    const metrics = await scheduler.checkHealth(COLLECTION);
    expect(metrics.tombstoneRatio).toBeCloseTo(0.2);
  });

  it('returns tombstone_ratio of 0 for empty collection', async () => {
    const adapter = new MockVectorStoreAdapter();
    adapter.configure(COLLECTION, { totalVectors: 0, deletedVectors: 0 });
    const scheduler = makeScheduler(adapter);
    const metrics = await scheduler.checkHealth(COLLECTION);
    expect(metrics.tombstoneRatio).toBe(0);
  });

  it('computes payload index coverage correctly', async () => {
    const adapter = new MockVectorStoreAdapter();
    adapter.configure(COLLECTION, {
      totalVectors: 50_000,
      deletedVectors: 0,
      queryFilterFields: ['category', 'date', 'author'],
      indexedFields: ['category', 'date'], // 'author' not indexed
    });
    const scheduler = makeScheduler(adapter);
    const metrics = await scheduler.checkHealth(COLLECTION);
    expect(metrics.payloadIndexCoverage).toBeCloseTo(2 / 3);
  });

  it('returns full coverage when no query fields exist', async () => {
    const adapter = new MockVectorStoreAdapter();
    adapter.configure(COLLECTION, {
      queryFilterFields: [],
      indexedFields: [],
    });
    const scheduler = makeScheduler(adapter);
    const metrics = await scheduler.checkHealth(COLLECTION);
    expect(metrics.payloadIndexCoverage).toBe(1.0);
  });
});

describe('Maintenance planner', () => {
  it('plans vacuum when tombstone ratio exceeds threshold', async () => {
    const adapter = new MockVectorStoreAdapter();
    adapter.configure(COLLECTION, {
      totalVectors: 100_000,
      deletedVectors: 20_000, // 0.20 ratio — exceeds default 0.15
    });
    const scheduler = makeScheduler(adapter);
    const metrics = await scheduler.checkHealth(COLLECTION);
    const ops = scheduler.planMaintenance(metrics);
    expect(ops.some((o) => o.type === 'vacuum')).toBe(true);
  });

  it('does not plan vacuum when tombstone ratio is below threshold', async () => {
    const adapter = new MockVectorStoreAdapter();
    adapter.configure(COLLECTION, {
      totalVectors: 100_000,
      deletedVectors: 5_000, // 0.05 ratio — below default 0.15
    });
    const scheduler = makeScheduler(adapter);
    const metrics = await scheduler.checkHealth(COLLECTION);
    const ops = scheduler.planMaintenance(metrics);
    expect(ops.some((o) => o.type === 'vacuum')).toBe(false);
  });

  it('plans compact_segments when segment count exceeds max', async () => {
    const adapter = new MockVectorStoreAdapter();
    adapter.configure(COLLECTION, {
      totalVectors: 100_000,
      deletedVectors: 0,
      segmentCount: 30, // exceeds default max 20
    });
    const scheduler = makeScheduler(adapter);
    const metrics = await scheduler.checkHealth(COLLECTION);
    const ops = scheduler.planMaintenance(metrics);
    expect(ops.some((o) => o.type === 'compact_segments')).toBe(true);
  });

  it('plans optimize_payload_index when coverage is low', async () => {
    const adapter = new MockVectorStoreAdapter();
    adapter.configure(COLLECTION, {
      totalVectors: 50_000,
      deletedVectors: 0,
      queryFilterFields: ['category', 'date', 'region'],
      indexedFields: ['category'], // 0.33 coverage — below default 0.80
    });
    const scheduler = makeScheduler(adapter);
    const metrics = await scheduler.checkHealth(COLLECTION);
    const ops = scheduler.planMaintenance(metrics);
    expect(ops.some((o) => o.type === 'optimize_payload_index')).toBe(true);
  });

  it('returns empty list when index is healthy', async () => {
    const adapter = new MockVectorStoreAdapter();
    adapter.configure(COLLECTION, {
      totalVectors: 100_000,
      deletedVectors: 1_000, // 0.01 ratio — healthy
      segmentCount: 5,
      queryFilterFields: ['category'],
      indexedFields: ['category'],
    });
    const scheduler = makeScheduler(adapter);
    const metrics = await scheduler.checkHealth(COLLECTION);
    const ops = scheduler.planMaintenance(metrics);
    expect(ops).toHaveLength(0);
  });
});

// ─── Failure mode tests ───────────────────────────────────────────────────────

describe('Failure mode: tombstone accumulation', () => {
  it('detects tombstone accumulation and executes vacuum', async () => {
    const adapter = new MockVectorStoreAdapter();
    adapter.configure(COLLECTION, {
      totalVectors: 100_000,
      deletedVectors: 20_000, // 0.20 ratio
      segmentCount: 5,
      queryFilterFields: [],
      indexedFields: [],
    });
    const scheduler = makeScheduler(adapter);
    const result = await scheduler.runMaintenance(COLLECTION);

    expect(result.success).toBe(true);
    expect(result.operationsExecuted.some((o) => o.type === 'vacuum')).toBe(true);
    expect(result.metricsAfterRun.tombstoneRatio).toBe(0);
  });
});

describe('Failure mode: segment explosion from bulk ingest', () => {
  it('detects high segment count and executes compaction', async () => {
    const adapter = new MockVectorStoreAdapter();
    adapter.configure(COLLECTION, {
      totalVectors: 200_000,
      deletedVectors: 0,
      segmentCount: 45, // bulk ingest explosion
    });
    const scheduler = makeScheduler(adapter);
    const result = await scheduler.runMaintenance(COLLECTION);

    expect(result.success).toBe(true);
    expect(
      result.operationsExecuted.some((o) => o.type === 'compact_segments'),
    ).toBe(true);
    expect(result.metricsAfterRun.segmentCount).toBeLessThan(45);
  });
});

describe('Failure mode: payload index drift', () => {
  it('detects unindexed filter fields and triggers optimization', async () => {
    const adapter = new MockVectorStoreAdapter();
    adapter.configure(COLLECTION, {
      totalVectors: 50_000,
      deletedVectors: 0,
      segmentCount: 5,
      queryFilterFields: ['category', 'date', 'region'],
      indexedFields: ['category'], // 0.33 coverage
    });
    const scheduler = makeScheduler(adapter);
    const result = await scheduler.runMaintenance(COLLECTION);

    expect(result.success).toBe(true);
    expect(
      result.operationsExecuted.some(
        (o) => o.type === 'optimize_payload_index',
      ),
    ).toBe(true);
    expect(result.metricsAfterRun.payloadIndexCoverage).toBeCloseTo(1.0);
  });
});

describe('Failure mode: vacuum loop prevention', () => {
  it('skips maintenance during cooldown period', async () => {
    const adapter = new MockVectorStoreAdapter();
    adapter.configure(COLLECTION, {
      totalVectors: 100_000,
      deletedVectors: 20_000,
      simulateCleanupEffect: false, // don't clear tombstones so second run would want to run
    });
    // Short cooldown for test — long enough to still be active
    const scheduler = makeScheduler(adapter, {
      maintenanceCooldownMs: 60_000,
    });

    // First run should execute
    const result1 = await scheduler.runMaintenance(COLLECTION);
    expect(result1.operationsExecuted.length).toBeGreaterThan(0);

    // Second run immediately after — should be blocked by cooldown
    const result2 = await scheduler.runMaintenance(COLLECTION);
    expect(result2.operationsExecuted).toHaveLength(0);
    expect(result2.error).toMatch(/cooldown/);
  });
});

describe('Failure mode: silent recall degradation detection', () => {
  it('detects degraded state via tombstone ratio metric', async () => {
    const adapter = new MockVectorStoreAdapter();
    adapter.configure(COLLECTION, {
      totalVectors: 100_000,
      deletedVectors: 18_000, // just above 0.15 threshold — silent if threshold were 0.20
    });
    const scheduler = makeScheduler(adapter, { tombstoneThreshold: 0.15 });
    const metrics = await scheduler.checkHealth(COLLECTION);
    expect(metrics.tombstoneRatio).toBeGreaterThanOrEqual(0.15);
    const ops = scheduler.planMaintenance(metrics);
    expect(ops.some((o) => o.type === 'vacuum')).toBe(true);
  });
});

describe('Failure mode: maintenance blocked by traffic gate', () => {
  it('defers maintenance when traffic rate exceeds threshold', async () => {
    const adapter = new MockVectorStoreAdapter();
    adapter.configure(COLLECTION, {
      totalVectors: 100_000,
      deletedVectors: 20_000,
    });
    const scheduler = makeScheduler(adapter, {
      maxTrafficRateForMaintenance: 50,
    });
    scheduler.setTrafficRate(200); // above threshold

    const result = await scheduler.runMaintenance(COLLECTION);
    expect(result.operationsExecuted).toHaveLength(0);
    expect(result.error).toMatch(/traffic rate/);
    expect(adapter.operationLog).toHaveLength(0);
  });
});

// ─── Integration test ─────────────────────────────────────────────────────────

describe('Integration: full maintenance cycle', () => {
  let adapter: MockVectorStoreAdapter;
  let scheduler: IndexMaintenanceScheduler;

  beforeEach(() => {
    adapter = new MockVectorStoreAdapter();
    scheduler = makeScheduler(adapter);
  });

  it('executes vacuum + compact in priority order on a degraded collection', async () => {
    adapter.configure(COLLECTION, {
      totalVectors: 100_000,
      deletedVectors: 20_000,
      segmentCount: 35,
      queryFilterFields: ['category'],
      indexedFields: ['category'],
    });

    const result = await scheduler.runMaintenance(COLLECTION);

    expect(result.success).toBe(true);
    expect(result.operationsExecuted[0].type).toBe('vacuum');
    expect(result.operationsExecuted[1].type).toBe('compact_segments');
    expect(result.metricsAfterRun.tombstoneRatio).toBe(0);
    expect(result.metricsAfterRun.segmentCount).toBeLessThan(35);
  });

  it('emits metrics before and after run', async () => {
    adapter.configure(COLLECTION, {
      totalVectors: 100_000,
      deletedVectors: 20_000,
      segmentCount: 30,
    });
    const result = await scheduler.runMaintenance(COLLECTION);

    expect(result.metricsBeforeRun.tombstoneRatio).toBeGreaterThan(0);
    expect(result.metricsAfterRun.tombstoneRatio).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('handles operation failure gracefully', async () => {
    adapter.configure(COLLECTION, {
      totalVectors: 100_000,
      deletedVectors: 20_000,
      operationError: new Error('vacuum timed out'),
    });
    const result = await scheduler.runMaintenance(COLLECTION);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/vacuum timed out/);
  });

  it('skips execution when index is healthy', async () => {
    adapter.configure(COLLECTION, {
      totalVectors: 100_000,
      deletedVectors: 1_000, // 0.01 ratio
      segmentCount: 3,
      queryFilterFields: ['category'],
      indexedFields: ['category'],
    });
    const result = await scheduler.runMaintenance(COLLECTION);

    expect(result.success).toBe(true);
    expect(result.operationsExecuted).toHaveLength(0);
    expect(adapter.operationLog).toHaveLength(0);
  });
});

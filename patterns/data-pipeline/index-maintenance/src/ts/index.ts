import type {
  IndexHealthMetrics,
  MaintenanceConfig,
  MaintenanceOperation,
  MaintenanceResult,
  VectorStoreAdapter,
} from './types.js';
import { DEFAULT_CONFIG } from './types.js';

export class IndexMaintenanceScheduler {
  private lastRunAt: Map<string, number> = new Map();
  private currentTrafficRate = 0;

  constructor(
    private readonly adapter: VectorStoreAdapter,
    private readonly config: MaintenanceConfig = DEFAULT_CONFIG,
  ) {}

  /**
   * Update the current traffic rate for the traffic gate.
   * Call this from your request handler or metrics collector.
   */
  setTrafficRate(reqPerSecond: number): void {
    this.currentTrafficRate = reqPerSecond;
  }

  // ─── Step 1: Health Check ──────────────────────────────────────────────────

  async checkHealth(collectionName: string): Promise<IndexHealthMetrics> {
    const stats = await this.adapter.getCollectionStats(collectionName);
    const queryFields = await this.adapter.getQueryFilterFields(collectionName);
    const indexedFields = await this.adapter.getIndexedFields(collectionName);

    const tombstoneRatio =
      stats.totalVectors > 0
        ? stats.deletedVectors / stats.totalVectors
        : 0;

    // Payload index coverage: fraction of query fields that have indexes.
    // Zero query fields means full coverage (nothing to index).
    const payloadIndexCoverage =
      queryFields.length === 0
        ? 1.0
        : queryFields.filter((f) => indexedFields.includes(f)).length /
          queryFields.length;

    const avgSegmentSize =
      stats.segmentCount > 0
        ? (stats.totalVectors - stats.deletedVectors) / stats.segmentCount
        : 0;

    const lastRunAt = this.lastRunAt.get(collectionName);
    const lastMaintenanceMs = lastRunAt
      ? Date.now() - lastRunAt
      : // Fall back to timestamp from store if we haven't run yet this session
        stats.lastMaintenanceTimestamp
        ? Date.now() - stats.lastMaintenanceTimestamp
        : Infinity;

    return {
      collectionName,
      totalVectors: stats.totalVectors,
      deletedVectors: stats.deletedVectors,
      tombstoneRatio,
      segmentCount: stats.segmentCount,
      avgSegmentSize,
      payloadIndexCoverage,
      lastMaintenanceMs,
      collectedAt: new Date(),
    };
  }

  // ─── Step 2: Threshold Evaluation + Planning ───────────────────────────────

  /**
   * Returns an ordered list of operations to run.
   * Order matters: vacuum before compact before rebuild — each operation
   * reduces the scope of subsequent ones.
   */
  planMaintenance(metrics: IndexHealthMetrics): MaintenanceOperation[] {
    const ops: MaintenanceOperation[] = [];

    if (metrics.tombstoneRatio >= this.config.tombstoneThreshold) {
      ops.push({
        type: 'vacuum',
        reason: `tombstone_ratio ${metrics.tombstoneRatio.toFixed(3)} >= threshold ${this.config.tombstoneThreshold}`,
      });
    }

    if (metrics.segmentCount >= this.config.maxSegments) {
      ops.push({
        type: 'compact_segments',
        reason: `segment_count ${metrics.segmentCount} >= max ${this.config.maxSegments}`,
      });
    }

    if (metrics.payloadIndexCoverage < this.config.minPayloadIndexCoverage) {
      // Identify which query fields are missing indexes for the operation executor
      ops.push({
        type: 'optimize_payload_index',
        fields: [], // executor resolves actual fields
        reason: `payload_index_coverage ${metrics.payloadIndexCoverage.toFixed(2)} < min ${this.config.minPayloadIndexCoverage}`,
      });
    }

    return ops;
  }

  // ─── Step 4: Execution ────────────────────────────────────────────────────

  /**
   * Full maintenance cycle: check health, decide, execute.
   * Respects cooldown and traffic gate — safe to call on a schedule.
   */
  async runMaintenance(collectionName: string): Promise<MaintenanceResult> {
    const startMs = Date.now();

    // Traffic gate: defer if current load is too high
    if (this.currentTrafficRate > this.config.maxTrafficRateForMaintenance) {
      const metrics = await this.checkHealth(collectionName);
      return {
        collectionName,
        operationsExecuted: [],
        durationMs: Date.now() - startMs,
        metricsBeforeRun: metrics,
        metricsAfterRun: metrics,
        success: true,
        error: `deferred: traffic rate ${this.currentTrafficRate} req/s exceeds gate threshold`,
      };
    }

    // Cooldown check: prevents vacuum loops under sustained churn
    const lastRun = this.lastRunAt.get(collectionName) ?? 0;
    const timeSinceLast = Date.now() - lastRun;
    if (timeSinceLast < this.config.maintenanceCooldownMs) {
      const metrics = await this.checkHealth(collectionName);
      return {
        collectionName,
        operationsExecuted: [],
        durationMs: Date.now() - startMs,
        metricsBeforeRun: metrics,
        metricsAfterRun: metrics,
        success: true,
        error: `skipped: cooldown active (${Math.round(timeSinceLast / 1000)}s elapsed, need ${Math.round(this.config.maintenanceCooldownMs / 1000)}s)`,
      };
    }

    const metricsBeforeRun = await this.checkHealth(collectionName);
    const ops = this.planMaintenance(metricsBeforeRun);

    if (ops.length === 0) {
      return {
        collectionName,
        operationsExecuted: [],
        durationMs: Date.now() - startMs,
        metricsBeforeRun,
        metricsAfterRun: metricsBeforeRun,
        success: true,
      };
    }

    const executed: MaintenanceOperation[] = [];

    // Execute with a hard duration limit — abandon remaining ops rather than
    // block reads indefinitely on a large rebuild.
    for (const op of ops) {
      if (Date.now() - startMs >= this.config.maxMaintenanceDurationMs) {
        break;
      }

      try {
        await this.executeOperation(collectionName, op);
        executed.push(op);
      } catch (err) {
        const metricsAfterRun = await this.checkHealth(collectionName);
        return {
          collectionName,
          operationsExecuted: executed,
          durationMs: Date.now() - startMs,
          metricsBeforeRun,
          metricsAfterRun,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    this.lastRunAt.set(collectionName, Date.now());
    const metricsAfterRun = await this.checkHealth(collectionName);

    return {
      collectionName,
      operationsExecuted: executed,
      durationMs: Date.now() - startMs,
      metricsBeforeRun,
      metricsAfterRun,
      success: true,
    };
  }

  private async executeOperation(
    collectionName: string,
    op: MaintenanceOperation,
  ): Promise<void> {
    switch (op.type) {
      case 'vacuum':
        await this.adapter.runVacuum(collectionName);
        break;
      case 'compact_segments':
        await this.adapter.compactSegments(collectionName);
        break;
      case 'optimize_payload_index': {
        // Resolve unindexed fields at execution time (planner may not have them)
        const queryFields =
          await this.adapter.getQueryFilterFields(collectionName);
        const indexedFields =
          await this.adapter.getIndexedFields(collectionName);
        const missing = queryFields.filter((f) => !indexedFields.includes(f));
        if (missing.length > 0) {
          await this.adapter.optimizePayloadIndex(collectionName, missing);
        }
        break;
      }
      case 'rebuild':
        await this.adapter.rebuildIndex(collectionName);
        break;
    }
  }

  // ─── Convenience: get last run info ───────────────────────────────────────

  getLastRunAt(collectionName: string): number | undefined {
    return this.lastRunAt.get(collectionName);
  }
}

export { DEFAULT_CONFIG } from './types.js';
export type {
  IndexHealthMetrics,
  MaintenanceConfig,
  MaintenanceOperation,
  MaintenanceResult,
  VectorStoreAdapter,
} from './types.js';

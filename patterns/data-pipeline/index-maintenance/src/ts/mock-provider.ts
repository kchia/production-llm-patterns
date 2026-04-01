import type {
  VectorStoreAdapter,
  CollectionStats,
} from './types.js';

export interface MockCollectionConfig {
  totalVectors?: number;
  deletedVectors?: number;
  segmentCount?: number;
  lastMaintenanceTimestamp?: number;
  queryFilterFields?: string[];
  indexedFields?: string[];
  /** If set, operations will throw this error */
  operationError?: Error;
  /** Artificial delay per operation in ms */
  operationDelayMs?: number;
  /**
   * When true, stats after vacuum/compact reflect a cleaned state.
   * Allows integration tests to verify post-run metrics.
   */
  simulateCleanupEffect?: boolean;
}

/**
 * Mock vector store adapter for testing and benchmarks.
 * Supports configurable stats, error injection, and latency simulation.
 */
export class MockVectorStoreAdapter implements VectorStoreAdapter {
  private collections = new Map<string, MockCollectionConfig>();
  // Tracks which operations were called, for test assertions
  public operationLog: Array<{ op: string; collection: string; ts: number }> = [];

  configure(collectionName: string, config: MockCollectionConfig): void {
    this.collections.set(collectionName, {
      totalVectors: 100_000,
      deletedVectors: 5_000,
      segmentCount: 8,
      queryFilterFields: ['category', 'date'],
      indexedFields: ['category', 'date'],
      operationDelayMs: 0,
      simulateCleanupEffect: true,
      ...config,
    });
  }

  private async delay(collectionName: string): Promise<void> {
    const cfg = this.collections.get(collectionName);
    if (cfg?.operationDelayMs && cfg.operationDelayMs > 0) {
      await new Promise((r) => setTimeout(r, cfg.operationDelayMs));
    }
  }

  private maybeThrow(collectionName: string): void {
    const cfg = this.collections.get(collectionName);
    if (cfg?.operationError) {
      throw cfg.operationError;
    }
  }

  private log(op: string, collection: string): void {
    this.operationLog.push({ op, collection, ts: Date.now() });
  }

  async getCollectionStats(collectionName: string): Promise<CollectionStats> {
    const cfg = this.collections.get(collectionName);
    if (!cfg) {
      throw new Error(`Collection not configured: ${collectionName}`);
    }
    await this.delay(collectionName);
    this.maybeThrow(collectionName);
    return {
      totalVectors: cfg.totalVectors ?? 100_000,
      deletedVectors: cfg.deletedVectors ?? 0,
      segmentCount: cfg.segmentCount ?? 8,
      lastMaintenanceTimestamp: cfg.lastMaintenanceTimestamp,
    };
  }

  async runVacuum(collectionName: string): Promise<void> {
    await this.delay(collectionName);
    this.maybeThrow(collectionName);
    this.log('vacuum', collectionName);

    // Simulate cleanup: clear tombstones
    const cfg = this.collections.get(collectionName);
    if (cfg?.simulateCleanupEffect) {
      cfg.deletedVectors = 0;
      cfg.lastMaintenanceTimestamp = Date.now();
    }
  }

  async compactSegments(collectionName: string): Promise<void> {
    await this.delay(collectionName);
    this.maybeThrow(collectionName);
    this.log('compact_segments', collectionName);

    // Simulate compaction: reduce segment count
    const cfg = this.collections.get(collectionName);
    if (cfg?.simulateCleanupEffect) {
      cfg.segmentCount = Math.max(3, Math.floor((cfg.segmentCount ?? 8) / 3));
    }
  }

  async optimizePayloadIndex(
    collectionName: string,
    fields: string[],
  ): Promise<void> {
    await this.delay(collectionName);
    this.maybeThrow(collectionName);
    this.log('optimize_payload_index', collectionName);

    // Simulate indexing: add fields to indexed set
    const cfg = this.collections.get(collectionName);
    if (cfg?.simulateCleanupEffect && cfg.indexedFields) {
      cfg.indexedFields = [...new Set([...cfg.indexedFields, ...fields])];
    }
  }

  async rebuildIndex(collectionName: string): Promise<void> {
    await this.delay(collectionName);
    this.maybeThrow(collectionName);
    this.log('rebuild', collectionName);

    // Simulate rebuild: clean state
    const cfg = this.collections.get(collectionName);
    if (cfg?.simulateCleanupEffect) {
      cfg.deletedVectors = 0;
      cfg.segmentCount = 4;
      cfg.lastMaintenanceTimestamp = Date.now();
    }
  }

  async getQueryFilterFields(collectionName: string): Promise<string[]> {
    const cfg = this.collections.get(collectionName);
    return cfg?.queryFilterFields ?? [];
  }

  async getIndexedFields(collectionName: string): Promise<string[]> {
    const cfg = this.collections.get(collectionName);
    return cfg?.indexedFields ?? [];
  }

  /** Reset operation log between test runs */
  resetLog(): void {
    this.operationLog = [];
  }
}

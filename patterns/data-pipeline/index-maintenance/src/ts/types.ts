/** Health snapshot of a vector collection's index. */
export interface IndexHealthMetrics {
  collectionName: string;
  totalVectors: number;
  deletedVectors: number;
  /** deletedVectors / totalVectors — primary trigger for vacuum */
  tombstoneRatio: number;
  /** Number of active segments — proxy for fragmentation */
  segmentCount: number;
  /** Average vectors per segment */
  avgSegmentSize: number;
  /** Fraction of filter fields that have payload indexes (0–1) */
  payloadIndexCoverage: number;
  /** Milliseconds since last successful maintenance run */
  lastMaintenanceMs: number;
  collectedAt: Date;
}

/** An operation the planner has decided to execute. */
export type MaintenanceOperation =
  | { type: 'vacuum'; reason: string }
  | { type: 'compact_segments'; reason: string }
  | { type: 'optimize_payload_index'; fields: string[]; reason: string }
  | { type: 'rebuild'; reason: string };

/** Result of a single maintenance run. */
export interface MaintenanceResult {
  collectionName: string;
  operationsExecuted: MaintenanceOperation[];
  durationMs: number;
  metricsBeforeRun: IndexHealthMetrics;
  metricsAfterRun: IndexHealthMetrics;
  success: boolean;
  error?: string;
}

/** Configuration for the maintenance scheduler. */
export interface MaintenanceConfig {
  /**
   * Tombstone ratio that triggers vacuum (0–1).
   * Default 0.15 — tune based on churn rate and recall SLA.
   */
  tombstoneThreshold: number;
  /**
   * Maximum segment count before compaction is triggered.
   * Default 20 — lower if per-query latency is increasing.
   */
  maxSegments: number;
  /**
   * Minimum payload index coverage (0–1) before optimize_payload_index runs.
   * Default 0.80 — unindexed filter fields cause full scans.
   */
  minPayloadIndexCoverage: number;
  /**
   * Minimum milliseconds between maintenance runs.
   * Prevents vacuum loops when churn rate exceeds cleanup speed.
   */
  maintenanceCooldownMs: number;
  /**
   * Hard limit on maintenance run duration. If exceeded, the operation
   * is abandoned to avoid blocking reads indefinitely.
   */
  maxMaintenanceDurationMs: number;
  /**
   * Current request rate per second (injected by traffic gate).
   * Maintenance is deferred when rate exceeds this threshold.
   */
  maxTrafficRateForMaintenance: number;
}

export const DEFAULT_CONFIG: MaintenanceConfig = {
  tombstoneThreshold: 0.15,
  maxSegments: 20,
  minPayloadIndexCoverage: 0.8,
  maintenanceCooldownMs: 3_600_000, // 1 hour
  maxMaintenanceDurationMs: 300_000, // 5 minutes
  maxTrafficRateForMaintenance: 100, // req/s
};

/** Interface that the scheduler uses to interact with the vector store. */
export interface VectorStoreAdapter {
  getCollectionStats(collectionName: string): Promise<CollectionStats>;
  runVacuum(collectionName: string): Promise<void>;
  compactSegments(collectionName: string): Promise<void>;
  optimizePayloadIndex(collectionName: string, fields: string[]): Promise<void>;
  rebuildIndex(collectionName: string): Promise<void>;
  /** Fields currently used in queries (for payload index coverage check) */
  getQueryFilterFields(collectionName: string): Promise<string[]>;
  /** Fields that already have payload indexes */
  getIndexedFields(collectionName: string): Promise<string[]>;
}

/** Raw stats returned by the vector store API. */
export interface CollectionStats {
  totalVectors: number;
  deletedVectors: number;
  segmentCount: number;
  lastMaintenanceTimestamp?: number;
}

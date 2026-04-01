/**
 * Types for the Embedding Refresh pattern.
 *
 * Core design principle: every stored embedding carries its model version as
 * first-class metadata. Without this, zero-downtime model upgrades are impossible
 * — you can't know which documents need re-embedding during a migration.
 */

export interface EmbeddingRefreshConfig {
  /** Model identifier, e.g. "text-embedding-3-large" */
  embeddingModel: string;
  /** Semantic version for migration tracking, e.g. "2" */
  modelVersion: string;
  /**
   * Refresh if last_refreshed_at is older than this many days.
   * Default: 7. Set lower for frequently-updated content, higher for static corpora.
   */
  stalenessThresholdDays: number;
  /**
   * Documents per embedding API call.
   * Default: 100. Tune based on avg document token length and provider batch limits.
   */
  batchSize: number;
  /**
   * Parallel embedding API calls.
   * Default: 4. Scale up only after verifying provider rate limits won't be exhausted.
   */
  maxConcurrentBatches: number;
  /**
   * Document fingerprint algorithm.
   * sha256 is the safe default; md5 is faster but has higher collision probability.
   */
  hashAlgorithm: "md5" | "sha256";
}

export interface DocumentRecord {
  id: string;
  content: string;
  /** SHA-256 (or MD5) of the current content — used to detect changes */
  contentHash: string;
  lastRefreshedAt: Date;
  /** Which model version produced this embedding — critical for migration tracking */
  embeddingModelVersion: string;
  embedding?: number[];
  /** Optional metadata to include in hash computation (catches non-content changes) */
  metadata?: Record<string, unknown>;
}

export interface RefreshResult {
  refreshed: number;
  skipped: number;
  failed: number;
  durationMs: number;
  /**
   * Count of documents per model version — if this shows >1 key, a migration is
   * partially complete or mixed-model contamination has occurred.
   */
  stalenessByModel: Record<string, number>;
}

export interface StalenessReport {
  totalDocuments: number;
  staleCount: number;
  /** Documents whose embeddingModelVersion != the configured modelVersion */
  wrongModelCount: number;
  /** Fraction of corpus on the current model version (0–1) */
  currentModelCoverage: number;
  /** Oldest last_refreshed_at across the corpus, or null if corpus is empty */
  oldestRefreshedAt: Date | null;
  staleDocs: Array<{ id: string; lastRefreshedAt: Date; reason: "time" | "model" | "content-changed" }>;
}

export interface EmbeddingRequest {
  documents: DocumentRecord[];
}

export interface EmbeddingResponse {
  embeddings: Array<{ id: string; embedding: number[]; error?: string }>;
}

export interface EmbeddingProvider {
  embed(request: EmbeddingRequest, modelVersion: string): Promise<EmbeddingResponse>;
}

/** Simple in-memory store interface — swap out for Pinecone, Weaviate, pgvector, etc. */
export interface VectorStore {
  upsert(record: DocumentRecord): Promise<void>;
  upsertBatch(records: DocumentRecord[]): Promise<void>;
  get(id: string): Promise<DocumentRecord | null>;
  list(): Promise<DocumentRecord[]>;
  count(): Promise<number>;
}

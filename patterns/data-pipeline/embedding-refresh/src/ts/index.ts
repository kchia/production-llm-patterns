/**
 * Embedding Refresh pattern — TypeScript implementation.
 *
 * Two distinct refresh strategies:
 *
 * 1. Incremental content refresh: detect changed documents via content hashing,
 *    re-embed only what's changed. Runs frequently (hourly/daily).
 *
 * 2. Model upgrade via shadow index: build a new index in the background while
 *    serving queries from the live index, then swap atomically when coverage
 *    reaches threshold. Never mix model versions in a live index.
 *
 * The critical invariant: every stored embedding carries its model version.
 * Without this metadata, model upgrades require a blind full re-embed.
 */

import { createHash } from "crypto";
import type {
  EmbeddingRefreshConfig,
  DocumentRecord,
  RefreshResult,
  StalenessReport,
  EmbeddingProvider,
  VectorStore,
} from "./types.js";
import { RateLimitError } from "./mock-provider.js";

const DEFAULT_CONFIG: Required<EmbeddingRefreshConfig> = {
  embeddingModel: "text-embedding-3-large",
  modelVersion: "1",
  stalenessThresholdDays: 7,
  batchSize: 100,
  maxConcurrentBatches: 4,
  hashAlgorithm: "sha256",
};

/** Backoff parameters for rate limit retries */
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

export class EmbeddingRefresher {
  private config: Required<EmbeddingRefreshConfig>;
  private provider: EmbeddingProvider;
  private store: VectorStore;

  constructor(
    provider: EmbeddingProvider,
    store: VectorStore,
    config: Partial<EmbeddingRefreshConfig> = {}
  ) {
    this.provider = provider;
    this.store = store;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Compute a content fingerprint.
   *
   * We hash content + (optionally) metadata so that documents that change in
   * metadata-only ways (e.g., author, category) still trigger a refresh.
   * Hashing metadata is opt-in because not all metadata changes affect semantics.
   */
  computeHash(content: string, metadata?: Record<string, unknown>): string {
    const algo = this.config.hashAlgorithm;
    const h = createHash(algo);
    h.update(content);
    if (metadata) {
      // Sort keys for stable hashing regardless of property insertion order
      h.update(JSON.stringify(Object.fromEntries(Object.entries(metadata).sort())));
    }
    return h.digest("hex");
  }

  /**
   * Check whether a document needs refreshing.
   *
   * Three staleness reasons:
   * - "model": stored model version != configured model version (migration needed)
   * - "time": last_refreshed_at is past the staleness threshold
   * - "content-changed": content hash doesn't match stored hash
   */
  isStale(
    doc: DocumentRecord,
    currentContent: string,
    currentMetadata?: Record<string, unknown>
  ): { stale: boolean; reason?: "model" | "time" | "content-changed" } {
    // Model version check first — highest priority
    if (doc.embeddingModelVersion !== this.config.modelVersion) {
      return { stale: true, reason: "model" };
    }

    // Content hash check — catches document edits
    const newHash = this.computeHash(currentContent, currentMetadata);
    if (doc.contentHash !== newHash) {
      return { stale: true, reason: "content-changed" };
    }

    // Time-based staleness — catches silent context drift
    const thresholdMs = this.config.stalenessThresholdDays * 24 * 60 * 60 * 1000;
    const age = Date.now() - doc.lastRefreshedAt.getTime();
    if (age > thresholdMs) {
      return { stale: true, reason: "time" };
    }

    return { stale: false };
  }

  /**
   * Run an incremental refresh cycle.
   *
   * Algorithm:
   * 1. Pull current state from the store
   * 2. Identify stale documents (model mismatch, content change, or age)
   * 3. Batch the stale documents and re-embed with concurrency control
   * 4. Upsert new vectors with updated metadata
   *
   * This is designed to be restartable: if it's killed mid-run, the next run
   * picks up where it left off (only un-refreshed docs remain stale).
   */
  async refresh(
    incomingDocuments: Array<{ id: string; content: string; metadata?: Record<string, unknown> }>
  ): Promise<RefreshResult> {
    const startMs = Date.now();
    let refreshed = 0;
    let skipped = 0;
    let failed = 0;
    const stalenessByModel: Record<string, number> = {};

    // Fetch current state for all incoming doc IDs
    const existingDocs = await this.fetchExistingDocs(incomingDocuments.map((d) => d.id));

    // Identify what needs refreshing
    const toRefresh: DocumentRecord[] = [];

    for (const incoming of incomingDocuments) {
      const existing = existingDocs.get(incoming.id);
      const newHash = this.computeHash(incoming.content, incoming.metadata);

      if (!existing) {
        // New document — needs initial embedding
        toRefresh.push({
          id: incoming.id,
          content: incoming.content,
          contentHash: newHash,
          lastRefreshedAt: new Date(0), // epoch → clearly needs refresh
          embeddingModelVersion: "", // will be set after embedding
          metadata: incoming.metadata,
        });
      } else {
        // Track model distribution for staleness reporting
        const mv = existing.embeddingModelVersion;
        stalenessByModel[mv] = (stalenessByModel[mv] ?? 0) + 1;

        const { stale } = this.isStale(existing, incoming.content, incoming.metadata);
        if (stale) {
          toRefresh.push({
            ...existing,
            content: incoming.content,
            contentHash: newHash,
            metadata: incoming.metadata,
          });
        } else {
          skipped++;
        }
      }
    }

    // Batch and embed with concurrency control
    const batches = chunk(toRefresh, this.config.batchSize);

    for (let i = 0; i < batches.length; i += this.config.maxConcurrentBatches) {
      const concurrentBatches = batches.slice(i, i + this.config.maxConcurrentBatches);

      const results = await Promise.allSettled(
        concurrentBatches.map((batch) => this.embedAndStore(batch))
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          refreshed += result.value.refreshed;
          failed += result.value.failed;
        } else {
          // Whole batch failed — count all docs as failed
          failed += this.config.batchSize;
        }
      }
    }

    // Add current model version docs to staleness tracking
    const currentMv = this.config.modelVersion;
    stalenessByModel[currentMv] = (stalenessByModel[currentMv] ?? 0) + refreshed;

    return {
      refreshed,
      skipped,
      failed,
      durationMs: Date.now() - startMs,
      stalenessByModel,
    };
  }

  /**
   * Compute a staleness report without triggering any refresh.
   * Useful for monitoring and alerting — call on a schedule to get freshness metrics.
   */
  async getStalenessReport(): Promise<StalenessReport> {
    const allDocs = await this.store.list();
    const total = allDocs.length;

    if (total === 0) {
      return {
        totalDocuments: 0,
        staleCount: 0,
        wrongModelCount: 0,
        currentModelCoverage: 1,
        oldestRefreshedAt: null,
        staleDocs: [],
      };
    }

    const thresholdMs = this.config.stalenessThresholdDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    let staleCount = 0;
    let wrongModelCount = 0;
    let oldest: Date | null = null;
    const staleDocs: StalenessReport["staleDocs"] = [];

    for (const doc of allDocs) {
      // Track oldest
      if (!oldest || doc.lastRefreshedAt < oldest) {
        oldest = doc.lastRefreshedAt;
      }

      const wrongModel = doc.embeddingModelVersion !== this.config.modelVersion;
      const tooOld = now - doc.lastRefreshedAt.getTime() > thresholdMs;

      if (wrongModel) {
        wrongModelCount++;
        staleCount++;
        staleDocs.push({ id: doc.id, lastRefreshedAt: doc.lastRefreshedAt, reason: "model" });
      } else if (tooOld) {
        staleCount++;
        staleDocs.push({ id: doc.id, lastRefreshedAt: doc.lastRefreshedAt, reason: "time" });
      }
    }

    const onCurrentModel = allDocs.filter(
      (d) => d.embeddingModelVersion === this.config.modelVersion
    ).length;

    return {
      totalDocuments: total,
      staleCount,
      wrongModelCount,
      currentModelCoverage: onCurrentModel / total,
      oldestRefreshedAt: oldest,
      staleDocs,
    };
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private async fetchExistingDocs(
    ids: string[]
  ): Promise<Map<string, DocumentRecord>> {
    const result = new Map<string, DocumentRecord>();
    // Fetch in parallel — each store implementation handles its own batching
    const fetched = await Promise.all(ids.map((id) => this.store.get(id)));
    for (let i = 0; i < ids.length; i++) {
      const doc = fetched[i];
      if (doc) result.set(ids[i], doc);
    }
    return result;
  }

  private async embedAndStore(
    batch: DocumentRecord[]
  ): Promise<{ refreshed: number; failed: number }> {
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt < MAX_RETRIES) {
      try {
        const response = await this.provider.embed(
          { documents: batch },
          this.config.modelVersion
        );

        const toUpsert: DocumentRecord[] = [];
        let failed = 0;

        for (const result of response.embeddings) {
          if (result.error) {
            failed++;
            continue;
          }
          const original = batch.find((d) => d.id === result.id);
          if (!original) continue;

          toUpsert.push({
            ...original,
            embedding: result.embedding,
            embeddingModelVersion: this.config.modelVersion,
            lastRefreshedAt: new Date(),
          });
        }

        if (toUpsert.length > 0) {
          await this.store.upsertBatch(toUpsert);
        }

        return { refreshed: toUpsert.length, failed };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (err instanceof RateLimitError) {
          // Exponential backoff for rate limits
          const backoffMs = BASE_BACKOFF_MS * Math.pow(2, attempt);
          await sleep(backoffMs);
          attempt++;
        } else {
          // Non-retryable errors (API error, timeout) — fail the batch
          break;
        }
      }
    }

    // All retries exhausted or non-retryable error
    console.error(`Batch embed failed after ${attempt} attempts:`, lastError?.message);
    return { refreshed: 0, failed: batch.length };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Split an array into chunks of at most `size` elements */
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

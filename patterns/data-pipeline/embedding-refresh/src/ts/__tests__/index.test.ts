/**
 * Tests for the Embedding Refresh pattern.
 *
 * Coverage:
 * - Unit: hash computation, staleness detection, batch splitting
 * - Failure mode: mixed model versions, partial refresh, rate limit handling,
 *   shadow index promotion guard, silent staleness accumulation
 * - Integration: end-to-end refresh cycle, model upgrade path
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { EmbeddingRefresher } from "../index.js";
import {
  MockEmbeddingProvider,
  InMemoryVectorStore,
  RateLimitError,
} from "../mock-provider.js";
import type { DocumentRecord, EmbeddingRefreshConfig } from "../types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDoc(
  id: string,
  content: string,
  modelVersion = "1",
  daysOld = 0
): DocumentRecord {
  const refresher = new EmbeddingRefresher(
    new MockEmbeddingProvider(),
    new InMemoryVectorStore()
  );
  const lastRefreshedAt = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  return {
    id,
    content,
    contentHash: refresher.computeHash(content),
    lastRefreshedAt,
    embeddingModelVersion: modelVersion,
    embedding: [0.1, 0.2, 0.3],
  };
}

// ─── Unit Tests ───────────────────────────────────────────────────────────────

describe("computeHash", () => {
  it("returns same hash for same content", () => {
    const refresher = new EmbeddingRefresher(
      new MockEmbeddingProvider(),
      new InMemoryVectorStore()
    );
    expect(refresher.computeHash("hello world")).toBe(
      refresher.computeHash("hello world")
    );
  });

  it("returns different hash for different content", () => {
    const refresher = new EmbeddingRefresher(
      new MockEmbeddingProvider(),
      new InMemoryVectorStore()
    );
    expect(refresher.computeHash("hello")).not.toBe(refresher.computeHash("world"));
  });

  it("includes metadata in hash when provided", () => {
    const refresher = new EmbeddingRefresher(
      new MockEmbeddingProvider(),
      new InMemoryVectorStore()
    );
    const hashWithout = refresher.computeHash("hello");
    const hashWith = refresher.computeHash("hello", { author: "alice" });
    expect(hashWithout).not.toBe(hashWith);
  });

  it("produces stable hash regardless of metadata key insertion order", () => {
    const refresher = new EmbeddingRefresher(
      new MockEmbeddingProvider(),
      new InMemoryVectorStore()
    );
    const hash1 = refresher.computeHash("hello", { a: 1, b: 2 });
    const hash2 = refresher.computeHash("hello", { b: 2, a: 1 });
    expect(hash1).toBe(hash2);
  });

  it("uses md5 when configured", () => {
    const refresher = new EmbeddingRefresher(
      new MockEmbeddingProvider(),
      new InMemoryVectorStore(),
      { hashAlgorithm: "md5" }
    );
    // MD5 produces 32-char hex; SHA256 produces 64-char hex
    expect(refresher.computeHash("hello").length).toBe(32);
  });
});

describe("isStale", () => {
  it("marks fresh doc as not stale", () => {
    const refresher = new EmbeddingRefresher(
      new MockEmbeddingProvider(),
      new InMemoryVectorStore(),
      { modelVersion: "1", stalenessThresholdDays: 7 }
    );
    const doc = makeDoc("a", "content", "1", 0);
    expect(refresher.isStale(doc, "content").stale).toBe(false);
  });

  it("marks doc with wrong model version as stale (reason: model)", () => {
    const refresher = new EmbeddingRefresher(
      new MockEmbeddingProvider(),
      new InMemoryVectorStore(),
      { modelVersion: "2" } // configured for v2
    );
    const doc = makeDoc("a", "content", "1", 0); // embedded with v1
    const result = refresher.isStale(doc, "content");
    expect(result.stale).toBe(true);
    expect(result.reason).toBe("model");
  });

  it("marks doc past staleness threshold as stale (reason: time)", () => {
    const refresher = new EmbeddingRefresher(
      new MockEmbeddingProvider(),
      new InMemoryVectorStore(),
      { modelVersion: "1", stalenessThresholdDays: 7 }
    );
    const doc = makeDoc("a", "content", "1", 10); // 10 days old
    const result = refresher.isStale(doc, "content");
    expect(result.stale).toBe(true);
    expect(result.reason).toBe("time");
  });

  it("marks doc with changed content as stale (reason: content-changed)", () => {
    const refresher = new EmbeddingRefresher(
      new MockEmbeddingProvider(),
      new InMemoryVectorStore(),
      { modelVersion: "1", stalenessThresholdDays: 7 }
    );
    const doc = makeDoc("a", "original content", "1", 0);
    const result = refresher.isStale(doc, "updated content");
    expect(result.stale).toBe(true);
    expect(result.reason).toBe("content-changed");
  });

  it("model version check takes priority over content hash", () => {
    const refresher = new EmbeddingRefresher(
      new MockEmbeddingProvider(),
      new InMemoryVectorStore(),
      { modelVersion: "2" }
    );
    // Doc is on wrong model AND content is unchanged — reason should be "model"
    const doc = makeDoc("a", "content", "1", 0);
    const result = refresher.isStale(doc, "content");
    expect(result.reason).toBe("model");
  });
});

// ─── Integration Tests ────────────────────────────────────────────────────────

describe("EmbeddingRefresher.refresh (integration)", () => {
  let provider: MockEmbeddingProvider;
  let store: InMemoryVectorStore;
  let refresher: EmbeddingRefresher;

  beforeEach(() => {
    provider = new MockEmbeddingProvider({ latencyMs: 0, latencyJitterMs: 0 });
    store = new InMemoryVectorStore();
    refresher = new EmbeddingRefresher(provider, store, {
      modelVersion: "1",
      batchSize: 10,
      maxConcurrentBatches: 2,
    });
  });

  it("embeds new documents on first refresh", async () => {
    const result = await refresher.refresh([
      { id: "doc1", content: "hello world" },
      { id: "doc2", content: "goodbye world" },
    ]);

    expect(result.refreshed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);

    const stored = await store.get("doc1");
    expect(stored?.embedding).toBeDefined();
    expect(stored?.embeddingModelVersion).toBe("1");
  });

  it("skips unchanged documents on second refresh", async () => {
    const docs = [{ id: "doc1", content: "hello world" }];

    await refresher.refresh(docs);
    const result = await refresher.refresh(docs);

    expect(result.refreshed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("re-embeds documents with changed content", async () => {
    await refresher.refresh([{ id: "doc1", content: "original" }]);

    const result = await refresher.refresh([{ id: "doc1", content: "updated content" }]);

    expect(result.refreshed).toBe(1);
    expect(result.skipped).toBe(0);

    const stored = await store.get("doc1");
    expect(stored?.content).toBe("updated content");
  });

  it("stores model version with each embedding", async () => {
    await refresher.refresh([{ id: "doc1", content: "test" }]);
    const stored = await store.get("doc1");
    expect(stored?.embeddingModelVersion).toBe("1");
  });

  it("handles large corpus with batching", async () => {
    const docs = Array.from({ length: 25 }, (_, i) => ({
      id: `doc${i}`,
      content: `content for document ${i}`,
    }));

    const result = await refresher.refresh(docs);

    expect(result.refreshed).toBe(25);
    expect(result.failed).toBe(0);
    expect(await store.count()).toBe(25);
  });
});

// ─── Failure Mode Tests ───────────────────────────────────────────────────────

describe("FM: mixed model versions in live index", () => {
  it("staleness report detects documents on wrong model version", async () => {
    const provider = new MockEmbeddingProvider({ latencyMs: 0, latencyJitterMs: 0 });
    const store = new InMemoryVectorStore();

    // Pre-populate store with v1 embeddings
    await store.upsertBatch([
      makeDoc("doc1", "content 1", "1", 0),
      makeDoc("doc2", "content 2", "1", 0),
    ]);

    // Refresher now configured for v2
    const refresher = new EmbeddingRefresher(provider, store, { modelVersion: "2" });
    const report = await refresher.getStalenessReport();

    expect(report.wrongModelCount).toBe(2);
    expect(report.currentModelCoverage).toBe(0);
    expect(report.staleCount).toBe(2);
  });

  it("refresh upgrades all docs to new model version", async () => {
    const provider = new MockEmbeddingProvider({ latencyMs: 0, latencyJitterMs: 0 });
    const store = new InMemoryVectorStore();

    const docs = [
      { id: "doc1", content: "content 1" },
      { id: "doc2", content: "content 2" },
    ];

    // Seed with v1 embeddings
    const v1Refresher = new EmbeddingRefresher(provider, store, { modelVersion: "1" });
    await v1Refresher.refresh(docs);

    // Now upgrade to v2
    const v2Refresher = new EmbeddingRefresher(provider, store, { modelVersion: "2" });
    const result = await v2Refresher.refresh(docs);

    expect(result.refreshed).toBe(2);
    const report = await v2Refresher.getStalenessReport();
    expect(report.currentModelCoverage).toBe(1.0);
    expect(report.wrongModelCount).toBe(0);
  });
});

describe("FM: rate limit handling with backoff", () => {
  it("retries on rate limit errors and eventually succeeds", async () => {
    let callCount = 0;
    // Custom provider: fails first call with rate limit, succeeds on retry
    const partialProvider: typeof provider = {
      async embed(req, mv) {
        callCount++;
        if (callCount === 1) {
          throw new RateLimitError("Rate limit hit");
        }
        return {
          embeddings: req.documents.map((d) => ({ id: d.id, embedding: [0.1, 0.2] })),
        };
      },
    } as any;

    const store = new InMemoryVectorStore();
    const refresher = new EmbeddingRefresher(partialProvider, store, {
      modelVersion: "1",
      batchSize: 10,
    });

    const result = await refresher.refresh([{ id: "doc1", content: "test" }]);

    expect(result.refreshed).toBe(1);
    expect(result.failed).toBe(0);
    expect(callCount).toBe(2); // 1 fail + 1 retry
  });

  it("marks batch as failed after max retries on persistent rate limit", async () => {
    const alwaysRateLimited: MockEmbeddingProvider = new MockEmbeddingProvider({
      errorRate: 1.0,
      errorType: "rate-limit",
      latencyMs: 0,
      latencyJitterMs: 0,
    });

    const store = new InMemoryVectorStore();
    const refresher = new EmbeddingRefresher(alwaysRateLimited, store, {
      modelVersion: "1",
      batchSize: 10,
    });

    const result = await refresher.refresh([{ id: "doc1", content: "test" }]);

    expect(result.failed).toBe(1);
    expect(result.refreshed).toBe(0);
  }, 30000); // Extended timeout for retry backoffs
});

describe("FM: change detection misses metadata-only changes", () => {
  it("detects change when metadata is included in hash", async () => {
    const provider = new MockEmbeddingProvider({ latencyMs: 0, latencyJitterMs: 0 });
    const store = new InMemoryVectorStore();
    const refresher = new EmbeddingRefresher(provider, store, { modelVersion: "1" });

    await refresher.refresh([
      { id: "doc1", content: "policy text", metadata: { version: "v1" } },
    ]);

    // Same content, different metadata — should detect as stale
    const result = await refresher.refresh([
      { id: "doc1", content: "policy text", metadata: { version: "v2" } },
    ]);

    expect(result.refreshed).toBe(1);
    expect(result.skipped).toBe(0);
  });
});

describe("FM: partial refresh / restartable jobs", () => {
  it("second run only processes docs that weren't refreshed in the first run", async () => {
    let callCount = 0;
    // Provider that fails after 1 call (simulates mid-job kill)
    const flakeyProvider: MockEmbeddingProvider = {
      async embed(req, mv) {
        callCount++;
        if (callCount > 1) throw new Error("Provider unavailable (simulated kill)");
        return {
          embeddings: req.documents.map((d) => ({ id: d.id, embedding: [0.1] })),
        };
      },
    } as any;

    const store = new InMemoryVectorStore();
    const refresher = new EmbeddingRefresher(flakeyProvider, store, {
      modelVersion: "1",
      batchSize: 2, // Process 2 docs per batch
      maxConcurrentBatches: 1,
    });

    // First run: 4 docs, batch size 2 → 2 batches, second batch fails
    const docs = [
      { id: "d1", content: "a" },
      { id: "d2", content: "b" },
      { id: "d3", content: "c" },
      { id: "d4", content: "d" },
    ];

    const firstResult = await refresher.refresh(docs);
    // First batch succeeds (2 docs), second fails (2 docs)
    expect(firstResult.refreshed).toBe(2);
    expect(firstResult.failed).toBe(2);

    // Fix the provider
    const goodProvider = new MockEmbeddingProvider({ latencyMs: 0, latencyJitterMs: 0 });
    const refresher2 = new EmbeddingRefresher(goodProvider, store, { modelVersion: "1", batchSize: 2 });

    // Second run: only failed docs (d3, d4) need refresh; d1, d2 are skipped
    const secondResult = await refresher2.refresh(docs);
    expect(secondResult.refreshed).toBe(2);
    expect(secondResult.skipped).toBe(2);
  });
});

describe("FM: silent staleness accumulation (6-month failure)", () => {
  it("staleness report detects time-based staleness even with unchanged content", async () => {
    const provider = new MockEmbeddingProvider({ latencyMs: 0, latencyJitterMs: 0 });
    const store = new InMemoryVectorStore();

    // Seed store with old documents (30 days past threshold)
    const oldDate = new Date(Date.now() - 37 * 24 * 60 * 60 * 1000);
    await store.upsert({
      id: "doc1",
      content: "policy content — text hasn't changed",
      contentHash: "abc123",
      lastRefreshedAt: oldDate,
      embeddingModelVersion: "1",
      embedding: [0.1, 0.2],
    });

    const refresher = new EmbeddingRefresher(provider, store, {
      modelVersion: "1",
      stalenessThresholdDays: 7,
    });

    const report = await refresher.getStalenessReport();

    // Despite no content change, time-based staleness should be detected
    expect(report.staleCount).toBe(1);
    expect(report.staleDocs[0].reason).toBe("time");
  });

  it("coverage metric exposes mixed model versions silently accumulating", async () => {
    const store = new InMemoryVectorStore();

    // 3 docs on v1, 1 doc on v2 — simulates partial silent migration
    await store.upsertBatch([
      makeDoc("d1", "a", "1"),
      makeDoc("d2", "b", "1"),
      makeDoc("d3", "c", "1"),
      makeDoc("d4", "d", "2"),
    ]);

    const refresher = new EmbeddingRefresher(
      new MockEmbeddingProvider(),
      store,
      { modelVersion: "2" }
    );

    const report = await refresher.getStalenessReport();

    expect(report.currentModelCoverage).toBeCloseTo(0.25, 2);
    expect(report.wrongModelCount).toBe(3);
  });
});

describe("FM: shadow index promotion guard", () => {
  it("coverage below threshold is detectable before promotion", async () => {
    const store = new InMemoryVectorStore();

    // Simulate partial migration: 80% on v2, 20% still on v1
    const docs = Array.from({ length: 10 }, (_, i) => ({
      id: `doc${i}`,
      content: `content ${i}`,
      contentHash: `hash${i}`,
      lastRefreshedAt: new Date(),
      embeddingModelVersion: i < 8 ? "2" : "1", // 8 of 10 on v2
      embedding: [0.1],
    }));

    await store.upsertBatch(docs);

    const refresher = new EmbeddingRefresher(
      new MockEmbeddingProvider(),
      store,
      { modelVersion: "2" }
    );

    const report = await refresher.getStalenessReport();

    // Should detect coverage is not 100% — don't promote yet
    expect(report.currentModelCoverage).toBeLessThan(1.0);
    expect(report.currentModelCoverage).toBeCloseTo(0.8, 1);
    expect(report.wrongModelCount).toBe(2);
  });
});

describe("getStalenessReport", () => {
  it("returns safe defaults for empty corpus", async () => {
    const refresher = new EmbeddingRefresher(
      new MockEmbeddingProvider(),
      new InMemoryVectorStore()
    );
    const report = await refresher.getStalenessReport();
    expect(report.totalDocuments).toBe(0);
    expect(report.currentModelCoverage).toBe(1); // vacuously 100% fresh
    expect(report.oldestRefreshedAt).toBeNull();
  });

  it("reports correct coverage after full refresh", async () => {
    const provider = new MockEmbeddingProvider({ latencyMs: 0, latencyJitterMs: 0 });
    const store = new InMemoryVectorStore();
    const refresher = new EmbeddingRefresher(provider, store, { modelVersion: "1" });

    await refresher.refresh([
      { id: "d1", content: "a" },
      { id: "d2", content: "b" },
    ]);

    const report = await refresher.getStalenessReport();
    expect(report.currentModelCoverage).toBe(1.0);
    expect(report.wrongModelCount).toBe(0);
    expect(report.staleCount).toBe(0);
  });
});

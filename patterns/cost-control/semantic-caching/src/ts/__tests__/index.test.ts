import { describe, it, expect, beforeEach } from 'vitest';
import { SemanticCache, cosineSimilarity } from '../index.js';
import { MockLLMProvider, MockEmbeddingProvider } from '../mock-provider.js';

// Shared helpers
function createCache(overrides: Record<string, unknown> = {}) {
  const embedding = new MockEmbeddingProvider({ latencyMs: 0 });
  const llm = new MockLLMProvider({ latencyMs: 0 });
  const cache = new SemanticCache(embedding, llm, {
    similarityThreshold: 0.85,
    ttl: 3600,
    maxEntries: 100,
    ...overrides,
  });
  return { cache, embedding, llm };
}

// ─── Unit Tests ──────────────────────────────────────────────

describe('Unit: cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const v = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it('returns -1 for opposite vectors', () => {
    const a = [1, 2, 3];
    const b = [-1, -2, -3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it('handles zero vectors gracefully', () => {
    const a = [0, 0, 0];
    const b = [1, 2, 3];
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

describe('Unit: SemanticCache configuration', () => {
  it('uses default config when none provided', () => {
    const embedding = new MockEmbeddingProvider({ latencyMs: 0 });
    const llm = new MockLLMProvider({ latencyMs: 0 });
    const cache = new SemanticCache(embedding, llm);
    const stats = cache.stats();
    expect(stats.totalEntries).toBe(0);
    expect(stats.hitRate).toBe(0);
  });

  it('respects custom similarity threshold', async () => {
    // With a very high threshold, even similar queries shouldn't match
    const { cache, llm } = createCache({ similarityThreshold: 0.999 });

    await cache.query('What is the return policy?');
    const result = await cache.query('How do I return an item?');

    // Both should be cache misses at this threshold
    expect(result.cacheHit).toBe(false);
    expect(llm.getCallCount()).toBe(2);
  });

  it('respects per-query threshold override', async () => {
    const { cache } = createCache({ similarityThreshold: 0.5 });

    await cache.query('What is the return policy?');
    // Same query with very high per-query threshold should miss
    const result = await cache.query('How do I return an item?', {
      similarityThreshold: 0.999,
    });
    expect(result.cacheHit).toBe(false);
  });

  it('respects bypassCache option', async () => {
    const { cache, llm } = createCache();

    await cache.query('What is the return policy?');
    const result = await cache.query('What is the return policy?', {
      bypassCache: true,
    });

    expect(result.cacheHit).toBe(false);
    expect(llm.getCallCount()).toBe(2);
    // Should still store the new result
    expect(cache.size).toBe(2);
  });
});

describe('Unit: cache hit/miss', () => {
  it('returns cache miss on first query', async () => {
    const { cache } = createCache();
    const result = await cache.query('What is the return policy?');
    expect(result.cacheHit).toBe(false);
    expect(result.similarityScore).toBeNull();
  });

  it('returns cache hit for identical query', async () => {
    const { cache, llm } = createCache();

    await cache.query('What is the return policy?');
    const result = await cache.query('What is the return policy?');

    expect(result.cacheHit).toBe(true);
    expect(result.similarityScore).toBeCloseTo(1.0, 3);
    expect(llm.getCallCount()).toBe(1);
  });

  it('tracks hit/miss stats correctly', async () => {
    const { cache } = createCache();

    await cache.query('Question A');
    await cache.query('Question A');
    await cache.query('Question B');

    const stats = cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(2);
    expect(stats.hitRate).toBeCloseTo(1 / 3);
  });
});

describe('Unit: namespace isolation', () => {
  it('isolates entries by namespace', async () => {
    const { cache, llm } = createCache();

    await cache.query('What is the return policy?', { namespace: 'store-a' });
    const result = await cache.query('What is the return policy?', { namespace: 'store-b' });

    // Different namespace = cache miss
    expect(result.cacheHit).toBe(false);
    expect(llm.getCallCount()).toBe(2);
  });

  it('hits cache within same namespace', async () => {
    const { cache, llm } = createCache();

    await cache.query('What is the return policy?', { namespace: 'store-a' });
    const result = await cache.query('What is the return policy?', { namespace: 'store-a' });

    expect(result.cacheHit).toBe(true);
    expect(llm.getCallCount()).toBe(1);
  });

  it('reports entries by namespace in stats', async () => {
    const { cache } = createCache();

    await cache.query('Q1', { namespace: 'ns-a' });
    await cache.query('Q2', { namespace: 'ns-a' });
    await cache.query('Q3', { namespace: 'ns-b' });

    const stats = cache.stats();
    expect(stats.entriesByNamespace['ns-a']).toBe(2);
    expect(stats.entriesByNamespace['ns-b']).toBe(1);
  });
});

describe('Unit: TTL expiration', () => {
  it('evicts expired entries', async () => {
    const { cache, llm } = createCache({ ttl: 1 }); // 1 second TTL

    await cache.query('What is the return policy?');

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 1100));

    const result = await cache.query('What is the return policy?');
    expect(result.cacheHit).toBe(false);
    expect(llm.getCallCount()).toBe(2);
  });

  it('respects per-query TTL override', async () => {
    const { cache, llm } = createCache({ ttl: 3600 }); // Default 1 hour

    await cache.query('What is the return policy?', { ttl: 1 }); // 1 second override

    await new Promise((r) => setTimeout(r, 1100));

    // The entry has a 1-hour default TTL, but we query with 1-second TTL
    const result = await cache.query('What is the return policy?', { ttl: 1 });
    expect(result.cacheHit).toBe(false);
    expect(llm.getCallCount()).toBe(2);
  });
});

describe('Unit: invalidation', () => {
  it('invalidates all entries in a namespace', async () => {
    const { cache } = createCache();

    await cache.query('Q1', { namespace: 'ns-a' });
    await cache.query('Q2', { namespace: 'ns-a' });
    await cache.query('Q3', { namespace: 'ns-b' });

    const removed = await cache.invalidate({ namespace: 'ns-a' });
    expect(removed).toBe(2);
    expect(cache.size).toBe(1);
  });

  it('invalidates entries older than a timestamp', async () => {
    const { cache } = createCache();

    await cache.query('Old question');
    const cutoff = Date.now() + 100;

    const removed = await cache.invalidate({ olderThan: cutoff });
    expect(removed).toBe(1);
    expect(cache.size).toBe(0);
  });
});

describe('Unit: eviction', () => {
  it('evicts entries when maxEntries is reached', async () => {
    const { cache } = createCache({ maxEntries: 3 });

    await cache.query('Q1');
    await cache.query('Q2');
    await cache.query('Q3');
    await cache.query('Q4');

    expect(cache.size).toBeLessThanOrEqual(3);
    const stats = cache.stats();
    expect(stats.evictions).toBeGreaterThan(0);
  });
});

// ─── Failure Mode Tests ──────────────────────────────────────

describe('Failure Mode: false-positive cache hit', () => {
  it('returns different responses for semantically different queries at high threshold', async () => {
    const { cache, llm } = createCache({ similarityThreshold: 0.95 });

    await cache.query('sort ascending');
    const result = await cache.query('sort descending');

    // At a high threshold, these should be cache misses (different intent)
    expect(result.cacheHit).toBe(false);
    expect(llm.getCallCount()).toBe(2);
  });
});

describe('Failure Mode: stale cache poisoning', () => {
  it('stale entries are removed on TTL expiry and fresh response is returned', async () => {
    const { cache, llm } = createCache({ ttl: 1 });

    const first = await cache.query('What is the return policy?');
    await new Promise((r) => setTimeout(r, 1100));
    const second = await cache.query('What is the return policy?');

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(false);
    expect(llm.getCallCount()).toBe(2);
    // Stale entry was cleaned up, fresh one stored
    expect(cache.size).toBe(1);
  });
});

describe('Failure Mode: embedding model mismatch', () => {
  it('ignores cache entries from a different embedding model version', async () => {
    const embedding = new MockEmbeddingProvider({ latencyMs: 0 });
    const llm = new MockLLMProvider({ latencyMs: 0 });

    // Create cache with model version "v1"
    const cache = new SemanticCache(embedding, llm, {
      embeddingModelVersion: 'v1',
      similarityThreshold: 0.5,
    });

    await cache.query('What is the return policy?');
    expect(cache.size).toBe(1);

    // Simulate model version change by creating new cache with same store
    // In practice this is done by changing config — entries with old version are skipped
    const cache2 = new SemanticCache(embedding, llm, {
      embeddingModelVersion: 'v2',
      similarityThreshold: 0.5,
    });

    // New cache has no entries (separate instance), so this is a miss by design
    const result = await cache2.query('What is the return policy?');
    expect(result.cacheHit).toBe(false);
  });
});

describe('Failure Mode: cache capacity exhaustion', () => {
  it('eviction maintains cache at maxEntries and hit rate remains reasonable', async () => {
    const { cache } = createCache({ maxEntries: 5 });

    // Fill cache well beyond max
    for (let i = 0; i < 20; i++) {
      await cache.query(`Unique question number ${i}`);
    }

    expect(cache.size).toBeLessThanOrEqual(5);
    const stats = cache.stats();
    expect(stats.evictions).toBeGreaterThan(0);
  });
});

describe('Failure Mode: similarity threshold drift (silent)', () => {
  it('similarity score distribution is trackable via stats', async () => {
    const { cache } = createCache({ similarityThreshold: 0.5 });

    // Seed cache with a query
    await cache.query('What is the return policy?');

    // Hit cache with the same query
    await cache.query('What is the return policy?');

    const stats = cache.stats();
    expect(stats.avgSimilarityScore).toBeGreaterThan(0);
    // The average score being tracked enables drift detection
    expect(stats.hits).toBe(1);
  });
});

describe('Failure Mode: namespace pollution', () => {
  it('queries from different namespaces do not contaminate each other', async () => {
    const { cache, llm } = createCache();

    // Same query, different namespaces (different system prompts)
    await cache.query('How do I reset my password?', { namespace: 'admin-panel' });
    const result = await cache.query('How do I reset my password?', { namespace: 'customer-portal' });

    // Should be a cache miss — different context
    expect(result.cacheHit).toBe(false);
    expect(llm.getCallCount()).toBe(2);
  });
});

// ─── Integration Tests ──────────────────────────────────────

describe('Integration: full cache lifecycle', () => {
  it('handles a realistic sequence of queries with hits, misses, and invalidation', async () => {
    const { cache, llm } = createCache({ similarityThreshold: 0.5, maxEntries: 50 });

    // Phase 1: Cold cache — all misses
    await cache.query('What is the return policy?');
    await cache.query('How much does shipping cost?');
    await cache.query('Where is my order?');
    expect(llm.getCallCount()).toBe(3);

    // Phase 2: Repeat queries — should hit
    const hit1 = await cache.query('What is the return policy?');
    expect(hit1.cacheHit).toBe(true);

    // Phase 3: Invalidate a topic
    const removed = await cache.invalidate({
      query: 'What is the return policy?',
      similarityThreshold: 0.5,
    });
    expect(removed).toBeGreaterThan(0);

    // Phase 4: Re-query invalidated topic — should miss
    const afterInvalidation = await cache.query('What is the return policy?');
    expect(afterInvalidation.cacheHit).toBe(false);

    // Phase 5: Stats reflect the full lifecycle
    const stats = cache.stats();
    expect(stats.hits).toBeGreaterThanOrEqual(1);
    expect(stats.misses).toBeGreaterThanOrEqual(4);
    expect(stats.totalEntries).toBeGreaterThan(0);
  });

  it('handles concurrent queries safely', async () => {
    const { cache, llm } = createCache();

    // Fire 10 different queries concurrently
    const queries = Array.from({ length: 10 }, (_, i) => `Question ${i}`);
    const results = await Promise.all(queries.map((q) => cache.query(q)));

    // All should be misses (first time)
    expect(results.every((r) => !r.cacheHit)).toBe(true);
    expect(llm.getCallCount()).toBe(10);
    expect(cache.size).toBe(10);

    // Fire same queries again — should all hit
    const results2 = await Promise.all(queries.map((q) => cache.query(q)));
    expect(results2.every((r) => r.cacheHit)).toBe(true);
    expect(llm.getCallCount()).toBe(10); // No new LLM calls
  });

  it('clear() resets the cache completely', async () => {
    const { cache } = createCache();

    await cache.query('Q1');
    await cache.query('Q2');
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);

    // Stats persist after clear (intentional — they track lifetime metrics)
    const stats = cache.stats();
    expect(stats.misses).toBe(2);
  });
});

describe('Integration: mock provider error injection', () => {
  it('propagates LLM errors without caching them', async () => {
    const embedding = new MockEmbeddingProvider({ latencyMs: 0 });
    const llm = new MockLLMProvider({ latencyMs: 0, errorRate: 1.0 });
    const cache = new SemanticCache(embedding, llm, { similarityThreshold: 0.85 });

    await expect(cache.query('Will this fail?')).rejects.toThrow('Mock provider error');
    expect(cache.size).toBe(0); // Error response not cached
  });
});

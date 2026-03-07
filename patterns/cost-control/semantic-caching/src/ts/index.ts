/**
 * Semantic Caching — Cache LLM responses by meaning, not string identity.
 *
 * Wraps any LLM provider. On each request, embeds the query, searches the
 * in-process vector store for a match above the similarity threshold, and
 * either returns the cached response or calls through to the provider.
 */

import type {
  CacheEntry,
  CacheResult,
  CacheStats,
  EmbeddingProvider,
  InvalidationFilter,
  LLMProvider,
  QueryOptions,
  SemanticCacheConfig,
} from './types.js';
import { DEFAULT_CONFIG } from './types.js';

export class SemanticCache {
  private entries: Map<string, CacheEntry> = new Map();
  private config: SemanticCacheConfig;
  private embeddingProvider: EmbeddingProvider;
  private llmProvider: LLMProvider;

  // Stats counters
  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;
  private similarityScoreSum = 0;
  private similarityScoreCount = 0;

  constructor(
    embeddingProvider: EmbeddingProvider,
    llmProvider: LLMProvider,
    config: Partial<SemanticCacheConfig> = {},
  ) {
    this.embeddingProvider = embeddingProvider;
    this.llmProvider = llmProvider;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async query(input: string, options?: QueryOptions): Promise<CacheResult> {
    const start = performance.now();
    const namespace = options?.namespace ?? this.config.namespace;
    const threshold = options?.similarityThreshold ?? this.config.similarityThreshold;
    const ttl = options?.ttl ?? this.config.ttl;
    const bypass = options?.bypassCache ?? false;

    // Embed the incoming query
    const embedding = await this.embeddingProvider.embed(input);

    if (!bypass) {
      // Search for a matching cache entry
      const match = this.findBestMatch(embedding, namespace, threshold);

      if (match) {
        // Check TTL
        const age = (Date.now() - match.entry.createdAt) / 1000;
        if (age <= ttl) {
          match.entry.lastHitAt = Date.now();
          match.entry.hitCount++;
          this.hitCount++;
          this.similarityScoreSum += match.score;
          this.similarityScoreCount++;

          return {
            response: match.entry.response,
            cacheHit: true,
            similarityScore: match.score,
            latencyMs: performance.now() - start,
          };
        }
        // TTL expired — remove stale entry
        this.entries.delete(match.entry.id);
      }
    }

    // Cache miss — call through to LLM
    this.missCount++;
    const response = await this.llmProvider.complete(input);

    // Store the new entry
    const entry: CacheEntry = {
      id: generateId(),
      query: input,
      embedding,
      response,
      namespace,
      createdAt: Date.now(),
      lastHitAt: Date.now(),
      hitCount: 0,
      embeddingModelVersion: this.config.embeddingModelVersion,
    };

    this.evictIfNeeded();
    this.entries.set(entry.id, entry);

    return {
      response,
      cacheHit: false,
      similarityScore: null,
      latencyMs: performance.now() - start,
    };
  }

  async invalidate(filter: InvalidationFilter): Promise<number> {
    let removed = 0;
    const toRemove: string[] = [];

    // Query-based invalidation: remove entries similar to the provided query
    let filterEmbedding: number[] | null = null;
    if (filter.query) {
      filterEmbedding = await this.embeddingProvider.embed(filter.query);
    }

    for (const [id, entry] of this.entries) {
      let shouldRemove = false;

      if (filter.namespace && entry.namespace !== filter.namespace) {
        continue; // Only invalidate within the specified namespace
      }

      if (filter.olderThan && entry.createdAt < filter.olderThan) {
        shouldRemove = true;
      }

      if (filterEmbedding) {
        const score = cosineSimilarity(filterEmbedding, entry.embedding);
        const threshold = filter.similarityThreshold ?? this.config.similarityThreshold;
        if (score >= threshold) {
          shouldRemove = true;
        }
      }

      // If no specific filters, remove everything in the namespace
      if (!filter.olderThan && !filter.query) {
        shouldRemove = true;
      }

      if (shouldRemove) {
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      this.entries.delete(id);
      removed++;
    }

    return removed;
  }

  stats(): CacheStats {
    const total = this.hitCount + this.missCount;
    const entriesByNamespace: Record<string, number> = {};

    for (const entry of this.entries.values()) {
      entriesByNamespace[entry.namespace] = (entriesByNamespace[entry.namespace] ?? 0) + 1;
    }

    return {
      totalEntries: this.entries.size,
      hits: this.hitCount,
      misses: this.missCount,
      hitRate: total > 0 ? this.hitCount / total : 0,
      avgSimilarityScore:
        this.similarityScoreCount > 0
          ? this.similarityScoreSum / this.similarityScoreCount
          : 0,
      evictions: this.evictionCount,
      entriesByNamespace,
    };
  }

  /**
   * Reset all stats counters (useful for benchmark warm-up).
   */
  resetStats(): void {
    this.hitCount = 0;
    this.missCount = 0;
    this.evictionCount = 0;
    this.similarityScoreSum = 0;
    this.similarityScoreCount = 0;
  }

  /**
   * Clear all cache entries.
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Current number of entries (for testing/monitoring).
   */
  get size(): number {
    return this.entries.size;
  }

  private findBestMatch(
    embedding: number[],
    namespace: string,
    threshold: number,
  ): { entry: CacheEntry; score: number } | null {
    let bestScore = -1;
    let bestEntry: CacheEntry | null = null;

    for (const entry of this.entries.values()) {
      if (entry.namespace !== namespace) continue;
      if (entry.embeddingModelVersion !== this.config.embeddingModelVersion) continue;

      const score = cosineSimilarity(embedding, entry.embedding);
      if (score >= threshold && score > bestScore) {
        bestScore = score;
        bestEntry = entry;
      }
    }

    return bestEntry ? { entry: bestEntry, score: bestScore } : null;
  }

  private evictIfNeeded(): void {
    while (this.entries.size >= this.config.maxEntries) {
      const victim = this.selectEvictionVictim();
      if (victim) {
        this.entries.delete(victim);
        this.evictionCount++;
      } else {
        break;
      }
    }
  }

  /**
   * Selects which entry to evict. lru-score weights last-hit time by
   * hit count so frequently-accessed entries survive longer than pure LRU.
   */
  private selectEvictionVictim(): string | null {
    let worstId: string | null = null;
    let worstScore = Infinity;

    for (const [id, entry] of this.entries) {
      let score: number;

      if (this.config.evictionPolicy === 'lru-score') {
        // Lower score = more evictable.
        // Recency (lastHitAt) weighted by frequency (hitCount).
        score = entry.lastHitAt * (1 + Math.log2(entry.hitCount + 1));
      } else {
        score = entry.lastHitAt;
      }

      if (score < worstScore) {
        worstScore = score;
        worstId = id;
      }
    }

    return worstId;
  }
}

/**
 * Cosine similarity between two vectors. Returns value in [-1, 1].
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

let idCounter = 0;
function generateId(): string {
  return `cache-${Date.now()}-${idCounter++}`;
}

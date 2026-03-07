/**
 * Semantic Caching — Type definitions
 */

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  readonly dimensions: number;
}

export interface LLMProvider {
  complete(prompt: string): Promise<LLMResponse>;
}

export interface LLMResponse {
  text: string;
  tokenUsage: {
    input: number;
    output: number;
  };
  latencyMs: number;
}

export interface CacheEntry {
  id: string;
  query: string;
  embedding: number[];
  response: LLMResponse;
  namespace: string;
  createdAt: number;
  lastHitAt: number;
  hitCount: number;
  embeddingModelVersion: string;
}

export interface QueryOptions {
  similarityThreshold?: number;
  ttl?: number;
  bypassCache?: boolean;
  namespace?: string;
}

export interface CacheResult {
  response: LLMResponse;
  cacheHit: boolean;
  similarityScore: number | null;
  latencyMs: number;
}

export interface InvalidationFilter {
  namespace?: string;
  olderThan?: number; // timestamp
  query?: string; // invalidate entries similar to this query
  similarityThreshold?: number; // threshold for query-based invalidation
}

export interface CacheStats {
  totalEntries: number;
  hits: number;
  misses: number;
  hitRate: number;
  avgSimilarityScore: number;
  evictions: number;
  entriesByNamespace: Record<string, number>;
}

export interface SemanticCacheConfig {
  similarityThreshold: number;
  ttl: number;
  maxEntries: number;
  evictionPolicy: 'lru' | 'lru-score';
  namespace: string;
  embeddingModelVersion: string;
}

export const DEFAULT_CONFIG: SemanticCacheConfig = {
  similarityThreshold: 0.85,
  ttl: 3600,
  maxEntries: 10000,
  evictionPolicy: 'lru-score',
  namespace: 'default',
  embeddingModelVersion: 'mock-v1',
};

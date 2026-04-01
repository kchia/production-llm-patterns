/**
 * Mock embedding provider for testing and benchmarks.
 *
 * Simulates realistic LLM embedding behavior:
 * - Configurable latency (p50/p99 with jitter)
 * - Configurable error injection (rate + types)
 * - Deterministic embeddings for reproducible tests (seeded by content hash)
 * - Rate limit simulation (429 with Retry-After semantics)
 */

import { createHash } from "crypto";
import type {
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResponse,
  VectorStore,
  DocumentRecord,
} from "./types.js";

export interface MockProviderConfig {
  /** Average latency per batch in ms. Default: 50 */
  latencyMs: number;
  /** Latency jitter ± this many ms. Default: 20 */
  latencyJitterMs: number;
  /** Fraction of requests that fail (0–1). Default: 0 */
  errorRate: number;
  /**
   * Type of error to inject.
   * - "rate-limit": simulates 429 / provider rate limiting
   * - "timeout": simulates request timeout
   * - "api-error": simulates generic 500 from provider
   */
  errorType: "rate-limit" | "timeout" | "api-error";
  /** Embedding dimensions. Default: 8 (tiny, for fast tests) */
  dimensions: number;
}

const DEFAULT_CONFIG: MockProviderConfig = {
  latencyMs: 50,
  latencyJitterMs: 20,
  errorRate: 0,
  errorType: "api-error",
  dimensions: 8,
};

export class MockEmbeddingProvider implements EmbeddingProvider {
  private config: MockProviderConfig;
  private callCount = 0;

  constructor(config: Partial<MockProviderConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async embed(request: EmbeddingRequest, _modelVersion: string): Promise<EmbeddingResponse> {
    this.callCount++;

    // Simulate latency with jitter
    const jitter = (Math.random() - 0.5) * 2 * this.config.latencyJitterMs;
    const delay = Math.max(0, this.config.latencyMs + jitter);
    await sleep(delay);

    // Inject errors at the configured rate
    if (Math.random() < this.config.errorRate) {
      if (this.config.errorType === "rate-limit") {
        throw new RateLimitError("Mock provider: rate limit exceeded (429)");
      } else if (this.config.errorType === "timeout") {
        throw new TimeoutError("Mock provider: request timed out");
      } else {
        throw new ApiError("Mock provider: internal server error (500)");
      }
    }

    // Generate deterministic embeddings seeded by content — reproducible across runs
    const embeddings = request.documents.map((doc) => ({
      id: doc.id,
      embedding: deterministicEmbedding(doc.contentHash, this.config.dimensions),
    }));

    return { embeddings };
  }

  get totalCalls(): number {
    return this.callCount;
  }

  reset(): void {
    this.callCount = 0;
  }
}

/**
 * In-memory vector store for tests and benchmarks.
 * Not thread-safe — single-process only.
 */
export class InMemoryVectorStore implements VectorStore {
  private store = new Map<string, DocumentRecord>();

  async upsert(record: DocumentRecord): Promise<void> {
    this.store.set(record.id, { ...record });
  }

  async upsertBatch(records: DocumentRecord[]): Promise<void> {
    for (const record of records) {
      this.store.set(record.id, { ...record });
    }
  }

  async get(id: string): Promise<DocumentRecord | null> {
    return this.store.get(id) ?? null;
  }

  async list(): Promise<DocumentRecord[]> {
    return Array.from(this.store.values());
  }

  async count(): Promise<number> {
    return this.store.size;
  }

  /** Expose internal store for assertions in tests */
  getAll(): Map<string, DocumentRecord> {
    return this.store;
  }

  clear(): void {
    this.store.clear();
  }
}

// --- Error classes ---

export class RateLimitError extends Error {
  readonly code = "RATE_LIMIT";
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class TimeoutError extends Error {
  readonly code = "TIMEOUT";
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export class ApiError extends Error {
  readonly code = "API_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "ApiError";
  }
}

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate a deterministic embedding from a content hash.
 * Uses the hash bytes as a seed for a simple LCG, producing consistent
 * float vectors for the same content across test runs.
 */
function deterministicEmbedding(contentHash: string, dimensions: number): number[] {
  // Use the first 8 hex chars as a numeric seed
  const seed = parseInt(contentHash.slice(0, 8), 16);
  const embedding: number[] = [];

  let state = seed;
  for (let i = 0; i < dimensions; i++) {
    // LCG: same constants as Java's Random for predictability
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    // Map to [-1, 1]
    embedding.push((state / 0xffffffff) * 2 - 1);
  }

  // L2-normalize so cosine similarity is meaningful
  const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
  return embedding.map((v) => v / (magnitude || 1));
}

/** Convenience: create a sha256 hash of a string */
export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Convenience: create an md5 hash of a string */
export function md5(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

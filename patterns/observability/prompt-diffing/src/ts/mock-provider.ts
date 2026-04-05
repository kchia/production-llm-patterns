import { PromptRegistry, PromptVersion } from './types.js';

/**
 * In-memory prompt registry for testing and benchmarks.
 * Supports configurable latency and error injection to exercise failure paths.
 */
export class MockPromptRegistry implements PromptRegistry {
  private versions = new Map<string, PromptVersion>();
  // maps promptName -> ordered list of version IDs (oldest first)
  private nameIndex = new Map<string, string[]>();

  private latencyMs: number;
  private errorRate: number; // 0–1, probability of a fetch error

  constructor(config: { latencyMs?: number; errorRate?: number } = {}) {
    this.latencyMs = config.latencyMs ?? 0;
    this.errorRate = config.errorRate ?? 0;
  }

  /** Seed a version directly. Used by tests. */
  seed(version: PromptVersion): void {
    this.versions.set(version.id, version);
    const ids = this.nameIndex.get(version.name) ?? [];
    ids.push(version.id);
    this.nameIndex.set(version.name, ids);
  }

  async get(versionId: string): Promise<PromptVersion | null> {
    await this.simulateLatency();
    this.maybeThrow('get');
    return this.versions.get(versionId) ?? null;
  }

  async getLatest(promptName: string): Promise<PromptVersion | null> {
    await this.simulateLatency();
    this.maybeThrow('getLatest');
    const ids = this.nameIndex.get(promptName);
    if (!ids || ids.length === 0) return null;
    return this.versions.get(ids[ids.length - 1]) ?? null;
  }

  async getPrevious(versionId: string): Promise<PromptVersion | null> {
    await this.simulateLatency();
    this.maybeThrow('getPrevious');
    const version = this.versions.get(versionId);
    if (!version) return null;
    const ids = this.nameIndex.get(version.name) ?? [];
    const idx = ids.indexOf(versionId);
    if (idx <= 0) return null; // already the oldest
    return this.versions.get(ids[idx - 1]) ?? null;
  }

  /** Replace with zero latency for specific test steps */
  setLatency(ms: number): void {
    this.latencyMs = ms;
  }

  /** Replace error rate mid-test */
  setErrorRate(rate: number): void {
    this.errorRate = rate;
  }

  private async simulateLatency(): Promise<void> {
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }
  }

  private maybeThrow(operation: string): void {
    if (Math.random() < this.errorRate) {
      throw new Error(`MockPromptRegistry: simulated error on ${operation}`);
    }
  }
}

/**
 * Mock embedding provider that returns deterministic vectors based on text content.
 * The cosine distance between two texts is proportional to how many words differ,
 * making it suitable for threshold-based severity testing.
 */
export class MockEmbeddingProvider {
  private latencyMs: number;

  constructor(config: { latencyMs?: number } = {}) {
    this.latencyMs = config.latencyMs ?? 0;
  }

  async embed(text: string): Promise<number[]> {
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }
    // Deterministic 64-dim vector: TF-like bag-of-words over character trigrams
    const vec = new Array(64).fill(0);
    const words = text.toLowerCase().split(/\s+/);
    for (const word of words) {
      for (let i = 0; i < word.length - 2; i++) {
        const trigram = word.slice(i, i + 3);
        // Map to dimension via simple hash
        let h = 0;
        for (let j = 0; j < trigram.length; j++) {
          h = (h * 31 + trigram.charCodeAt(j)) & 0xffffffff;
        }
        vec[Math.abs(h) % 64] += 1;
      }
    }
    return normalize(vec);
  }
}

function normalize(vec: number[]): number[] {
  const magnitude = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (magnitude === 0) return vec;
  return vec.map((v) => v / magnitude);
}

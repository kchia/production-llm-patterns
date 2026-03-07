/**
 * Mock LLM and Embedding providers for testing and benchmarks.
 *
 * The mock embedding provider generates deterministic vectors from text,
 * designed so that semantically "similar" test strings (sharing word stems)
 * produce vectors with high cosine similarity.
 */

import type { EmbeddingProvider, LLMProvider, LLMResponse } from './types.js';

export interface MockLLMConfig {
  latencyMs: number;
  outputTokens: number;
  inputTokenMultiplier: number; // tokens per character estimate
  errorRate: number; // 0-1, probability of throwing
  errorMessage: string;
}

const DEFAULT_LLM_CONFIG: MockLLMConfig = {
  latencyMs: 200,
  outputTokens: 150,
  inputTokenMultiplier: 0.25,
  errorRate: 0,
  errorMessage: 'Mock provider error',
};

export class MockLLMProvider implements LLMProvider {
  private config: MockLLMConfig;
  private callCount = 0;

  constructor(config: Partial<MockLLMConfig> = {}) {
    this.config = { ...DEFAULT_LLM_CONFIG, ...config };
  }

  async complete(prompt: string): Promise<LLMResponse> {
    this.callCount++;

    if (this.config.errorRate > 0 && Math.random() < this.config.errorRate) {
      throw new Error(this.config.errorMessage);
    }

    const start = performance.now();
    await sleep(this.config.latencyMs);
    const elapsed = performance.now() - start;

    return {
      text: `Mock response for: ${prompt.slice(0, 80)}`,
      tokenUsage: {
        input: Math.ceil(prompt.length * this.config.inputTokenMultiplier),
        output: this.config.outputTokens,
      },
      latencyMs: elapsed,
    };
  }

  getCallCount(): number {
    return this.callCount;
  }

  resetCallCount(): void {
    this.callCount = 0;
  }

  updateConfig(config: Partial<MockLLMConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

export interface MockEmbeddingConfig {
  dimensions: number;
  latencyMs: number;
}

const DEFAULT_EMBEDDING_CONFIG: MockEmbeddingConfig = {
  dimensions: 384,
  latencyMs: 5,
};

/**
 * Generates deterministic embeddings from text.
 *
 * Uses a simple hash-based approach: each word contributes to specific
 * vector dimensions based on its character codes. Strings sharing words
 * will have overlapping non-zero dimensions, producing higher cosine
 * similarity — mimicking how real embedding models handle paraphrases.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  private config: MockEmbeddingConfig;

  constructor(config: Partial<MockEmbeddingConfig> = {}) {
    this.config = { ...DEFAULT_EMBEDDING_CONFIG, ...config };
  }

  get dimensions(): number {
    return this.config.dimensions;
  }

  async embed(text: string): Promise<number[]> {
    await sleep(this.config.latencyMs);
    return this.generateEmbedding(text);
  }

  /**
   * Synchronous embedding for benchmarks where async overhead matters.
   */
  embedSync(text: string): number[] {
    return this.generateEmbedding(text);
  }

  private generateEmbedding(text: string): number[] {
    const vec = new Array<number>(this.config.dimensions).fill(0);
    const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    const words = normalized.split(/\s+/).filter(Boolean);

    for (const word of words) {
      // Each word activates a spread of dimensions based on its hash
      let hash = 0;
      for (let i = 0; i < word.length; i++) {
        hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0;
      }

      // Activate multiple dimensions per word for richer overlap
      for (let i = 0; i < 8; i++) {
        const idx = Math.abs((hash * (i + 1) * 2654435761) | 0) % this.config.dimensions;
        const sign = (hash * (i + 1)) & 1 ? 1 : -1;
        vec[idx] += sign * (1 / (i + 1));
      }
    }

    // L2-normalize
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) {
        vec[i] /= norm;
      }
    }

    return vec;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

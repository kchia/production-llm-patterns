/**
 * Mock LLM provider for testing and benchmarks.
 *
 * Supports configurable latency, canned responses, error injection,
 * and a deterministic embedding function so tests don't need a real
 * embedding model. The deterministic embedding uses a simple character
 * frequency vector — good enough for similarity math in tests.
 */

import type { LLMProvider } from "./types.js";

export interface MockProviderConfig {
  /** Fixed latency per call in ms (simulates network round-trip) */
  latencyMs?: number;
  /**
   * Responses are cycled in order. When the list is exhausted it wraps.
   * Defaults to a single generic response.
   */
  responses?: string[];
  /** Fraction of calls that should throw (0–1). Applied before response. */
  errorRate?: number;
  /** Error message to throw when errorRate fires */
  errorMessage?: string;
  /**
   * Optional: multiplier on the embedding vector's first dimension.
   * Setting this to a value far from 1.0 simulates an "embedding model
   * version drift" failure — similarity scores shift without output change.
   */
  embeddingDriftMultiplier?: number;
}

export class MockProvider implements LLMProvider {
  private callCount = 0;
  private config: Required<MockProviderConfig>;

  constructor(config: MockProviderConfig = {}) {
    this.config = {
      latencyMs: config.latencyMs ?? 10,
      responses: config.responses ?? [
        "The system is operating normally. All checks passed.",
      ],
      errorRate: config.errorRate ?? 0,
      errorMessage: config.errorMessage ?? "Mock provider error",
      embeddingDriftMultiplier: config.embeddingDriftMultiplier ?? 1.0,
    };
  }

  private simulateLatency(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.config.latencyMs));
  }

  async complete(prompt: string): Promise<string> {
    await this.simulateLatency();

    if (Math.random() < this.config.errorRate) {
      throw new Error(this.config.errorMessage);
    }

    const response =
      this.config.responses[this.callCount % this.config.responses.length];
    this.callCount++;
    return response;
  }

  async embed(text: string): Promise<number[]> {
    // Deterministic character-frequency embedding.
    // Produces a 64-dimension vector of normalised character frequencies.
    // Two texts with identical content produce identical vectors;
    // semantically similar texts produce high cosine similarity.
    const vector = new Array(64).fill(0);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i) % 64;
      vector[code]++;
    }

    // Normalise to unit vector for cosine similarity
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    const normalised = magnitude > 0 ? vector.map((v) => v / magnitude) : vector;

    // Apply drift multiplier to simulate embedding model version change
    if (this.config.embeddingDriftMultiplier !== 1.0) {
      normalised[0] *= this.config.embeddingDriftMultiplier;
      // Re-normalise after drift
      const newMag = Math.sqrt(normalised.reduce((sum, v) => sum + v * v, 0));
      return newMag > 0 ? normalised.map((v) => v / newMag) : normalised;
    }

    return normalised;
  }

  getCallCount(): number {
    return this.callCount;
  }

  resetCallCount(): void {
    this.callCount = 0;
  }
}

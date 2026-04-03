/**
 * Types for Snapshot Testing pattern.
 *
 * The core idea: instead of storing raw LLM output strings, we store
 * "characteristics" derived from the output. This makes comparisons
 * cheap (no re-embedding on every run) and tolerant of surface-level
 * rephrasing while catching meaningful content changes.
 */

export interface SnapshotTestCase {
  /** Unique, stable identifier — used as the storage key */
  id: string;
  /** Prompt template to fill with inputs */
  promptTemplate: string;
  /** Values to interpolate into the prompt template */
  inputs: Record<string, unknown>;
  /** Optional: override the stored baseline for this run only */
  expectedCharacteristics?: Partial<SnapshotCharacteristics>;
}

export interface SnapshotCharacteristics {
  /** Cosine-similarity-ready embedding vector of the output content */
  embeddingVector: number[];
  /** Normalised character length — used for length-range checks */
  charCount: number;
  /**
   * JSON-style structural fingerprint: present top-level keys, value
   * type tags (string/number/array/object/null). Null when output isn't JSON.
   */
  structuralFingerprint: StructuralFingerprint | null;
  /** Set of key phrases that must be present (lowercased for comparison) */
  keyPhrases: string[];
  /** Timestamp when this characteristic snapshot was captured */
  capturedAt: string;
}

export interface StructuralFingerprint {
  topLevelKeys: string[];
  /** Maps each key to the type tag of its value */
  keyTypes: Record<string, string>;
}

export interface SnapshotDelta {
  semanticSimilarity: number;
  lengthRatioChange: number; // (live / baseline) - 1
  missingKeyPhrases: string[];
  structuralChanges: string[]; // human-readable diff lines
}

export interface SnapshotResult {
  testCaseId: string;
  passed: boolean;
  similarity: number;
  delta: SnapshotDelta;
  baseline: SnapshotCharacteristics;
  live: SnapshotCharacteristics;
}

export interface SnapshotRunnerConfig {
  /** Directory where baseline snapshots are persisted as JSON files */
  snapshotDir: string;
  /**
   * Minimum cosine similarity to pass. 0.85 suits free-form prose;
   * raise toward 0.92 for structured or compliance-sensitive outputs.
   */
  similarityThreshold: number;
  /**
   * When true, structural property mismatches fail the test.
   * Set false for free-form outputs where JSON structure isn't expected.
   */
  structuralMatchRequired: boolean;
  /**
   * When true, all key phrases from the baseline must be present.
   * Useful for outputs that must mention specific entities or facts.
   */
  keyPhrasesRequired: boolean;
  /**
   * When true, overwrite stored baselines with current outputs.
   * Must be an explicit action — not the default test-run behavior.
   */
  updateMode: boolean;
}

export interface LLMProvider {
  complete(prompt: string): Promise<string>;
  embed(text: string): Promise<number[]>;
}

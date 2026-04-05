export type Severity = 'LOW' | 'MEDIUM' | 'HIGH';
export type DiffGranularity = 'word' | 'sentence' | 'paragraph';
export type HunkType = 'added' | 'removed' | 'unchanged';

export interface DiffHunk {
  type: HunkType;
  value: string;
}

export interface PromptDiff {
  versionA: string;
  versionB: string;
  promptName: string;
  hunks: DiffHunk[];
  severity: Severity;
  semanticDistance: number;
  addedTokens: number;
  removedTokens: number;
  summary: string;
  timestamp: Date;
}

export interface QualityMetrics {
  promptVersion: string;
  windowStart: Date;
  windowEnd: Date;
  // caller-defined quality signals — pattern doesn't prescribe format
  [key: string]: unknown;
}

export interface CorrelationReport {
  diff: PromptDiff;
  metrics: QualityMetrics | null;
  correlationAvailable: boolean;
  note?: string;
}

export interface PromptDifferConfig {
  /** Word-level, sentence-level, or paragraph-level diffing */
  diffGranularity: DiffGranularity;
  /** Cosine distance above which severity is HIGH */
  highSeverityThreshold: number;
  /** Cosine distance above which severity is MEDIUM */
  mediumSeverityThreshold: number;
  /** Whether to include unchanged spans in hunk output */
  includeUnchanged: boolean;
  /** Number of surrounding tokens to include as context per hunk */
  maxHunkContext: number;
  /** Correlation window in ms to wait for metrics after deploy */
  correlationWindowMs: number;
}

export interface PromptVersion {
  id: string;
  name: string;
  content: string;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

export interface PromptRegistry {
  get(versionId: string): Promise<PromptVersion | null>;
  getLatest(promptName: string): Promise<PromptVersion | null>;
  getPrevious(versionId: string): Promise<PromptVersion | null>;
}

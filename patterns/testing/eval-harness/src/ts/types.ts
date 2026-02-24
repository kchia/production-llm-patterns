/**
 * Eval Harness — Type Definitions
 *
 * Core types for the evaluation pipeline: cases, scorers, results, and comparison.
 */

// --- Eval Dataset ---

export interface EvalCase {
  id: string;
  input: string;
  expected?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// --- Scorer ---

export interface ScorerResult {
  score: number; // 0.0 – 1.0
  pass: boolean;
  reason?: string;
}

export interface Scorer {
  name: string;
  score: (
    input: string,
    output: string,
    expected?: string
  ) => Promise<ScorerResult>;
}

// --- Provider ---

export interface ProviderResponse {
  output: string;
  latencyMs: number;
  tokenUsage: { input: number; output: number };
}

export type LLMProvider = (input: string) => Promise<ProviderResponse>;

// --- Eval Result ---

export interface EvalCaseResult {
  caseId: string;
  input: string;
  output: string;
  expected?: string;
  tags?: string[];
  scores: Record<string, ScorerResult>;
  latencyMs: number;
  tokenUsage: { input: number; output: number };
}

export interface EvalRunResult {
  runId: string;
  timestamp: string;
  config: EvalHarnessConfig;
  results: EvalCaseResult[];
  aggregate: AggregateScores;
  durationMs: number;
}

export interface AggregateScores {
  overall: Record<string, number>; // scorer name → mean score
  byTag: Record<string, Record<string, number>>; // tag → scorer → mean score
  passRate: number; // fraction of cases where all scorers passed
}

// --- Comparison ---

export interface ComparisonResult {
  baselineRunId: string;
  currentRunId: string;
  regressions: Regression[];
  improvements: Improvement[];
  overallDelta: Record<string, number>; // scorer → delta
  byTagDelta: Record<string, Record<string, number>>; // tag → scorer → delta
  passed: boolean;
}

export interface Regression {
  scorer: string;
  tag?: string; // undefined = overall regression
  baselineScore: number;
  currentScore: number;
  delta: number;
}

export interface Improvement {
  scorer: string;
  tag?: string;
  baselineScore: number;
  currentScore: number;
  delta: number;
}

// --- Config ---

export interface EvalHarnessConfig {
  dataset: EvalCase[];
  scorers: Scorer[];
  provider: LLMProvider;
  concurrency?: number;
  threshold?: number;
  regressionTolerance?: number;
  timeoutMs?: number;
  tags?: string[];
}

export const DEFAULT_CONFIG = {
  concurrency: 5,
  threshold: 0.7,
  regressionTolerance: 0.05,
  timeoutMs: 30_000,
} as const;

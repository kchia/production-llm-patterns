/**
 * Regression Testing — Type Definitions
 *
 * Extends the eval harness with baseline management, version-aware comparison,
 * and CI gate types. Reuses scorer/provider types from eval-harness.
 */

// --- Provider & Scorer (self-contained, mirrors eval-harness) ---

export interface ProviderResponse {
  output: string;
  latencyMs: number;
  tokenUsage: { input: number; output: number };
}

export type LLMProvider = (input: string) => Promise<ProviderResponse>;

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

// --- Test Suite ---

export interface TestCase {
  id: string;
  input: string;
  expected?: string;
  tags: string[];
  metadata?: Record<string, unknown>;
}

export interface TestSuite {
  id: string;
  version: string;
  cases: TestCase[];
}

// --- Eval Results (per-case and aggregate) ---

export interface CaseResult {
  caseId: string;
  input: string;
  output: string;
  expected?: string;
  tags: string[];
  scores: Record<string, ScorerResult>;
  latencyMs: number;
  tokenUsage: { input: number; output: number };
}

export interface AggregateScores {
  overall: Record<string, number>; // scorer name → mean score
  byTag: Record<string, Record<string, number>>; // tag → scorer → mean
  passRate: number;
}

export interface RunResult {
  runId: string;
  suiteId: string;
  suiteVersion: string;
  timestamp: string;
  results: CaseResult[];
  aggregate: AggregateScores;
  durationMs: number;
}

// --- Baseline Store ---

export interface BaselineStore {
  load(suiteId: string): Promise<RunResult | null>;
  save(suiteId: string, result: RunResult): Promise<void>;
  history(suiteId: string, limit: number): Promise<RunResult[]>;
  loadGenesis(suiteId: string): Promise<RunResult | null>;
  saveGenesis(suiteId: string, result: RunResult): Promise<void>;
}

// --- Regression Detection ---

export interface TagRegression {
  scorer: string;
  tag?: string;
  baselineScore: number;
  currentScore: number;
  delta: number;
}

export interface TagImprovement {
  scorer: string;
  tag?: string;
  baselineScore: number;
  currentScore: number;
  delta: number;
}

// --- Report ---

export interface RegressionReport {
  passed: boolean;
  overallScore: number;
  baselineScore: number | null;
  genesisScore: number | null;
  genesisDelta: number | null;
  regressions: TagRegression[];
  improvements: TagImprovement[];
  perTagScores: Record<string, Record<string, number>>;
  summary: string;
  runResult: RunResult;
}

// --- Config ---

export interface RegressionConfig {
  suite: TestSuite;
  provider: LLMProvider;
  scorers: Scorer[];
  baselineStore: BaselineStore;
  regressionThreshold?: number;
  minPassScore?: number;
  failOnRegression?: boolean;
  concurrency?: number;
  timeoutMs?: number;
  genesisGapThreshold?: number;
}

export const DEFAULT_REGRESSION_CONFIG = {
  regressionThreshold: 0.05,
  minPassScore: 0.7,
  failOnRegression: true,
  concurrency: 5,
  timeoutMs: 30_000,
  genesisGapThreshold: 0.10,
} as const;

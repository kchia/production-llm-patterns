/**
 * Latency Budget Pattern — Type Definitions
 */

/** Strategy when budget pressure is detected */
export type BudgetExhaustedStrategy = 'skip-optional' | 'abort' | 'best-effort';

/** Result of a pipeline step execution */
export interface StepResult<T = unknown> {
  /** The output value, if the step ran */
  output: T | null;
  /** Whether the step was skipped due to budget pressure */
  skipped: boolean;
  /** Time consumed by this step in milliseconds */
  elapsedMs: number;
  /** Budget remaining after this step completed */
  remainingMs: number;
}

/** Per-step configuration */
export interface StepConfig {
  /** Unique name for this step (used in metrics and logs) */
  name: string;
  /** Minimum budget (ms) this step needs to produce useful output */
  minBudgetMs: number;
  /** Whether this step can be skipped under budget pressure */
  optional: boolean;
  /** Per-step hard ceiling in ms (capped at remaining budget) */
  timeoutMs?: number;
}

/** Pipeline configuration */
export interface LatencyBudgetConfig {
  /** Total request deadline in milliseconds */
  totalBudgetMs: number;
  /** Time reserved for response serialization and network overhead */
  reserveMs: number;
  /** Strategy when budget runs low */
  onBudgetExhausted: BudgetExhaustedStrategy;
}

/** Metrics emitted per pipeline execution */
export interface PipelineMetrics {
  /** Total time from budget creation to pipeline completion */
  totalElapsedMs: number;
  /** Budget utilization as a fraction (0-1+, >1 means overrun) */
  budgetUtilization: number;
  /** Number of steps skipped due to budget pressure */
  skippedSteps: number;
  /** Per-step timing breakdown */
  stepTimings: Array<{
    name: string;
    elapsedMs: number;
    skipped: boolean;
    remainingBudgetMs: number;
  }>;
  /** Whether the overall deadline was exceeded */
  deadlineExceeded: boolean;
}

/** Mock provider configuration for testing */
export interface MockProviderConfig {
  /** Base latency in ms for responses */
  latencyMs: number;
  /** Latency variance — actual latency = latencyMs ± varianceMs */
  varianceMs: number;
  /** Token count for generated output */
  outputTokens: number;
  /** Error rate (0-1) — fraction of calls that throw */
  errorRate: number;
  /** Optional: fixed latency values for deterministic testing */
  deterministicLatencies?: number[];
}

/** Response from the mock LLM provider */
export interface MockProviderResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  model: string;
}

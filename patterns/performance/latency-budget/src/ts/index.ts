/**
 * Latency Budget Pattern — Core Implementation
 *
 * Propagates a deadline through a multi-step LLM pipeline, enabling each
 * step to query remaining budget and make adaptive decisions (skip optional
 * steps, switch models, abort early).
 *
 * Inspired by gRPC deadline propagation. Uses monotonic-ish timing
 * (performance.now()) to avoid system clock adjustment issues.
 */

import {
  BudgetExhaustedStrategy,
  LatencyBudgetConfig,
  PipelineMetrics,
  StepConfig,
  StepResult,
} from './types';

const DEFAULT_CONFIG: LatencyBudgetConfig = {
  totalBudgetMs: 3000,
  reserveMs: 200,
  onBudgetExhausted: 'skip-optional',
};

// -- LatencyBudget: the propagated context object --

export class LatencyBudget {
  private readonly deadlineMs: number;
  private readonly startMs: number;

  constructor(totalBudgetMs: number, startMs?: number) {
    this.startMs = startMs ?? performance.now();
    this.deadlineMs = this.startMs + totalBudgetMs;
  }

  /** Milliseconds remaining until deadline */
  remaining(): number {
    return Math.max(0, this.deadlineMs - performance.now());
  }

  /** Milliseconds elapsed since budget creation */
  elapsed(): number {
    return performance.now() - this.startMs;
  }

  /** Whether the deadline has passed */
  isExpired(): boolean {
    return performance.now() >= this.deadlineMs;
  }

  /** Fraction of total budget consumed (>1 means overrun) */
  utilization(): number {
    const total = this.deadlineMs - this.startMs;
    if (total <= 0) return 1;
    return this.elapsed() / total;
  }

  /**
   * Create a child budget with a tighter deadline.
   * The child's deadline is capped at the parent's — it can't extend time.
   */
  child(maxMs: number): LatencyBudget {
    const now = performance.now();
    const parentRemaining = Math.max(0, this.deadlineMs - now);
    const childBudget = Math.min(maxMs, parentRemaining);
    return new LatencyBudget(childBudget, now);
  }

  /** The absolute deadline timestamp (in performance.now() units) */
  get deadline(): number {
    return this.deadlineMs;
  }
}

// -- PipelineStep: wraps a step function with budget awareness --

export interface PipelineStepFn<TInput, TOutput> {
  (input: TInput, budget: LatencyBudget): Promise<TOutput>;
}

export class PipelineStep<TInput = unknown, TOutput = unknown> {
  readonly config: StepConfig;
  private readonly fn: PipelineStepFn<TInput, TOutput>;

  constructor(config: StepConfig, fn: PipelineStepFn<TInput, TOutput>) {
    this.config = config;
    this.fn = fn;
  }

  async execute(input: TInput, budget: LatencyBudget): Promise<StepResult<TOutput>> {
    const stepStart = performance.now();

    // Check if we have enough budget to run this step
    const remaining = budget.remaining();
    if (remaining < this.config.minBudgetMs) {
      return {
        output: null,
        skipped: true,
        elapsedMs: performance.now() - stepStart,
        remainingMs: budget.remaining(),
      };
    }

    // Create a child budget: step-level timeout if configured, capped at remaining
    const stepBudget = this.config.timeoutMs
      ? budget.child(this.config.timeoutMs)
      : budget;

    try {
      const output = await this.fn(input, stepBudget);
      return {
        output,
        skipped: false,
        elapsedMs: performance.now() - stepStart,
        remainingMs: budget.remaining(),
      };
    } catch (error) {
      // If the step errors and it's optional, treat as a skip
      if (this.config.optional) {
        return {
          output: null,
          skipped: true,
          elapsedMs: performance.now() - stepStart,
          remainingMs: budget.remaining(),
        };
      }
      throw error;
    }
  }
}

// -- LatencyBudgetPipeline: orchestrates steps with budget propagation --

export class LatencyBudgetPipeline {
  private readonly config: LatencyBudgetConfig;
  private readonly steps: PipelineStep<any, any>[];
  private metricsCallback?: (metrics: PipelineMetrics) => void;

  constructor(
    steps: PipelineStep<any, any>[],
    config: Partial<LatencyBudgetConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.steps = steps;
  }

  /** Register a callback to receive metrics after each pipeline execution */
  onMetrics(callback: (metrics: PipelineMetrics) => void): void {
    this.metricsCallback = callback;
  }

  /**
   * Execute the pipeline with budget propagation.
   * Each step receives the remaining budget and can query it for adaptive behavior.
   */
  async execute<TInput>(input: TInput): Promise<{
    results: StepResult[];
    metrics: PipelineMetrics;
  }> {
    const budget = new LatencyBudget(this.config.totalBudgetMs - this.config.reserveMs);
    const results: StepResult[] = [];
    const stepTimings: PipelineMetrics['stepTimings'] = [];

    let currentInput: unknown = input;

    for (const step of this.steps) {
      const remaining = budget.remaining();

      // Decide whether to run, skip, or abort based on budget and strategy
      if (remaining < step.config.minBudgetMs) {
        if (step.config.optional && this.config.onBudgetExhausted === 'skip-optional') {
          const skippedResult: StepResult = {
            output: null,
            skipped: true,
            elapsedMs: 0,
            remainingMs: remaining,
          };
          results.push(skippedResult);
          stepTimings.push({
            name: step.config.name,
            elapsedMs: 0,
            skipped: true,
            remainingBudgetMs: remaining,
          });
          continue;
        }

        if (this.config.onBudgetExhausted === 'abort') {
          // Push a skipped result for this step and break
          results.push({
            output: null,
            skipped: true,
            elapsedMs: 0,
            remainingMs: remaining,
          });
          stepTimings.push({
            name: step.config.name,
            elapsedMs: 0,
            skipped: true,
            remainingBudgetMs: remaining,
          });
          break;
        }

        // 'best-effort': try to run even with low budget
      }

      const result = await step.execute(currentInput, budget);
      results.push(result);
      stepTimings.push({
        name: step.config.name,
        elapsedMs: result.elapsedMs,
        skipped: result.skipped,
        remainingBudgetMs: result.remainingMs,
      });

      // Pass output forward (if step produced output, use it; otherwise keep current)
      if (!result.skipped && result.output !== null) {
        currentInput = result.output;
      }
    }

    const totalElapsed = budget.elapsed();
    const totalBudget = this.config.totalBudgetMs - this.config.reserveMs;

    const metrics: PipelineMetrics = {
      totalElapsedMs: totalElapsed,
      budgetUtilization: totalBudget > 0 ? totalElapsed / totalBudget : 1,
      skippedSteps: results.filter((r) => r.skipped).length,
      stepTimings,
      deadlineExceeded: budget.isExpired(),
    };

    this.metricsCallback?.(metrics);

    return { results, metrics };
  }
}

// -- Convenience: create a step with less boilerplate --

export function createStep<TInput, TOutput>(
  name: string,
  fn: PipelineStepFn<TInput, TOutput>,
  config: Partial<StepConfig> = {},
): PipelineStep<TInput, TOutput> {
  return new PipelineStep(
    {
      name,
      minBudgetMs: config.minBudgetMs ?? 100,
      optional: config.optional ?? false,
      timeoutMs: config.timeoutMs,
    },
    fn,
  );
}

/**
 * Eval Harness — Main Implementation
 *
 * Orchestrates evaluation runs: processes eval cases through a provider,
 * scores outputs, computes aggregates, and compares against baselines.
 */

import {
  EvalCase,
  EvalCaseResult,
  EvalRunResult,
  EvalHarnessConfig,
  AggregateScores,
  ComparisonResult,
  Regression,
  Improvement,
  Scorer,
  ScorerResult,
  DEFAULT_CONFIG,
} from "./types";

export class EvalHarness {
  private readonly config: Required<
    Pick<
      EvalHarnessConfig,
      "concurrency" | "threshold" | "regressionTolerance" | "timeoutMs"
    >
  > &
    EvalHarnessConfig;

  constructor(config: EvalHarnessConfig) {
    this.config = {
      ...config,
      concurrency: config.concurrency ?? DEFAULT_CONFIG.concurrency,
      threshold: config.threshold ?? DEFAULT_CONFIG.threshold,
      regressionTolerance:
        config.regressionTolerance ?? DEFAULT_CONFIG.regressionTolerance,
      timeoutMs: config.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
    };
  }

  /**
   * Run evaluation across all cases (or filtered by tags).
   * Returns structured results with per-case scores and aggregates.
   */
  async run(): Promise<EvalRunResult> {
    const start = Date.now();
    const runId = generateRunId();

    const cases = this.filterCases(this.config.dataset);

    if (cases.length === 0) {
      throw new Error(
        "No eval cases to run. Check dataset and tag filters."
      );
    }

    const results = await this.processInBatches(cases);
    const aggregate = computeAggregates(results, this.config.scorers);

    return {
      runId,
      timestamp: new Date().toISOString(),
      config: this.config,
      results,
      aggregate,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Compare two eval runs and flag regressions/improvements.
   */
  compare(
    baseline: EvalRunResult,
    current: EvalRunResult
  ): ComparisonResult {
    const tolerance = this.config.regressionTolerance;
    const regressions: Regression[] = [];
    const improvements: Improvement[] = [];
    const overallDelta: Record<string, number> = {};
    const byTagDelta: Record<string, Record<string, number>> = {};

    // Overall comparison per scorer
    for (const scorerName of Object.keys(current.aggregate.overall)) {
      const baseScore = baseline.aggregate.overall[scorerName] ?? 0;
      const currScore = current.aggregate.overall[scorerName] ?? 0;
      const delta = currScore - baseScore;
      overallDelta[scorerName] = delta;

      if (delta < -tolerance) {
        regressions.push({
          scorer: scorerName,
          baselineScore: baseScore,
          currentScore: currScore,
          delta,
        });
      } else if (delta > tolerance) {
        improvements.push({
          scorer: scorerName,
          baselineScore: baseScore,
          currentScore: currScore,
          delta,
        });
      }
    }

    // Per-tag comparison
    const allTags = new Set([
      ...Object.keys(baseline.aggregate.byTag),
      ...Object.keys(current.aggregate.byTag),
    ]);

    for (const tag of allTags) {
      byTagDelta[tag] = {};
      const baseTagScores = baseline.aggregate.byTag[tag] ?? {};
      const currTagScores = current.aggregate.byTag[tag] ?? {};

      for (const scorerName of Object.keys(currTagScores)) {
        const baseScore = baseTagScores[scorerName] ?? 0;
        const currScore = currTagScores[scorerName] ?? 0;
        const delta = currScore - baseScore;
        byTagDelta[tag][scorerName] = delta;

        if (delta < -tolerance) {
          regressions.push({
            scorer: scorerName,
            tag,
            baselineScore: baseScore,
            currentScore: currScore,
            delta,
          });
        } else if (delta > tolerance) {
          improvements.push({
            scorer: scorerName,
            tag,
            baselineScore: baseScore,
            currentScore: currScore,
            delta,
          });
        }
      }
    }

    return {
      baselineRunId: baseline.runId,
      currentRunId: current.runId,
      regressions,
      improvements,
      overallDelta,
      byTagDelta,
      passed: regressions.length === 0,
    };
  }

  /**
   * Check if an eval run passes the configured threshold.
   */
  passes(result: EvalRunResult): boolean {
    const scores = Object.values(result.aggregate.overall);
    if (scores.length === 0) return false;
    return scores.every((s) => s >= this.config.threshold);
  }

  private filterCases(cases: EvalCase[]): EvalCase[] {
    if (!this.config.tags || this.config.tags.length === 0) return cases;
    const tagSet = new Set(this.config.tags);
    return cases.filter(
      (c) => c.tags && c.tags.some((t) => tagSet.has(t))
    );
  }

  private async processInBatches(
    cases: EvalCase[]
  ): Promise<EvalCaseResult[]> {
    const results: EvalCaseResult[] = [];
    const concurrency = this.config.concurrency;

    // Process in chunks of `concurrency`
    for (let i = 0; i < cases.length; i += concurrency) {
      const batch = cases.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map((c) => this.evaluateCase(c))
      );
      results.push(...batchResults);
    }

    return results;
  }

  private async evaluateCase(evalCase: EvalCase): Promise<EvalCaseResult> {
    const { provider, scorers, timeoutMs } = this.config;

    // Call provider with timeout
    let output: string;
    let latencyMs: number;
    let tokenUsage: { input: number; output: number };

    try {
      const response = await withTimeout(
        provider(evalCase.input),
        timeoutMs
      );
      output = response.output;
      latencyMs = response.latencyMs;
      tokenUsage = response.tokenUsage;
    } catch (err) {
      // Provider failure — score as zero across all scorers
      const failScores: Record<string, ScorerResult> = {};
      for (const scorer of scorers) {
        failScores[scorer.name] = {
          score: 0,
          pass: false,
          reason: `Provider error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return {
        caseId: evalCase.id,
        input: evalCase.input,
        output: "",
        expected: evalCase.expected,
        tags: evalCase.tags,
        scores: failScores,
        latencyMs: 0,
        tokenUsage: { input: 0, output: 0 },
      };
    }

    // Run all scorers
    const scores: Record<string, ScorerResult> = {};
    for (const scorer of scorers) {
      try {
        scores[scorer.name] = await scorer.score(
          evalCase.input,
          output,
          evalCase.expected
        );
      } catch (err) {
        scores[scorer.name] = {
          score: 0,
          pass: false,
          reason: `Scorer error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    return {
      caseId: evalCase.id,
      input: evalCase.input,
      output,
      expected: evalCase.expected,
      tags: evalCase.tags,
      scores,
      latencyMs,
      tokenUsage,
    };
  }
}

// --- Built-in Scorers ---

/** Exact match scorer — output must equal expected (case-insensitive by default). */
export function exactMatchScorer(caseSensitive = false): Scorer {
  return {
    name: "exact_match",
    score: async (_input, output, expected) => {
      if (!expected) return { score: 0, pass: false, reason: "No expected output" };
      const a = caseSensitive ? output.trim() : output.trim().toLowerCase();
      const b = caseSensitive ? expected.trim() : expected.trim().toLowerCase();
      const match = a === b;
      return { score: match ? 1 : 0, pass: match };
    },
  };
}

/** Contains scorer — output must contain expected as a substring. */
export function containsScorer(): Scorer {
  return {
    name: "contains",
    score: async (_input, output, expected) => {
      if (!expected) return { score: 0, pass: false, reason: "No expected output" };
      const contains = output.toLowerCase().includes(expected.toLowerCase());
      return { score: contains ? 1 : 0, pass: contains };
    },
  };
}

/** Length scorer — penalizes outputs that are too short or too long relative to expected length. */
export function lengthScorer(minTokens = 10, maxTokens = 500): Scorer {
  return {
    name: "length",
    score: async (_input, output) => {
      const wordCount = output.split(/\s+/).length;
      if (wordCount < minTokens) {
        return {
          score: wordCount / minTokens,
          pass: false,
          reason: `Too short: ${wordCount} words (min: ${minTokens})`,
        };
      }
      if (wordCount > maxTokens) {
        return {
          score: maxTokens / wordCount,
          pass: false,
          reason: `Too long: ${wordCount} words (max: ${maxTokens})`,
        };
      }
      return { score: 1, pass: true };
    },
  };
}

/**
 * Custom function scorer — wrap any (input, output, expected) → score function.
 * Useful for domain-specific quality checks.
 */
export function customScorer(
  name: string,
  fn: (input: string, output: string, expected?: string) => number | Promise<number>,
  passThreshold = 0.5
): Scorer {
  return {
    name,
    score: async (input, output, expected) => {
      const score = await fn(input, output, expected);
      const clamped = Math.max(0, Math.min(1, score));
      return { score: clamped, pass: clamped >= passThreshold };
    },
  };
}

// --- Aggregate Computation ---

function computeAggregates(
  results: EvalCaseResult[],
  scorers: Scorer[]
): AggregateScores {
  const scorerNames = scorers.map((s) => s.name);

  // Overall mean per scorer
  const overall: Record<string, number> = {};
  for (const name of scorerNames) {
    const scores = results
      .map((r) => r.scores[name]?.score)
      .filter((s): s is number => s !== undefined);
    overall[name] = scores.length > 0 ? mean(scores) : 0;
  }

  // Per-tag mean per scorer
  const byTag: Record<string, Record<string, number>> = {};
  const allTags = new Set(results.flatMap((r) => r.tags ?? []));

  for (const tag of allTags) {
    byTag[tag] = {};
    const tagResults = results.filter((r) => r.tags?.includes(tag));
    for (const name of scorerNames) {
      const scores = tagResults
        .map((r) => r.scores[name]?.score)
        .filter((s): s is number => s !== undefined);
      byTag[tag][name] = scores.length > 0 ? mean(scores) : 0;
    }
  }

  // Pass rate: fraction where ALL scorers passed
  const passCount = results.filter((r) =>
    scorerNames.every((name) => r.scores[name]?.pass)
  ).length;

  return {
    overall,
    byTag,
    passRate: results.length > 0 ? passCount / results.length : 0,
  };
}

// --- Utilities ---

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function generateRunId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `eval-${ts}-${rand}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Eval case timed out after ${ms}ms`)),
      ms
    );
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export { EvalHarness as default };

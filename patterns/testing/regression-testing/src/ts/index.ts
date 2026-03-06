/**
 * Regression Testing — Main Implementation
 *
 * Wraps an eval harness with baseline management, per-tag comparison,
 * and CI gate logic. Detects quality regressions across prompt versions
 * by comparing scored results against stored baselines.
 */

import {
  TestCase,
  TestSuite,
  CaseResult,
  RunResult,
  AggregateScores,
  RegressionConfig,
  RegressionReport,
  TagRegression,
  TagImprovement,
  BaselineStore,
  Scorer,
  ScorerResult,
  DEFAULT_REGRESSION_CONFIG,
} from "./types";

export class RegressionRunner {
  private readonly config: Required<
    Pick<
      RegressionConfig,
      | "regressionThreshold"
      | "minPassScore"
      | "failOnRegression"
      | "concurrency"
      | "timeoutMs"
      | "genesisGapThreshold"
    >
  > &
    RegressionConfig;

  constructor(config: RegressionConfig) {
    this.config = {
      ...config,
      regressionThreshold:
        config.regressionThreshold ??
        DEFAULT_REGRESSION_CONFIG.regressionThreshold,
      minPassScore:
        config.minPassScore ?? DEFAULT_REGRESSION_CONFIG.minPassScore,
      failOnRegression:
        config.failOnRegression ?? DEFAULT_REGRESSION_CONFIG.failOnRegression,
      concurrency:
        config.concurrency ?? DEFAULT_REGRESSION_CONFIG.concurrency,
      timeoutMs: config.timeoutMs ?? DEFAULT_REGRESSION_CONFIG.timeoutMs,
      genesisGapThreshold:
        config.genesisGapThreshold ??
        DEFAULT_REGRESSION_CONFIG.genesisGapThreshold,
    };
  }

  /**
   * Run the full regression pipeline:
   * 1. Execute eval cases through the provider
   * 2. Load baseline from store
   * 3. Compare per-tag scores
   * 4. Produce a gate decision
   */
  async run(): Promise<RegressionReport> {
    const { suite, baselineStore } = this.config;

    // Step 1: Run eval
    const runResult = await this.executeRun(suite);

    // Step 2: Load baseline and genesis
    const baseline = await baselineStore.load(suite.id);
    const genesis = await baselineStore.loadGenesis(suite.id);

    // Step 3: Compare
    const regressions: TagRegression[] = [];
    const improvements: TagImprovement[] = [];
    let baselineScore: number | null = null;

    if (baseline) {
      baselineScore = meanOfScores(baseline.aggregate.overall);
      this.compareAggregates(
        baseline.aggregate,
        runResult.aggregate,
        regressions,
        improvements
      );
    }

    // Genesis gap check
    let genesisScore: number | null = null;
    let genesisDelta: number | null = null;
    if (genesis) {
      genesisScore = meanOfScores(genesis.aggregate.overall);
      const currentMean = meanOfScores(runResult.aggregate.overall);
      genesisDelta = currentMean - genesisScore;
    }

    // Step 4: Gate decision
    const overallScore = meanOfScores(runResult.aggregate.overall);
    const belowMinScore = overallScore < this.config.minPassScore;
    const hasRegressions = regressions.length > 0;
    const genesisGapExceeded =
      genesisDelta !== null &&
      genesisDelta < -this.config.genesisGapThreshold;

    const passed =
      !belowMinScore &&
      (!hasRegressions || !this.config.failOnRegression) &&
      !genesisGapExceeded;

    // Save as new baseline on pass (only if no regressions)
    if (passed && !hasRegressions) {
      await baselineStore.save(suite.id, runResult);
      // First passing run becomes genesis if none exists
      if (!genesis) {
        await baselineStore.saveGenesis(suite.id, runResult);
      }
    }

    const summary = this.buildSummary(
      passed,
      overallScore,
      baselineScore,
      regressions,
      improvements,
      genesisScore,
      genesisDelta
    );

    return {
      passed,
      overallScore,
      baselineScore,
      genesisScore,
      genesisDelta,
      regressions,
      improvements,
      perTagScores: runResult.aggregate.byTag,
      summary,
      runResult,
    };
  }

  private compareAggregates(
    baseline: AggregateScores,
    current: AggregateScores,
    regressions: TagRegression[],
    improvements: TagImprovement[]
  ): void {
    const tolerance = this.config.regressionThreshold;

    // Overall comparison per scorer
    for (const scorerName of Object.keys(current.overall)) {
      const baseScore = baseline.overall[scorerName] ?? 0;
      const currScore = current.overall[scorerName] ?? 0;
      const delta = currScore - baseScore;

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
      ...Object.keys(baseline.byTag),
      ...Object.keys(current.byTag),
    ]);

    for (const tag of allTags) {
      const baseTagScores = baseline.byTag[tag] ?? {};
      const currTagScores = current.byTag[tag] ?? {};

      for (const scorerName of Object.keys(currTagScores)) {
        const baseScore = baseTagScores[scorerName] ?? 0;
        const currScore = currTagScores[scorerName] ?? 0;
        const delta = currScore - baseScore;

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
  }

  private async executeRun(suite: TestSuite): Promise<RunResult> {
    const start = Date.now();
    const runId = generateRunId();
    const results = await this.processInBatches(suite.cases);
    const aggregate = computeAggregates(results, this.config.scorers);

    return {
      runId,
      suiteId: suite.id,
      suiteVersion: suite.version,
      timestamp: new Date().toISOString(),
      results,
      aggregate,
      durationMs: Date.now() - start,
    };
  }

  private async processInBatches(cases: TestCase[]): Promise<CaseResult[]> {
    const results: CaseResult[] = [];
    const concurrency = this.config.concurrency;

    for (let i = 0; i < cases.length; i += concurrency) {
      const batch = cases.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map((c) => this.evaluateCase(c))
      );
      results.push(...batchResults);
    }

    return results;
  }

  private async evaluateCase(testCase: TestCase): Promise<CaseResult> {
    const { provider, scorers, timeoutMs } = this.config;

    let output: string;
    let latencyMs: number;
    let tokenUsage: { input: number; output: number };

    try {
      const response = await withTimeout(
        provider(testCase.input),
        timeoutMs
      );
      output = response.output;
      latencyMs = response.latencyMs;
      tokenUsage = response.tokenUsage;
    } catch (err) {
      const failScores: Record<string, ScorerResult> = {};
      for (const scorer of scorers) {
        failScores[scorer.name] = {
          score: 0,
          pass: false,
          reason: `Provider error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return {
        caseId: testCase.id,
        input: testCase.input,
        output: "",
        expected: testCase.expected,
        tags: testCase.tags,
        scores: failScores,
        latencyMs: 0,
        tokenUsage: { input: 0, output: 0 },
      };
    }

    const scores: Record<string, ScorerResult> = {};
    for (const scorer of scorers) {
      try {
        scores[scorer.name] = await scorer.score(
          testCase.input,
          output,
          testCase.expected
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
      caseId: testCase.id,
      input: testCase.input,
      output,
      expected: testCase.expected,
      tags: testCase.tags,
      scores,
      latencyMs,
      tokenUsage,
    };
  }

  private buildSummary(
    passed: boolean,
    overallScore: number,
    baselineScore: number | null,
    regressions: TagRegression[],
    improvements: TagImprovement[],
    genesisScore: number | null,
    genesisDelta: number | null
  ): string {
    const lines: string[] = [];

    lines.push(passed ? "PASS" : "FAIL");
    lines.push(`Overall score: ${(overallScore * 100).toFixed(1)}%`);

    if (baselineScore !== null) {
      const delta = overallScore - baselineScore;
      const sign = delta >= 0 ? "+" : "";
      lines.push(
        `Baseline: ${(baselineScore * 100).toFixed(1)}% (${sign}${(delta * 100).toFixed(1)}%)`
      );
    } else {
      lines.push("No baseline — this run establishes the first baseline");
    }

    if (genesisScore !== null && genesisDelta !== null) {
      const sign = genesisDelta >= 0 ? "+" : "";
      lines.push(
        `Genesis gap: ${sign}${(genesisDelta * 100).toFixed(1)}%`
      );
    }

    if (regressions.length > 0) {
      lines.push(`Regressions (${regressions.length}):`);
      for (const r of regressions) {
        const scope = r.tag ? `[${r.tag}]` : "[overall]";
        lines.push(
          `  ${scope} ${r.scorer}: ${(r.baselineScore * 100).toFixed(1)}% → ${(r.currentScore * 100).toFixed(1)}% (${(r.delta * 100).toFixed(1)}%)`
        );
      }
    }

    if (improvements.length > 0) {
      lines.push(`Improvements (${improvements.length}):`);
      for (const imp of improvements) {
        const scope = imp.tag ? `[${imp.tag}]` : "[overall]";
        lines.push(
          `  ${scope} ${imp.scorer}: ${(imp.baselineScore * 100).toFixed(1)}% → ${(imp.currentScore * 100).toFixed(1)}% (+${(imp.delta * 100).toFixed(1)}%)`
        );
      }
    }

    return lines.join("\n");
  }
}

// --- In-Memory Baseline Store ---

/**
 * Simple in-memory baseline store for testing and development.
 * In production, replace with file-based or DB-backed implementation.
 */
export class InMemoryBaselineStore implements BaselineStore {
  private baselines = new Map<string, RunResult>();
  private historyMap = new Map<string, RunResult[]>();
  private genesisMap = new Map<string, RunResult>();

  async load(suiteId: string): Promise<RunResult | null> {
    return this.baselines.get(suiteId) ?? null;
  }

  async save(suiteId: string, result: RunResult): Promise<void> {
    this.baselines.set(suiteId, result);
    const history = this.historyMap.get(suiteId) ?? [];
    history.push(result);
    this.historyMap.set(suiteId, history);
  }

  async history(suiteId: string, limit: number): Promise<RunResult[]> {
    const all = this.historyMap.get(suiteId) ?? [];
    return all.slice(-limit);
  }

  async loadGenesis(suiteId: string): Promise<RunResult | null> {
    return this.genesisMap.get(suiteId) ?? null;
  }

  async saveGenesis(suiteId: string, result: RunResult): Promise<void> {
    // Genesis is immutable — only set if not already present
    if (!this.genesisMap.has(suiteId)) {
      this.genesisMap.set(suiteId, result);
    }
  }
}

// --- Built-in Scorers ---

/** Exact match scorer */
export function exactMatchScorer(caseSensitive = false): Scorer {
  return {
    name: "exact_match",
    score: async (_input, output, expected) => {
      if (!expected)
        return { score: 0, pass: false, reason: "No expected output" };
      const a = caseSensitive ? output.trim() : output.trim().toLowerCase();
      const b = caseSensitive
        ? expected.trim()
        : expected.trim().toLowerCase();
      const match = a === b;
      return { score: match ? 1 : 0, pass: match };
    },
  };
}

/** Contains scorer — output must contain expected as a substring */
export function containsScorer(): Scorer {
  return {
    name: "contains",
    score: async (_input, output, expected) => {
      if (!expected)
        return { score: 0, pass: false, reason: "No expected output" };
      const contains = output.toLowerCase().includes(expected.toLowerCase());
      return { score: contains ? 1 : 0, pass: contains };
    },
  };
}

/** Custom function scorer */
export function customScorer(
  name: string,
  fn: (
    input: string,
    output: string,
    expected?: string
  ) => number | Promise<number>,
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

// --- Utilities ---

function computeAggregates(
  results: CaseResult[],
  scorers: Scorer[]
): AggregateScores {
  const scorerNames = scorers.map((s) => s.name);

  const overall: Record<string, number> = {};
  for (const name of scorerNames) {
    const scores = results
      .map((r) => r.scores[name]?.score)
      .filter((s): s is number => s !== undefined);
    overall[name] = scores.length > 0 ? mean(scores) : 0;
  }

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

  const passCount = results.filter((r) =>
    scorerNames.every((name) => r.scores[name]?.pass)
  ).length;

  return {
    overall,
    byTag,
    passRate: results.length > 0 ? passCount / results.length : 0,
  };
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function meanOfScores(overall: Record<string, number>): number {
  const values = Object.values(overall);
  return values.length > 0 ? mean(values) : 0;
}

function generateRunId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `reg-${ts}-${rand}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Test case timed out after ${ms}ms`)),
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

export { RegressionRunner as default };

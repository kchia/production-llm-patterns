import { describe, it, expect } from "vitest";
import {
  EvalHarness,
  exactMatchScorer,
  containsScorer,
  lengthScorer,
  customScorer,
} from "../index";
import { createMockProvider } from "../mock-provider";
import type { EvalCase, Scorer, EvalRunResult } from "../types";

// --- Test Dataset ---

const DATASET: EvalCase[] = [
  { id: "g1", input: "hello", expected: "hello back", tags: ["greeting"] },
  { id: "g2", input: "hi there", expected: "hi back", tags: ["greeting"] },
  { id: "q1", input: "what is 2+2?", expected: "4", tags: ["math"] },
  { id: "q2", input: "what is 3+3?", expected: "6", tags: ["math"] },
  {
    id: "s1",
    input: "summarize this document",
    expected: "summary of document",
    tags: ["summarization"],
  },
];

function makeProvider(outputMap: Record<string, string>) {
  return createMockProvider({
    outputMap: new Map(Object.entries(outputMap)),
    latencyMs: 1,
    latencyJitterMs: 0,
  });
}

// ============================================================
// Unit Tests
// ============================================================

describe("Unit Tests", () => {
  describe("EvalHarness — core logic", () => {
    it("runs all cases and returns per-case results", async () => {
      const provider = makeProvider({
        hello: "hello back",
        "hi there": "hi back",
        "what is 2+2?": "4",
        "what is 3+3?": "6",
        "summarize this document": "summary of document",
      });

      const harness = new EvalHarness({
        dataset: DATASET,
        scorers: [exactMatchScorer()],
        provider,
      });

      const result = await harness.run();

      expect(result.results).toHaveLength(5);
      expect(result.runId).toMatch(/^eval-/);
      expect(result.timestamp).toBeTruthy();
      expect(result.durationMs).toBeGreaterThan(0);
    });

    it("computes correct aggregate scores", async () => {
      const provider = makeProvider({
        hello: "hello back",
        "hi there": "WRONG",
        "what is 2+2?": "4",
        "what is 3+3?": "WRONG",
        "summarize this document": "summary of document",
      });

      const harness = new EvalHarness({
        dataset: DATASET,
        scorers: [exactMatchScorer()],
        provider,
      });

      const result = await harness.run();

      // 3 out of 5 correct
      expect(result.aggregate.overall["exact_match"]).toBeCloseTo(0.6, 5);
      expect(result.aggregate.passRate).toBeCloseTo(0.6, 5);
    });

    it("computes per-tag aggregates", async () => {
      const provider = makeProvider({
        hello: "hello back",
        "hi there": "WRONG",
        "what is 2+2?": "4",
        "what is 3+3?": "6",
        "summarize this document": "summary of document",
      });

      const harness = new EvalHarness({
        dataset: DATASET,
        scorers: [exactMatchScorer()],
        provider,
      });

      const result = await harness.run();

      // Greeting: 1/2 correct
      expect(result.aggregate.byTag["greeting"]["exact_match"]).toBeCloseTo(
        0.5,
        5
      );
      // Math: 2/2 correct
      expect(result.aggregate.byTag["math"]["exact_match"]).toBeCloseTo(
        1.0,
        5
      );
    });

    it("filters cases by tags", async () => {
      const provider = makeProvider({
        "what is 2+2?": "4",
        "what is 3+3?": "6",
      });

      const harness = new EvalHarness({
        dataset: DATASET,
        scorers: [exactMatchScorer()],
        provider,
        tags: ["math"],
      });

      const result = await harness.run();

      expect(result.results).toHaveLength(2);
      expect(result.results.every((r) => r.tags?.includes("math"))).toBe(true);
    });

    it("throws when no cases match tag filter", async () => {
      const provider = makeProvider({});
      const harness = new EvalHarness({
        dataset: DATASET,
        scorers: [exactMatchScorer()],
        provider,
        tags: ["nonexistent"],
      });

      await expect(harness.run()).rejects.toThrow("No eval cases to run");
    });
  });

  describe("Scorers", () => {
    it("exactMatchScorer handles case insensitivity", async () => {
      const scorer = exactMatchScorer(false);
      const result = await scorer.score("q", "Hello World", "hello world");
      expect(result.score).toBe(1);
      expect(result.pass).toBe(true);
    });

    it("exactMatchScorer respects case sensitivity", async () => {
      const scorer = exactMatchScorer(true);
      const result = await scorer.score("q", "Hello World", "hello world");
      expect(result.score).toBe(0);
      expect(result.pass).toBe(false);
    });

    it("containsScorer finds substring", async () => {
      const scorer = containsScorer();
      const result = await scorer.score(
        "q",
        "The answer is 42.",
        "42"
      );
      expect(result.pass).toBe(true);
    });

    it("containsScorer fails when substring missing", async () => {
      const scorer = containsScorer();
      const result = await scorer.score(
        "q",
        "The answer is unknown.",
        "42"
      );
      expect(result.pass).toBe(false);
    });

    it("lengthScorer scores within range", async () => {
      const scorer = lengthScorer(2, 50);
      const result = await scorer.score("q", "this has several words in it");
      expect(result.pass).toBe(true);
      expect(result.score).toBe(1);
    });

    it("lengthScorer penalizes too-short output", async () => {
      const scorer = lengthScorer(10, 500);
      const result = await scorer.score("q", "short");
      expect(result.pass).toBe(false);
      expect(result.score).toBeLessThan(1);
    });

    it("customScorer wraps arbitrary function", async () => {
      const scorer = customScorer(
        "sentiment",
        (_input, output) => (output.includes("great") ? 1 : 0),
        0.5
      );

      const pass = await scorer.score("q", "this is great");
      expect(pass.pass).toBe(true);

      const fail = await scorer.score("q", "this is terrible");
      expect(fail.pass).toBe(false);
    });

    it("customScorer clamps score to 0-1 range", async () => {
      const scorer = customScorer("overflow", () => 1.5);
      const result = await scorer.score("q", "output");
      expect(result.score).toBe(1);
    });

    it("scorers return reason when no expected output", async () => {
      const scorer = exactMatchScorer();
      const result = await scorer.score("q", "output", undefined);
      expect(result.score).toBe(0);
      expect(result.reason).toContain("No expected output");
    });
  });

  describe("Comparison", () => {
    it("detects regressions", async () => {
      const goodProvider = makeProvider({
        hello: "hello back",
        "hi there": "hi back",
        "what is 2+2?": "4",
        "what is 3+3?": "6",
        "summarize this document": "summary of document",
      });

      const badProvider = makeProvider({
        hello: "WRONG",
        "hi there": "WRONG",
        "what is 2+2?": "4",
        "what is 3+3?": "6",
        "summarize this document": "summary of document",
      });

      const harness = new EvalHarness({
        dataset: DATASET,
        scorers: [exactMatchScorer()],
        provider: goodProvider,
        regressionTolerance: 0.05,
      });

      const baseline = await harness.run();

      // Swap to bad provider for current run
      const harness2 = new EvalHarness({
        dataset: DATASET,
        scorers: [exactMatchScorer()],
        provider: badProvider,
        regressionTolerance: 0.05,
      });

      const current = await harness2.run();
      const comparison = harness.compare(baseline, current);

      expect(comparison.passed).toBe(false);
      expect(comparison.regressions.length).toBeGreaterThan(0);
      expect(comparison.overallDelta["exact_match"]).toBeLessThan(0);
    });

    it("detects improvements", async () => {
      const badProvider = makeProvider({
        hello: "WRONG",
        "hi there": "WRONG",
        "what is 2+2?": "4",
        "what is 3+3?": "6",
        "summarize this document": "summary of document",
      });

      const goodProvider = makeProvider({
        hello: "hello back",
        "hi there": "hi back",
        "what is 2+2?": "4",
        "what is 3+3?": "6",
        "summarize this document": "summary of document",
      });

      const harness = new EvalHarness({
        dataset: DATASET,
        scorers: [exactMatchScorer()],
        provider: badProvider,
        regressionTolerance: 0.05,
      });

      const baseline = await harness.run();

      const harness2 = new EvalHarness({
        dataset: DATASET,
        scorers: [exactMatchScorer()],
        provider: goodProvider,
        regressionTolerance: 0.05,
      });

      const current = await harness2.run();
      const comparison = harness.compare(baseline, current);

      expect(comparison.passed).toBe(true);
      expect(comparison.improvements.length).toBeGreaterThan(0);
    });

    it("detects per-tag regressions while overall improves", async () => {
      // Baseline: greeting good, math bad
      const baselineProvider = makeProvider({
        hello: "hello back",
        "hi there": "hi back",
        "what is 2+2?": "WRONG",
        "what is 3+3?": "WRONG",
        "summarize this document": "summary of document",
      });

      // Current: greeting bad, math good — overall same, but greeting regressed
      const currentProvider = makeProvider({
        hello: "WRONG",
        "hi there": "WRONG",
        "what is 2+2?": "4",
        "what is 3+3?": "6",
        "summarize this document": "summary of document",
      });

      const harness = new EvalHarness({
        dataset: DATASET,
        scorers: [exactMatchScorer()],
        provider: baselineProvider,
        regressionTolerance: 0.05,
      });

      const baseline = await harness.run();

      const harness2 = new EvalHarness({
        dataset: DATASET,
        scorers: [exactMatchScorer()],
        provider: currentProvider,
        regressionTolerance: 0.05,
      });

      const current = await harness2.run();
      const comparison = harness.compare(baseline, current);

      // Greeting should show a regression
      const greetingRegression = comparison.regressions.find(
        (r) => r.tag === "greeting"
      );
      expect(greetingRegression).toBeDefined();
      expect(greetingRegression!.delta).toBeLessThan(0);

      // Math should show an improvement
      const mathImprovement = comparison.improvements.find(
        (i) => i.tag === "math"
      );
      expect(mathImprovement).toBeDefined();
    });

    it("passes when delta is within tolerance", async () => {
      const provider = makeProvider({
        hello: "hello back",
        "hi there": "hi back",
        "what is 2+2?": "4",
        "what is 3+3?": "6",
        "summarize this document": "summary of document",
      });

      const harness = new EvalHarness({
        dataset: DATASET,
        scorers: [exactMatchScorer()],
        provider,
        regressionTolerance: 0.05,
      });

      const run1 = await harness.run();
      const run2 = await harness.run();
      const comparison = harness.compare(run1, run2);

      expect(comparison.passed).toBe(true);
      expect(comparison.regressions).toHaveLength(0);
    });
  });

  describe("passes() threshold check", () => {
    it("returns true when all scorer averages meet threshold", async () => {
      const provider = makeProvider({
        hello: "hello back",
        "hi there": "hi back",
        "what is 2+2?": "4",
        "what is 3+3?": "6",
        "summarize this document": "summary of document",
      });

      const harness = new EvalHarness({
        dataset: DATASET,
        scorers: [exactMatchScorer()],
        provider,
        threshold: 0.8,
      });

      const result = await harness.run();
      expect(harness.passes(result)).toBe(true);
    });

    it("returns false when scorer average is below threshold", async () => {
      const provider = makeProvider({
        hello: "WRONG",
        "hi there": "WRONG",
        "what is 2+2?": "WRONG",
        "what is 3+3?": "WRONG",
        "summarize this document": "WRONG",
      });

      const harness = new EvalHarness({
        dataset: DATASET,
        scorers: [exactMatchScorer()],
        provider,
        threshold: 0.5,
      });

      const result = await harness.run();
      expect(harness.passes(result)).toBe(false);
    });
  });
});

// ============================================================
// Failure Mode Tests
// ============================================================

describe("Failure Mode Tests", () => {
  it("FM: stale dataset — detects missing tag coverage", async () => {
    // Simulate stale dataset: only greeting cases, no math
    const staleDataset: EvalCase[] = [
      { id: "g1", input: "hello", expected: "hello back", tags: ["greeting"] },
      { id: "g2", input: "hi there", expected: "hi back", tags: ["greeting"] },
    ];

    const provider = makeProvider({
      hello: "hello back",
      "hi there": "hi back",
    });

    const harness = new EvalHarness({
      dataset: staleDataset,
      scorers: [exactMatchScorer()],
      provider,
    });

    const result = await harness.run();

    // Dataset only covers "greeting" — no "math" or "summarization" tags
    const coveredTags = Object.keys(result.aggregate.byTag);
    expect(coveredTags).toContain("greeting");
    expect(coveredTags).not.toContain("math");
    // Detection signal: tag distribution doesn't match production
  });

  it("FM: overfitted threshold — low threshold hides regressions", async () => {
    const provider = makeProvider({
      hello: "WRONG",
      "hi there": "WRONG",
      "what is 2+2?": "4",
      "what is 3+3?": "6",
      "summarize this document": "WRONG",
    });

    // Very low threshold — passes despite 40% failure
    const lenientHarness = new EvalHarness({
      dataset: DATASET,
      scorers: [exactMatchScorer()],
      provider,
      threshold: 0.3,
    });

    const result = await lenientHarness.run();
    expect(lenientHarness.passes(result)).toBe(true);

    // Reasonable threshold — correctly fails
    const strictHarness = new EvalHarness({
      dataset: DATASET,
      scorers: [exactMatchScorer()],
      provider,
      threshold: 0.7,
    });

    expect(strictHarness.passes(result)).toBe(false);
  });

  it("FM: LLM-judge drift — golden case divergence detection", async () => {
    // Simulate a scorer that changes behavior (judge drift)
    let judgeVersion = 1;

    const driftingJudge: Scorer = {
      name: "llm_judge",
      score: async (_input, output, expected) => {
        if (judgeVersion === 1) {
          // V1: strict matching
          const match = output === expected;
          return { score: match ? 1 : 0, pass: match };
        } else {
          // V2: lenient — always passes (simulating judge becoming sycophantic)
          return { score: 1, pass: true };
        }
      },
    };

    // Golden cases with known scores
    const goldenCases: EvalCase[] = [
      {
        id: "golden-1",
        input: "test",
        expected: "correct answer",
        tags: ["golden"],
      },
    ];

    const wrongProvider = makeProvider({ test: "wrong answer" });

    const harness = new EvalHarness({
      dataset: goldenCases,
      scorers: [driftingJudge],
      provider: wrongProvider,
    });

    // V1: golden case correctly scores 0
    judgeVersion = 1;
    const v1Result = await harness.run();
    expect(v1Result.aggregate.overall["llm_judge"]).toBe(0);

    // V2: judge drifted — same wrong answer now scores 1
    judgeVersion = 2;
    const v2Result = await harness.run();
    expect(v2Result.aggregate.overall["llm_judge"]).toBe(1);

    // Detect drift: golden score diverged by 1.0
    const drift = Math.abs(
      v2Result.aggregate.overall["llm_judge"] -
        v1Result.aggregate.overall["llm_judge"]
    );
    expect(drift).toBeGreaterThan(0.1);
  });

  it("FM: non-determinism masking — high variance hides regressions", async () => {
    // Simulate non-deterministic provider
    let callIndex = 0;
    const nondeterministicProvider = createMockProvider({
      latencyMs: 1,
      latencyJitterMs: 0,
      defaultOutput: "variable response",
    });

    // Custom scorer that simulates variance
    const noisyScorer: Scorer = {
      name: "noisy",
      score: async () => {
        callIndex++;
        // Alternate between high and low scores
        const score = callIndex % 2 === 0 ? 0.9 : 0.3;
        return { score, pass: score > 0.5 };
      },
    };

    const harness = new EvalHarness({
      dataset: DATASET,
      scorers: [noisyScorer],
      provider: nondeterministicProvider,
    });

    // Multiple runs produce different aggregates
    callIndex = 0;
    const run1 = await harness.run();
    const run1Score = run1.aggregate.overall["noisy"];

    callIndex = 0;
    const run2 = await harness.run();
    const run2Score = run2.aggregate.overall["noisy"];

    // Both runs should produce scores, but the comparison
    // shows how variance affects regression detection
    expect(typeof run1Score).toBe("number");
    expect(typeof run2Score).toBe("number");
  });

  it("FM: silent baseline rot — genesis vs rolling baseline divergence", async () => {
    // Genesis: high quality
    const goodProvider = makeProvider({
      hello: "hello back",
      "hi there": "hi back",
      "what is 2+2?": "4",
      "what is 3+3?": "6",
      "summarize this document": "summary of document",
    });

    const harness = new EvalHarness({
      dataset: DATASET,
      scorers: [exactMatchScorer()],
      provider: goodProvider,
      regressionTolerance: 0.05,
    });

    const genesis = await harness.run();

    // Slightly worse — passes rolling comparison
    const slightlyWorse = makeProvider({
      hello: "hello back",
      "hi there": "hi back",
      "what is 2+2?": "4",
      "what is 3+3?": "6",
      "summarize this document": "WRONG", // 1/5 degraded
    });

    const harness2 = new EvalHarness({
      dataset: DATASET,
      scorers: [exactMatchScorer()],
      provider: slightlyWorse,
      regressionTolerance: 0.25, // wide tolerance
    });

    const cycle1 = await harness2.run();
    const rollingComparison = harness.compare(genesis, cycle1);

    // Even worse — but compare against cycle1 (rolled baseline)
    const worse = makeProvider({
      hello: "WRONG",
      "hi there": "hi back",
      "what is 2+2?": "4",
      "what is 3+3?": "6",
      "summarize this document": "WRONG",
    });

    const harness3 = new EvalHarness({
      dataset: DATASET,
      scorers: [exactMatchScorer()],
      provider: worse,
      regressionTolerance: 0.25,
    });

    const cycle2 = await harness3.run();

    // Compare cycle2 against rolled baseline (cycle1) — small delta, passes
    const rollingComp = harness.compare(cycle1, cycle2);

    // Compare cycle2 against genesis — large delta, fails
    const genesisHarness = new EvalHarness({
      dataset: DATASET,
      scorers: [exactMatchScorer()],
      provider: worse,
      regressionTolerance: 0.05, // strict tolerance for genesis comparison
    });

    const genesisComp = genesisHarness.compare(genesis, cycle2);

    // Rolling baseline hides the cumulative regression
    // Genesis baseline catches it
    expect(genesisComp.regressions.length).toBeGreaterThan(0);
    expect(genesisComp.overallDelta["exact_match"]).toBeLessThan(-0.05);
  });

  it("FM: scorer disagreement — conflicting signals from multiple scorers", async () => {
    const provider = makeProvider({
      hello: "hllo bck", // misspelled but contains the right concept
    });

    const dataset: EvalCase[] = [
      { id: "1", input: "hello", expected: "hello back", tags: ["greeting"] },
    ];

    const harness = new EvalHarness({
      dataset,
      scorers: [
        exactMatchScorer(), // strict: will fail
        containsScorer(), // will fail (doesn't contain "hello back" exactly)
        customScorer("always_pass", () => 1), // lenient: always passes
      ],
      provider,
    });

    const result = await harness.run();

    // exact_match and contains disagree with always_pass
    const exactScore = result.results[0].scores["exact_match"].pass;
    const alwaysScore = result.results[0].scores["always_pass"].pass;

    expect(exactScore).toBe(false);
    expect(alwaysScore).toBe(true);
    // Detection: scorers disagree on >30% of cases
  });
});

// ============================================================
// Integration Tests
// ============================================================

describe("Integration Tests", () => {
  it("full flow: run → compare → regression gate", async () => {
    // Baseline run: all correct
    const baseProvider = makeProvider({
      hello: "hello back",
      "hi there": "hi back",
      "what is 2+2?": "4",
      "what is 3+3?": "6",
      "summarize this document": "summary of document",
    });

    const baseHarness = new EvalHarness({
      dataset: DATASET,
      scorers: [exactMatchScorer(), containsScorer()],
      provider: baseProvider,
      threshold: 0.8,
      regressionTolerance: 0.05,
    });

    const baseline = await baseHarness.run();
    expect(baseHarness.passes(baseline)).toBe(true);

    // Current run: greeting degraded
    const currentProvider = makeProvider({
      hello: "WRONG",
      "hi there": "WRONG",
      "what is 2+2?": "4",
      "what is 3+3?": "6",
      "summarize this document": "summary of document",
    });

    const currentHarness = new EvalHarness({
      dataset: DATASET,
      scorers: [exactMatchScorer(), containsScorer()],
      provider: currentProvider,
      threshold: 0.8,
      regressionTolerance: 0.05,
    });

    const current = await currentHarness.run();
    const comparison = baseHarness.compare(baseline, current);

    // Regression gate should fail
    expect(comparison.passed).toBe(false);
    expect(comparison.regressions.length).toBeGreaterThan(0);

    // Should have tag-level regression for greeting
    const greetingReg = comparison.regressions.find(
      (r) => r.tag === "greeting"
    );
    expect(greetingReg).toBeDefined();
  });

  it("concurrent processing respects concurrency limit", async () => {
    const dataset: EvalCase[] = Array.from({ length: 20 }, (_, i) => ({
      id: `case-${i}`,
      input: `input-${i}`,
      expected: `output-${i}`,
      tags: ["load"],
    }));

    const outputMap = new Map(
      dataset.map((c) => [c.input, c.expected!])
    );

    const provider = createMockProvider({
      outputMap,
      latencyMs: 10,
      latencyJitterMs: 0,
    });

    const harness = new EvalHarness({
      dataset,
      scorers: [exactMatchScorer()],
      provider,
      concurrency: 3,
    });

    const result = await harness.run();

    expect(result.results).toHaveLength(20);
    expect(result.aggregate.overall["exact_match"]).toBe(1);
  });

  it("handles provider errors gracefully per case", async () => {
    const provider = createMockProvider({
      errorRate: 0.5, // 50% failure rate
      latencyMs: 1,
      latencyJitterMs: 0,
      defaultOutput: "success response",
    });

    const dataset: EvalCase[] = Array.from({ length: 10 }, (_, i) => ({
      id: `err-${i}`,
      input: `input-${i}`,
      tags: ["error-test"],
    }));

    const harness = new EvalHarness({
      dataset,
      scorers: [
        customScorer("non_empty", (_i, output) => (output.length > 0 ? 1 : 0)),
      ],
      provider,
    });

    const result = await harness.run();

    // All 10 cases should have results (errors scored as 0)
    expect(result.results).toHaveLength(10);

    // Some should have failed (score 0 due to provider error)
    const failedCases = result.results.filter(
      (r) => r.scores["non_empty"]?.score === 0
    );
    expect(failedCases.length).toBeGreaterThan(0);

    // Failed cases should have error reason
    for (const fc of failedCases) {
      expect(fc.scores["non_empty"].reason).toContain("Provider error");
    }
  });

  it("handles per-case timeout", async () => {
    const hangProvider = createMockProvider({
      hangForever: true,
    });

    const dataset: EvalCase[] = [
      { id: "timeout-1", input: "will timeout" },
    ];

    const harness = new EvalHarness({
      dataset,
      scorers: [exactMatchScorer()],
      provider: hangProvider,
      timeoutMs: 100,
    });

    const result = await harness.run();

    expect(result.results).toHaveLength(1);
    expect(result.results[0].scores["exact_match"].score).toBe(0);
    expect(result.results[0].scores["exact_match"].reason).toContain(
      "timed out"
    );
  });

  it("multi-scorer evaluation with mixed results", async () => {
    const provider = makeProvider({
      "what is the capital of France?": "The capital of France is Paris.",
    });

    const dataset: EvalCase[] = [
      {
        id: "geo-1",
        input: "what is the capital of France?",
        expected: "Paris",
        tags: ["geography"],
      },
    ];

    const harness = new EvalHarness({
      dataset,
      scorers: [
        exactMatchScorer(), // Will fail (output includes more than just "Paris")
        containsScorer(), // Will pass (output contains "Paris")
        lengthScorer(3, 20), // Will pass (reasonable length)
      ],
      provider,
    });

    const result = await harness.run();
    const scores = result.results[0].scores;

    expect(scores["exact_match"].pass).toBe(false);
    expect(scores["contains"].pass).toBe(true);
    expect(scores["length"].pass).toBe(true);
  });
});

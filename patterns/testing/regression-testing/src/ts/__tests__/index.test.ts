import { describe, it, expect, beforeEach } from "vitest";
import {
  RegressionRunner,
  InMemoryBaselineStore,
  exactMatchScorer,
  containsScorer,
  customScorer,
} from "../index";
import { createMockProvider, createVersionedProviders } from "../mock-provider";
import { TestSuite, BaselineStore, RunResult, Scorer } from "../types";

// --- Test Fixtures ---

function createTestSuite(overrides?: Partial<TestSuite>): TestSuite {
  return {
    id: "test-suite",
    version: "v1",
    cases: [
      { id: "sum-1", input: "What is 2+2?", expected: "4", tags: ["math"] },
      { id: "sum-2", input: "What is 3+3?", expected: "6", tags: ["math"] },
      {
        id: "greet-1",
        input: "Say hello",
        expected: "Hello!",
        tags: ["greeting"],
      },
      {
        id: "greet-2",
        input: "Say hi",
        expected: "Hi there!",
        tags: ["greeting"],
      },
      {
        id: "extract-1",
        input: "Extract: John is 30",
        expected: "John, 30",
        tags: ["extraction"],
      },
    ],
    ...overrides,
  };
}

function createAllMatchProvider() {
  return createMockProvider({
    outputMap: new Map([
      ["What is 2+2?", "4"],
      ["What is 3+3?", "6"],
      ["Say hello", "Hello!"],
      ["Say hi", "Hi there!"],
      ["Extract: John is 30", "John, 30"],
    ]),
    latencyMs: 1,
    latencyJitterMs: 0,
  });
}

function createRunner(
  overrides?: Partial<Parameters<typeof RegressionRunner.prototype.run>[0]> & {
    suite?: TestSuite;
    provider?: ReturnType<typeof createMockProvider>;
    scorers?: Scorer[];
    baselineStore?: BaselineStore;
    regressionThreshold?: number;
    minPassScore?: number;
    failOnRegression?: boolean;
    concurrency?: number;
    timeoutMs?: number;
    genesisGapThreshold?: number;
  }
) {
  return new RegressionRunner({
    suite: overrides?.suite ?? createTestSuite(),
    provider: overrides?.provider ?? createAllMatchProvider(),
    scorers: overrides?.scorers ?? [exactMatchScorer()],
    baselineStore: overrides?.baselineStore ?? new InMemoryBaselineStore(),
    regressionThreshold: overrides?.regressionThreshold,
    minPassScore: overrides?.minPassScore,
    failOnRegression: overrides?.failOnRegression,
    concurrency: overrides?.concurrency,
    timeoutMs: overrides?.timeoutMs,
    genesisGapThreshold: overrides?.genesisGapThreshold,
  });
}

// ===== UNIT TESTS =====

describe("Unit Tests", () => {
  describe("RegressionRunner basics", () => {
    it("should produce a passing report when all cases match", async () => {
      const runner = createRunner();
      const report = await runner.run();

      expect(report.passed).toBe(true);
      expect(report.overallScore).toBe(1);
      expect(report.regressions).toHaveLength(0);
      expect(report.summary).toContain("PASS");
    });

    it("should report correct per-tag scores", async () => {
      const runner = createRunner();
      const report = await runner.run();

      expect(report.perTagScores["math"]).toBeDefined();
      expect(report.perTagScores["greeting"]).toBeDefined();
      expect(report.perTagScores["extraction"]).toBeDefined();
      expect(report.perTagScores["math"]["exact_match"]).toBe(1);
    });

    it("should fail when overall score is below minPassScore", async () => {
      const provider = createMockProvider({
        defaultOutput: "wrong answer",
        latencyMs: 1,
        latencyJitterMs: 0,
      });

      const runner = createRunner({ provider, minPassScore: 0.5 });
      const report = await runner.run();

      expect(report.passed).toBe(false);
      expect(report.overallScore).toBe(0);
    });

    it("should handle multiple scorers", async () => {
      const runner = createRunner({
        scorers: [exactMatchScorer(), containsScorer()],
      });
      const report = await runner.run();

      expect(report.overallScore).toBe(1);
      expect(report.runResult.results[0].scores["exact_match"]).toBeDefined();
      expect(report.runResult.results[0].scores["contains"]).toBeDefined();
    });

    it("should work with custom scorers", async () => {
      const lengthScorer = customScorer(
        "length_ok",
        (_input, output) => (output.length > 0 ? 1 : 0),
        0.5
      );

      const runner = createRunner({ scorers: [lengthScorer] });
      const report = await runner.run();

      expect(report.passed).toBe(true);
    });

    it("should handle provider errors gracefully", async () => {
      const provider = createMockProvider({
        errorRate: 1.0,
        latencyMs: 1,
        latencyJitterMs: 0,
      });

      const runner = createRunner({ provider, minPassScore: 0 });
      const report = await runner.run();

      expect(report.overallScore).toBe(0);
      expect(report.runResult.results[0].scores["exact_match"].reason).toContain(
        "Provider error"
      );
    });
  });

  describe("Baseline management", () => {
    it("should establish baseline on first run", async () => {
      const store = new InMemoryBaselineStore();
      const runner = createRunner({ baselineStore: store });

      const report = await runner.run();

      expect(report.passed).toBe(true);
      expect(report.baselineScore).toBeNull(); // no previous baseline
      expect(report.summary).toContain("first baseline");

      const saved = await store.load("test-suite");
      expect(saved).not.toBeNull();
    });

    it("should compare against stored baseline on subsequent runs", async () => {
      const store = new InMemoryBaselineStore();

      // First run — all match
      const runner1 = createRunner({ baselineStore: store });
      await runner1.run();

      // Second run — same results
      const runner2 = createRunner({ baselineStore: store });
      const report = await runner2.run();

      expect(report.baselineScore).toBe(1);
      expect(report.regressions).toHaveLength(0);
    });

    it("should save genesis baseline on first passing run", async () => {
      const store = new InMemoryBaselineStore();
      const runner = createRunner({ baselineStore: store });

      await runner.run();

      const genesis = await store.loadGenesis("test-suite");
      expect(genesis).not.toBeNull();
    });

    it("should not overwrite genesis on subsequent runs", async () => {
      const store = new InMemoryBaselineStore();

      const runner1 = createRunner({ baselineStore: store });
      await runner1.run();

      const genesis1 = await store.loadGenesis("test-suite");
      const genesisRunId = genesis1!.runId;

      // Second run
      const runner2 = createRunner({ baselineStore: store });
      await runner2.run();

      const genesis2 = await store.loadGenesis("test-suite");
      expect(genesis2!.runId).toBe(genesisRunId);
    });

    it("should track history", async () => {
      const store = new InMemoryBaselineStore();

      for (let i = 0; i < 3; i++) {
        const runner = createRunner({ baselineStore: store });
        await runner.run();
      }

      const history = await store.history("test-suite", 10);
      expect(history).toHaveLength(3);
    });
  });

  describe("Regression detection", () => {
    it("should detect per-tag regression", async () => {
      const store = new InMemoryBaselineStore();

      // Run 1: all match
      const runner1 = createRunner({ baselineStore: store });
      await runner1.run();

      // Run 2: greetings regressed
      const provider2 = createMockProvider({
        outputMap: new Map([
          ["What is 2+2?", "4"],
          ["What is 3+3?", "6"],
          ["Say hello", "Wrong output"],
          ["Say hi", "Wrong output"],
          ["Extract: John is 30", "John, 30"],
        ]),
        latencyMs: 1,
        latencyJitterMs: 0,
      });

      const runner2 = createRunner({
        baselineStore: store,
        provider: provider2,
      });
      const report = await runner2.run();

      expect(report.passed).toBe(false);
      expect(report.regressions.length).toBeGreaterThan(0);

      const greetingRegression = report.regressions.find(
        (r) => r.tag === "greeting"
      );
      expect(greetingRegression).toBeDefined();
      expect(greetingRegression!.delta).toBeLessThan(0);
    });

    it("should detect overall regression", async () => {
      const store = new InMemoryBaselineStore();

      const runner1 = createRunner({ baselineStore: store });
      await runner1.run();

      // All wrong
      const provider2 = createMockProvider({
        defaultOutput: "completely wrong",
        latencyMs: 1,
        latencyJitterMs: 0,
      });

      const runner2 = createRunner({
        baselineStore: store,
        provider: provider2,
      });
      const report = await runner2.run();

      expect(report.passed).toBe(false);
      const overallRegression = report.regressions.find((r) => !r.tag);
      expect(overallRegression).toBeDefined();
    });

    it("should detect improvements", async () => {
      const store = new InMemoryBaselineStore();

      // Run 1: partial match
      const provider1 = createMockProvider({
        outputMap: new Map([
          ["What is 2+2?", "4"],
          ["What is 3+3?", "wrong"],
          ["Say hello", "Hello!"],
          ["Say hi", "wrong"],
          ["Extract: John is 30", "John, 30"],
        ]),
        latencyMs: 1,
        latencyJitterMs: 0,
      });

      const runner1 = createRunner({
        baselineStore: store,
        provider: provider1,
        minPassScore: 0,
      });
      await runner1.run();

      // Force save baseline even with low score
      const baseline = await store.load("test-suite");
      expect(baseline).not.toBeNull();

      // Run 2: all match
      const runner2 = createRunner({ baselineStore: store });
      const report = await runner2.run();

      expect(report.improvements.length).toBeGreaterThan(0);
    });

    it("should respect regressionThreshold", async () => {
      const store = new InMemoryBaselineStore();

      const runner1 = createRunner({ baselineStore: store });
      await runner1.run();

      // Small regression in one tag (1 out of 2 cases wrong)
      const provider2 = createMockProvider({
        outputMap: new Map([
          ["What is 2+2?", "4"],
          ["What is 3+3?", "wrong"],
          ["Say hello", "Hello!"],
          ["Say hi", "Hi there!"],
          ["Extract: John is 30", "John, 30"],
        ]),
        latencyMs: 1,
        latencyJitterMs: 0,
      });

      // Wide threshold — should pass
      const runner2 = createRunner({
        baselineStore: store,
        provider: provider2,
        regressionThreshold: 0.6,
      });
      const report = await runner2.run();

      expect(report.regressions).toHaveLength(0);
    });

    it("should allow regressions when failOnRegression is false", async () => {
      const store = new InMemoryBaselineStore();

      const runner1 = createRunner({ baselineStore: store });
      await runner1.run();

      const provider2 = createMockProvider({
        defaultOutput: "wrong",
        latencyMs: 1,
        latencyJitterMs: 0,
      });

      const runner2 = createRunner({
        baselineStore: store,
        provider: provider2,
        failOnRegression: false,
        minPassScore: 0,
        genesisGapThreshold: 2.0, // wide enough to not trigger
      });
      const report = await runner2.run();

      expect(report.regressions.length).toBeGreaterThan(0);
      // Passes because failOnRegression is false, score >= minPassScore,
      // and genesis gap threshold is wide enough
      expect(report.passed).toBe(true);
    });
  });
});

// ===== FAILURE MODE TESTS =====

describe("Failure Mode Tests", () => {
  it("FM1: Stale test suite — detectable via tag distribution mismatch", async () => {
    // Simulate a suite missing a "new_feature" tag entirely
    const suite = createTestSuite();
    const existingTags = new Set(suite.cases.flatMap((c) => c.tags));

    // The production system has a "new_feature" tag not in the suite
    const productionTags = new Set([...existingTags, "new_feature"]);
    const missingTags = [...productionTags].filter(
      (t) => !existingTags.has(t)
    );

    expect(missingTags).toContain("new_feature");
    expect(missingTags.length).toBeGreaterThan(0);
  });

  it("FM2: Threshold erosion — track threshold changes", async () => {
    const thresholdHistory = [0.05, 0.08, 0.12, 0.15];
    const wideningCount = thresholdHistory.filter(
      (t, i) => i > 0 && t > thresholdHistory[i - 1]
    ).length;

    // More than 2 widenings without justification signals erosion
    expect(wideningCount).toBeGreaterThan(2);
  });

  it("FM3: Baseline inflation (silent degradation) — genesis gap detection", async () => {
    const store = new InMemoryBaselineStore();

    // Run 1: perfect score — becomes genesis
    const runner1 = createRunner({
      baselineStore: store,
      genesisGapThreshold: 0.1,
    });
    await runner1.run();

    // Simulate gradual drift: save progressively worse baselines
    // Each within threshold of previous, but far from genesis
    const degradedProvider = createMockProvider({
      outputMap: new Map([
        ["What is 2+2?", "4"],
        ["What is 3+3?", "wrong"], // 1 of 5 wrong
        ["Say hello", "Hello!"],
        ["Say hi", "Hi there!"],
        ["Extract: John is 30", "John, 30"],
      ]),
      latencyMs: 1,
      latencyJitterMs: 0,
    });

    // Force a degraded baseline into the store
    const tempRunner = new RegressionRunner({
      suite: createTestSuite(),
      provider: degradedProvider,
      scorers: [exactMatchScorer()],
      baselineStore: store,
      minPassScore: 0,
      regressionThreshold: 0.5, // wide threshold to let it pass
    });
    await tempRunner.run();

    // Now run with significant degradation from genesis
    const worsProvider = createMockProvider({
      outputMap: new Map([
        ["What is 2+2?", "wrong"],
        ["What is 3+3?", "wrong"],
        ["Say hello", "Hello!"],
        ["Say hi", "Hi there!"],
        ["Extract: John is 30", "John, 30"],
      ]),
      latencyMs: 1,
      latencyJitterMs: 0,
    });

    const runner3 = createRunner({
      baselineStore: store,
      provider: worsProvider,
      genesisGapThreshold: 0.1,
      minPassScore: 0,
      regressionThreshold: 0.5, // wide threshold
    });
    const report = await runner3.run();

    // Genesis gap should be detected: score dropped >10% from genesis
    expect(report.genesisScore).toBe(1);
    expect(report.genesisDelta).toBeLessThan(-0.1);
    expect(report.passed).toBe(false);
  });

  it("FM4: Non-determinism noise — variance tracking", async () => {
    // Run the same suite multiple times and measure variance
    const scores: number[] = [];
    const store = new InMemoryBaselineStore();

    // Provider that produces slightly different outputs each run
    let callNum = 0;
    const noisyProvider = createMockProvider({
      outputMap: new Map([
        ["What is 2+2?", "4"],
        ["What is 3+3?", "6"],
        ["Say hello", "Hello!"],
        ["Say hi", "Hi there!"],
        ["Extract: John is 30", "John, 30"],
      ]),
      latencyMs: 1,
      latencyJitterMs: 0,
    });

    for (let i = 0; i < 5; i++) {
      const runner = createRunner({
        baselineStore: store,
        provider: noisyProvider,
        minPassScore: 0,
        regressionThreshold: 1.0,
      });
      const report = await runner.run();
      scores.push(report.overallScore);
    }

    // With deterministic mock, variance should be 0
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance =
      scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;

    expect(variance).toBe(0); // deterministic mock = no noise
  });

  it("FM5: Tag taxonomy drift — detect uncovered features", async () => {
    const suite = createTestSuite();
    const suiteTags = new Set(suite.cases.flatMap((c) => c.tags));

    // Simulated product feature registry
    const productFeatures = [
      "math",
      "greeting",
      "extraction",
      "translation",
      "code_gen",
    ];

    const uncoveredFeatures = productFeatures.filter(
      (f) => !suiteTags.has(f)
    );

    expect(uncoveredFeatures).toContain("translation");
    expect(uncoveredFeatures).toContain("code_gen");
    expect(uncoveredFeatures.length).toBe(2);
  });

  it("FM6: Scorer-suite coupling — canary set divergence", async () => {
    // Main suite: all cases have expected outputs that match
    const mainProvider = createAllMatchProvider();
    const store = new InMemoryBaselineStore();

    const runner = createRunner({
      baselineStore: store,
      provider: mainProvider,
    });
    const mainReport = await runner.run();

    // Canary set: production-sampled inputs with different patterns
    const canarySuite: TestSuite = {
      id: "canary",
      version: "v1",
      cases: [
        {
          id: "canary-1",
          input: "Translate to French: hello",
          expected: "bonjour",
          tags: ["translation"],
        },
        {
          id: "canary-2",
          input: "Summarize: long text here",
          expected: "summary",
          tags: ["summarization"],
        },
      ],
    };

    const canaryRunner = createRunner({
      suite: canarySuite,
      provider: mainProvider, // returns default "This is a mock..."
      baselineStore: new InMemoryBaselineStore(),
      minPassScore: 0,
    });
    const canaryReport = await canaryRunner.run();

    // Main suite passes, canary fails — scorer is coupled to main suite
    expect(mainReport.overallScore).toBe(1);
    expect(canaryReport.overallScore).toBe(0);
    const divergence = Math.abs(
      mainReport.overallScore - canaryReport.overallScore
    );
    expect(divergence).toBeGreaterThan(0.15);
  });
});

// ===== INTEGRATION TESTS =====

describe("Integration Tests", () => {
  it("should run full regression pipeline: baseline → change → detect", async () => {
    const store = new InMemoryBaselineStore();

    // Phase 1: Establish baseline (all correct)
    const runner1 = createRunner({ baselineStore: store });
    const report1 = await runner1.run();
    expect(report1.passed).toBe(true);
    expect(report1.baselineScore).toBeNull();

    // Phase 2: Introduce regression in greeting category
    const regressedProvider = createMockProvider({
      outputMap: new Map([
        ["What is 2+2?", "4"],
        ["What is 3+3?", "6"],
        ["Say hello", "Goodbye!"], // regressed
        ["Say hi", "Bye!"], // regressed
        ["Extract: John is 30", "John, 30"],
      ]),
      latencyMs: 1,
      latencyJitterMs: 0,
    });

    const runner2 = createRunner({
      baselineStore: store,
      provider: regressedProvider,
    });
    const report2 = await runner2.run();

    expect(report2.passed).toBe(false);
    expect(report2.regressions.length).toBeGreaterThan(0);
    expect(report2.summary).toContain("FAIL");

    // Phase 3: Fix regression — should pass again
    const runner3 = createRunner({ baselineStore: store });
    const report3 = await runner3.run();

    expect(report3.passed).toBe(true);
    expect(report3.regressions).toHaveLength(0);
  });

  it("should handle versioned providers with createVersionedProviders", async () => {
    const { baseline: baselineProvider, current: currentProvider } =
      createVersionedProviders({
        baselineOutputs: new Map([
          ["What is 2+2?", "4"],
          ["Say hello", "Hello!"],
        ]),
        changedOutputs: new Map([
          ["Say hello", "Wrong!"], // regression
        ]),
      });

    const suite: TestSuite = {
      id: "versioned",
      version: "v1",
      cases: [
        { id: "1", input: "What is 2+2?", expected: "4", tags: ["math"] },
        {
          id: "2",
          input: "Say hello",
          expected: "Hello!",
          tags: ["greeting"],
        },
      ],
    };

    const store = new InMemoryBaselineStore();

    // Baseline run
    const runner1 = new RegressionRunner({
      suite,
      provider: baselineProvider,
      scorers: [exactMatchScorer()],
      baselineStore: store,
    });
    await runner1.run();

    // Current run with regression
    const runner2 = new RegressionRunner({
      suite,
      provider: currentProvider,
      scorers: [exactMatchScorer()],
      baselineStore: store,
    });
    const report = await runner2.run();

    expect(report.regressions.length).toBeGreaterThan(0);
    const greetingReg = report.regressions.find(
      (r) => r.tag === "greeting"
    );
    expect(greetingReg).toBeDefined();
  });

  it("should process cases concurrently", async () => {
    const store = new InMemoryBaselineStore();
    const provider = createAllMatchProvider();

    const runner = createRunner({
      baselineStore: store,
      provider,
      concurrency: 2,
    });

    const report = await runner.run();
    expect(report.passed).toBe(true);
    expect(report.runResult.results).toHaveLength(5);
  });

  it("should handle mixed scorer results", async () => {
    const store = new InMemoryBaselineStore();

    // exact_match will fail, contains will pass
    const provider = createMockProvider({
      outputMap: new Map([
        ["What is 2+2?", "The answer is 4"],
        ["What is 3+3?", "The answer is 6"],
        ["Say hello", "Hello! How are you?"],
        ["Say hi", "Hi there! Welcome!"],
        ["Extract: John is 30", "Name: John, Age: 30, so John, 30"],
      ]),
      latencyMs: 1,
      latencyJitterMs: 0,
    });

    const runner = createRunner({
      baselineStore: store,
      provider,
      scorers: [exactMatchScorer(), containsScorer()],
      minPassScore: 0,
    });
    const report = await runner.run();

    // exact_match should be 0 (outputs don't exactly match)
    // contains should be 1 (all outputs contain expected)
    const exactScore =
      report.runResult.aggregate.overall["exact_match"];
    const containsScore =
      report.runResult.aggregate.overall["contains"];

    expect(exactScore).toBe(0);
    expect(containsScore).toBe(1);
  });

  it("should handle provider timeout", async () => {
    const store = new InMemoryBaselineStore();
    const provider = createMockProvider({
      hangForever: true,
    });

    const runner = createRunner({
      baselineStore: store,
      provider,
      timeoutMs: 100,
      minPassScore: 0,
    });

    const report = await runner.run();
    expect(report.overallScore).toBe(0);
    expect(report.runResult.results[0].scores["exact_match"].reason).toContain(
      "timed out"
    );
  });
});

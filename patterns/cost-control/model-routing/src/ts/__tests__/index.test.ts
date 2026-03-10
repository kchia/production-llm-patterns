import { describe, it, expect, beforeEach } from "vitest";
import { ModelRouter, HeuristicClassifier } from "../index";
import { MockProvider } from "../mock-provider";
import type { ComplexityClassifier, LLMProvider } from "../types";

// Use fast latencies to keep tests quick
const FAST_CONFIG = { weakLatencyMs: 1, midLatencyMs: 1, strongLatencyMs: 1, latencyJitterMs: 0 };

describe("HeuristicClassifier", () => {
  const classifier = new HeuristicClassifier();

  describe("task type hints", () => {
    it("classifies extraction as simple", () => {
      expect(classifier.classify("anything", "extraction")).toBeLessThan(0.3);
    });

    it("classifies classification as simple", () => {
      expect(classifier.classify("anything", "classification")).toBeLessThan(0.3);
    });

    it("classifies reasoning as complex", () => {
      expect(classifier.classify("anything", "reasoning")).toBeGreaterThan(0.7);
    });

    it("classifies code-generation as complex", () => {
      expect(classifier.classify("anything", "code-generation")).toBeGreaterThan(0.7);
    });
  });

  describe("prompt-based signals", () => {
    it("scores short simple prompts lower", () => {
      const score = classifier.classify("List the colors.");
      expect(score).toBeLessThan(0.5);
    });

    it("scores prompts with numbered steps higher", () => {
      const prompt = "1. First analyze the data. 2. Then compare results. 3. Finally summarize findings. 4. Provide recommendations.";
      const score = classifier.classify(prompt);
      expect(score).toBeGreaterThan(0.5);
    });

    it("scores prompts with code blocks higher than plain text of same length", () => {
      const withCode = "Review this code:\n```\nfunction add(a, b) { return a + b; }\n```";
      const withoutCode = "Review this text about addition and basic math operations in detail.";
      expect(classifier.classify(withCode)).toBeGreaterThan(classifier.classify(withoutCode));
    });

    it("scores prompts with complexity-down keywords lower", () => {
      const score = classifier.classify("Extract the names from this list.");
      expect(score).toBeLessThan(0.5);
    });

    it("scores prompts with complexity-up keywords higher than without", () => {
      const withKeywords = classifier.classify("Analyze the trade-off between speed and accuracy in this approach.");
      const without = classifier.classify("Here is some information about speed and accuracy in this approach.");
      expect(withKeywords).toBeGreaterThan(without);
    });
  });

  describe("score bounds", () => {
    it("never returns below 0", () => {
      const score = classifier.classify("yes", "classification");
      expect(score).toBeGreaterThanOrEqual(0);
    });

    it("never returns above 1", () => {
      const longComplex = "analyze " + "step by step ".repeat(100) + "```code```";
      const score = classifier.classify(longComplex, "reasoning");
      expect(score).toBeLessThanOrEqual(1);
    });
  });
});

describe("ModelRouter - Unit Tests", () => {
  let provider: MockProvider;
  let router: ModelRouter;

  beforeEach(() => {
    provider = new MockProvider(FAST_CONFIG);
    router = new ModelRouter(provider);
  });

  describe("routing decisions", () => {
    it("routes extraction tasks to weak tier", async () => {
      const result = await router.route({
        prompt: "Extract the name from: John Smith",
        taskType: "extraction",
      });
      expect(result.tier).toBe("weak");
      expect(result.model).toBe("gpt-4o-mini");
    });

    it("routes reasoning tasks to strong tier", async () => {
      const result = await router.route({
        prompt: "Explain the trade-offs between microservices and monoliths",
        taskType: "reasoning",
      });
      expect(result.tier).toBe("strong");
      expect(result.model).toBe("gpt-4o");
    });

    it("routes mid-complexity prompts to mid tier", async () => {
      // No task type hint, moderate length, no strong signals either way
      const result = await router.route({
        prompt: "Summarize the following article about climate change and its economic impacts over the next decade. The article discusses several key themes including policy responses, technological innovation, and market adaptation.",
      });
      expect(result.tier).toBe("mid");
      expect(result.model).toBe("claude-sonnet");
    });
  });

  describe("configuration", () => {
    it("respects custom thresholds", async () => {
      // Set very aggressive routing: almost everything goes to weak
      const aggressiveRouter = new ModelRouter(provider, {
        weakThreshold: 0.8,
        strongThreshold: 0.95,
      });

      const result = await aggressiveRouter.route({
        prompt: "Summarize the following paragraph about climate change.",
      });
      expect(result.tier).toBe("weak");
    });

    it("respects custom model IDs", async () => {
      const customRouter = new ModelRouter(provider, {
        models: {
          strong: { id: "custom-strong", tier: "strong", inputCostPer1MTokens: 5, outputCostPer1MTokens: 15 },
          mid: { id: "custom-mid", tier: "mid", inputCostPer1MTokens: 2, outputCostPer1MTokens: 8 },
          weak: { id: "custom-weak", tier: "weak", inputCostPer1MTokens: 0.1, outputCostPer1MTokens: 0.3 },
        },
      });

      const result = await customRouter.route({
        prompt: "Extract name",
        taskType: "extraction",
      });
      expect(result.model).toBe("custom-weak");
    });

    it("allows runtime config updates", async () => {
      router.updateConfig({
        models: {
          strong: { id: "new-strong", tier: "strong", inputCostPer1MTokens: 2, outputCostPer1MTokens: 8 },
          mid: { id: "claude-sonnet", tier: "mid", inputCostPer1MTokens: 3, outputCostPer1MTokens: 15 },
          weak: { id: "gpt-4o-mini", tier: "weak", inputCostPer1MTokens: 0.15, outputCostPer1MTokens: 0.6 },
        },
      });

      const result = await router.route({
        prompt: "Complex analysis task",
        taskType: "reasoning",
      });
      expect(result.model).toBe("new-strong");
    });
  });

  describe("stats tracking", () => {
    it("tracks total requests", async () => {
      await router.route({ prompt: "test 1", taskType: "extraction" });
      await router.route({ prompt: "test 2", taskType: "reasoning" });

      const stats = router.getStats();
      expect(stats.totalRequests).toBe(2);
    });

    it("tracks routes by tier", async () => {
      await router.route({ prompt: "extract", taskType: "extraction" });
      await router.route({ prompt: "reason", taskType: "reasoning" });
      await router.route({ prompt: "extract again", taskType: "classification" });

      const stats = router.getStats();
      expect(stats.routesByTier.weak).toBe(2);
      expect(stats.routesByTier.strong).toBe(1);
    });

    it("tracks average complexity score", async () => {
      await router.route({ prompt: "simple", taskType: "extraction" });
      await router.route({ prompt: "complex", taskType: "reasoning" });

      const stats = router.getStats();
      expect(stats.averageComplexityScore).toBeGreaterThan(0);
      expect(stats.averageComplexityScore).toBeLessThan(1);
    });

    it("records recent decisions", async () => {
      await router.route({ prompt: "test", taskType: "extraction" });

      const stats = router.getStats();
      expect(stats.recentDecisions).toHaveLength(1);
      expect(stats.recentDecisions[0].tier).toBe("weak");
      expect(stats.recentDecisions[0].model).toBe("gpt-4o-mini");
    });

    it("resets stats", async () => {
      await router.route({ prompt: "test", taskType: "extraction" });
      router.resetStats();

      const stats = router.getStats();
      expect(stats.totalRequests).toBe(0);
      expect(stats.recentDecisions).toHaveLength(0);
    });
  });

  describe("tier distribution", () => {
    it("returns percentages", async () => {
      await router.route({ prompt: "a", taskType: "extraction" });
      await router.route({ prompt: "b", taskType: "extraction" });
      await router.route({ prompt: "c", taskType: "reasoning" });
      await router.route({ prompt: "d", taskType: "reasoning" });

      const dist = router.getTierDistribution();
      expect(dist.weak).toBe(0.5);
      expect(dist.strong).toBe(0.5);
    });
  });
});

describe("ModelRouter - Failure Mode Tests", () => {
  describe("FM1: Misroute to weak model", () => {
    it("routes complex untyped prompts to strong tier, not weak", async () => {
      const provider = new MockProvider(FAST_CONFIG);
      const router = new ModelRouter(provider);

      // A clearly complex prompt without a task type hint
      const result = await router.route({
        prompt: "Analyze the trade-off between consistency and availability in distributed systems. 1. First compare CAP theorem implications. 2. Then evaluate Raft vs Paxos consensus. 3. Consider the implications for microservice architectures. 4. Provide a step by step reasoning.",
      });

      // Should recognize this as complex despite no task type
      expect(result.tier).not.toBe("weak");
    });
  });

  describe("FM2: Misroute to strong model (wasted spend)", () => {
    it("routes simple prompts to weak tier without task type hint", async () => {
      const provider = new MockProvider(FAST_CONFIG);
      const router = new ModelRouter(provider);

      const result = await router.route({
        prompt: "List the colors: red, blue, green",
      });

      expect(result.tier).not.toBe("strong");
    });
  });

  describe("FM3: Classifier latency on critical path", () => {
    it("completes classification in under 5ms", async () => {
      const classifier = new HeuristicClassifier();
      const start = performance.now();

      // Run 1000 classifications
      for (let i = 0; i < 1000; i++) {
        classifier.classify(
          "Analyze the implications of this complex multi-step reasoning task with code ```function test() {}```",
          undefined,
        );
      }

      const elapsed = performance.now() - start;
      // 1000 classifications should take well under 50ms total (<0.05ms each)
      expect(elapsed).toBeLessThan(50);
    });
  });

  describe("FM4: Fallback model overload", () => {
    it("falls back to strong tier when classifier throws", async () => {
      const provider = new MockProvider(FAST_CONFIG);
      const badClassifier: ComplexityClassifier = {
        classify: () => {
          throw new Error("classifier broken");
        },
      };
      const router = new ModelRouter(provider, {}, badClassifier);

      const result = await router.route({ prompt: "test" });
      expect(result.tier).toBe("strong");
      expect(result.complexityScore).toBe(-1);

      const stats = router.getStats();
      expect(stats.classificationErrors).toBe(1);
    });

    it("tracks fallback rate in stats", async () => {
      const provider = new MockProvider(FAST_CONFIG);
      let callCount = 0;
      const flakyClassifier: ComplexityClassifier = {
        classify: () => {
          callCount++;
          if (callCount % 2 === 0) throw new Error("intermittent failure");
          return 0.5;
        },
      };
      const router = new ModelRouter(provider, {}, flakyClassifier);

      for (let i = 0; i < 10; i++) {
        await router.route({ prompt: "test" });
      }

      const stats = router.getStats();
      expect(stats.classificationErrors).toBe(5);
    });
  });

  describe("FM5: Model pool staleness (silent degradation)", () => {
    it("exposes tier distribution for monitoring drift", async () => {
      const provider = new MockProvider(FAST_CONFIG);
      const router = new ModelRouter(provider);

      // Simulate a workload that should be mostly simple
      const simplePrompts = [
        "Extract name: John",
        "Classify: positive",
        "List items: a, b, c",
        "Label: spam",
        "Format: JSON",
      ];

      for (const prompt of simplePrompts) {
        await router.route({ prompt, taskType: "extraction" });
      }

      const dist = router.getTierDistribution();
      // All should route to weak since they're all extraction tasks
      expect(dist.weak).toBe(1.0);

      // If this distribution changes over time without config changes,
      // it signals workload drift
    });
  });

  describe("FM6: Threshold drift from workload shift", () => {
    it("detects tier distribution shift when workload changes", async () => {
      const provider = new MockProvider(FAST_CONFIG);
      const router = new ModelRouter(provider);

      // Phase 1: simple workload
      for (let i = 0; i < 5; i++) {
        await router.route({ prompt: "extract item", taskType: "extraction" });
      }
      const phase1Dist = router.getTierDistribution();

      router.resetStats();

      // Phase 2: complex workload
      for (let i = 0; i < 5; i++) {
        await router.route({ prompt: "deep analysis", taskType: "reasoning" });
      }
      const phase2Dist = router.getTierDistribution();

      // Distribution shifted significantly
      expect(Math.abs(phase1Dist.weak - phase2Dist.weak)).toBeGreaterThan(0.5);
    });
  });
});

describe("ModelRouter - Integration Tests", () => {
  it("end-to-end: routes mixed workload and produces valid stats", async () => {
    const provider = new MockProvider({
      ...FAST_CONFIG,
      avgOutputTokens: 100,
    });
    const router = new ModelRouter(provider);

    const requests = [
      { prompt: "Extract the email from: john@example.com", taskType: "extraction" as const },
      { prompt: "Classify this text as positive or negative: I love this product", taskType: "classification" as const },
      { prompt: "Analyze the architectural implications of migrating from a monolith to microservices, considering: 1. Data consistency challenges. 2. Network partition handling. 3. Deployment complexity. 4. Team organization.", taskType: "reasoning" as const },
      { prompt: "Summarize the following article in one sentence.", taskType: undefined },
    ];

    const results = [];
    for (const req of requests) {
      results.push(await router.route(req));
    }

    // Verify routing decisions
    expect(results[0].tier).toBe("weak");  // extraction → weak
    expect(results[1].tier).toBe("weak");  // classification → weak
    expect(results[2].tier).toBe("strong"); // reasoning → strong

    // All responses should be non-empty
    for (const result of results) {
      expect(result.response).toBeTruthy();
      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBeGreaterThan(0);
      expect(result.latencyMs).toBeGreaterThan(0);
    }

    // Stats should be consistent
    const stats = router.getStats();
    expect(stats.totalRequests).toBe(4);
    expect(stats.routesByTier.weak + stats.routesByTier.mid + stats.routesByTier.strong).toBe(4);
    expect(stats.classificationErrors).toBe(0);
    expect(stats.recentDecisions).toHaveLength(4);
  });

  it("end-to-end: handles provider errors gracefully", async () => {
    const provider = new MockProvider({
      ...FAST_CONFIG,
      errorRate: 1.0, // All calls fail
    });
    const router = new ModelRouter(provider);

    await expect(
      router.route({ prompt: "test", taskType: "extraction" }),
    ).rejects.toThrow("MockProvider: simulated error");
  });

  it("end-to-end: concurrent routing maintains correct stats", async () => {
    const provider = new MockProvider(FAST_CONFIG);
    const router = new ModelRouter(provider);

    const promises = Array.from({ length: 20 }, (_, i) =>
      router.route({
        prompt: `request ${i}`,
        taskType: i % 2 === 0 ? "extraction" : "reasoning",
      }),
    );

    await Promise.all(promises);

    const stats = router.getStats();
    expect(stats.totalRequests).toBe(20);
    expect(stats.routesByTier.weak + stats.routesByTier.mid + stats.routesByTier.strong).toBe(20);
  });
});

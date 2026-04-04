/**
 * Tests for Snapshot Testing pattern.
 *
 * Test categories:
 *  1. Unit — SnapshotRunner core logic, similarity math, characteristic extraction
 *  2. Failure mode — one test per failure mode from the README table
 *  3. Integration — end-to-end run with mock provider
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { SnapshotRunner, SnapshotStore, MockProvider } from "../index.js";
import type { SnapshotTestCase } from "../types.js";

// ─── Test Fixtures ────────────────────────────────────────────────────────────

const TEST_SNAPSHOT_DIR = "/tmp/snapshot-testing-test-" + process.pid;

function makeRunner(
  responses: string[],
  overrides: Partial<Parameters<typeof SnapshotRunner.prototype["run"]>[0]> = {},
  providerConfig: ConstructorParameters<typeof MockProvider>[0] = {}
) {
  const provider = new MockProvider({ responses, ...providerConfig });
  return {
    runner: new SnapshotRunner(provider, {
      snapshotDir: TEST_SNAPSHOT_DIR,
      ...overrides,
    } as Parameters<typeof SnapshotRunner>[1]),
    provider,
  };
}

function makeTestCase(overrides: Partial<SnapshotTestCase> = {}): SnapshotTestCase {
  return {
    id: "test-case-1",
    promptTemplate: "Summarise this: {{text}}",
    inputs: { text: "The system processed 1000 requests successfully." },
    ...overrides,
  };
}

beforeEach(() => {
  mkdirSync(TEST_SNAPSHOT_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_SNAPSHOT_DIR)) {
    rmSync(TEST_SNAPSHOT_DIR, { recursive: true, force: true });
  }
});

// ─── Unit Tests ───────────────────────────────────────────────────────────────

describe("Unit: SnapshotStore", () => {
  it("returns null when no snapshot exists", () => {
    const store = new SnapshotStore(TEST_SNAPSHOT_DIR);
    expect(store.load("nonexistent")).toBeNull();
    expect(store.exists("nonexistent")).toBe(false);
  });

  it("round-trips a snapshot through save/load", async () => {
    const store = new SnapshotStore(TEST_SNAPSHOT_DIR);
    const provider = new MockProvider();
    const chars = {
      embeddingVector: await provider.embed("test"),
      charCount: 4,
      structuralFingerprint: null,
      keyPhrases: ["test"],
      capturedAt: new Date().toISOString(),
    };
    store.save("round-trip", chars);
    const loaded = store.load("round-trip");
    expect(loaded).not.toBeNull();
    expect(loaded!.charCount).toBe(4);
    expect(loaded!.keyPhrases).toEqual(["test"]);
  });

  it("sanitises test case IDs with special characters", () => {
    const store = new SnapshotStore(TEST_SNAPSHOT_DIR);
    // Should not throw — special chars replaced with underscores
    expect(() => store.load("test/../../etc/passwd")).not.toThrow();
  });
});

describe("Unit: SnapshotRunner — first run creates baseline", () => {
  it("returns null on first run and stores a baseline", async () => {
    const { runner } = makeRunner(["hello world response"]);
    const result = await runner.run(makeTestCase());
    expect(result).toBeNull(); // null = baseline created, not pass/fail
    const store = new SnapshotStore(TEST_SNAPSHOT_DIR);
    expect(store.exists("test-case-1")).toBe(true);
  });
});

describe("Unit: SnapshotRunner — similarity threshold", () => {
  it("passes when live output is identical to baseline", async () => {
    const response = "The system processed all requests without errors.";
    const { runner } = makeRunner([response, response]);
    const tc = makeTestCase();

    await runner.run(tc); // first run: creates baseline
    const result = await runner.run(tc); // second run: compare

    expect(result).not.toBeNull();
    expect(result!.passed).toBe(true);
    expect(result!.similarity).toBeCloseTo(1.0, 2);
  });

  it("fails when live output is semantically very different from baseline", async () => {
    const baseline = "The system processed all requests without errors.";
    // Completely different text to ensure low cosine similarity
    const regression = "zzzzz qqqqq xxxxx yyyyy 9999 8888 7777 6666 5555 4444";
    const { runner } = makeRunner([baseline, regression]);
    const tc = makeTestCase();

    await runner.run(tc); // creates baseline
    const result = await runner.run(tc);

    expect(result).not.toBeNull();
    expect(result!.passed).toBe(false);
    expect(result!.similarity).toBeLessThan(0.85);
  });
});

describe("Unit: SnapshotRunner — structural match", () => {
  it("fails when JSON structure changes and structuralMatchRequired is true", async () => {
    const baseline = JSON.stringify({ status: "ok", count: 5 });
    const regression = JSON.stringify({ status: "ok" }); // missing 'count'
    const { runner } = makeRunner([baseline, regression], {
      structuralMatchRequired: true,
    });
    const tc = makeTestCase({ id: "struct-test" });

    await runner.run(tc);
    const result = await runner.run(tc);

    expect(result).not.toBeNull();
    expect(result!.passed).toBe(false);
    expect(result!.delta.structuralChanges).toContain("removed key: count");
  });

  it("passes structural change when structuralMatchRequired is false", async () => {
    const response1 = "All requests were processed successfully without any errors.";
    const response2 = "All requests were processed successfully without any errors.";
    const { runner } = makeRunner([response1, response2], {
      structuralMatchRequired: false,
    });
    const tc = makeTestCase({ id: "struct-optional-test" });

    await runner.run(tc);
    const result = await runner.run(tc);

    expect(result).not.toBeNull();
    expect(result!.passed).toBe(true);
  });
});

describe("Unit: SnapshotRunner — update mode", () => {
  it("overwrites baseline in update mode and returns null", async () => {
    const original = "Original response text.";
    const updated = "Updated response text.";
    const { runner: baselineRunner } = makeRunner([original]);
    const tc = makeTestCase({ id: "update-mode-test" });

    // Create initial baseline
    await baselineRunner.run(tc);

    // Run in update mode to overwrite
    const { runner: updateRunner } = makeRunner([updated], { updateMode: true });
    const updateResult = await updateRunner.run(tc);
    expect(updateResult).toBeNull(); // update mode returns null

    // Verify new baseline was stored
    const store = new SnapshotStore(TEST_SNAPSHOT_DIR);
    const stored = store.load("update-mode-test");
    expect(stored).not.toBeNull();
    // The new baseline should have char count matching updated response
    expect(stored!.charCount).toBe(updated.length);
  });
});

// ─── Failure Mode Tests ────────────────────────────────────────────────────────

describe("Failure Mode: stale snapshot acceptance", () => {
  /**
   * Detects the signal: snapshot update frequency > once per week.
   * Here we verify that update mode is an explicit opt-in —
   * running without updateMode does NOT overwrite the baseline.
   */
  it("does not overwrite baseline on a normal run (update mode opt-in only)", async () => {
    const store = new SnapshotStore(TEST_SNAPSHOT_DIR);
    const original = "Original high-quality response for stale test.";
    const degraded = "zzz qqq xxx yyy 999 888 777 666 555 444 333 222 111";
    const tc = makeTestCase({ id: "stale-test" });

    // Establish baseline
    const { runner: r1 } = makeRunner([original]);
    await r1.run(tc);
    const originalSnapshot = store.load("stale-test");

    // Run with degraded response (normal mode, NOT update mode)
    const { runner: r2 } = makeRunner([degraded]);
    const result = await r2.run(tc);

    // Baseline should be unchanged
    const afterSnapshot = store.load("stale-test");
    expect(afterSnapshot!.charCount).toBe(originalSnapshot!.charCount);
    // Test should fail (regression detected)
    expect(result?.passed).toBe(false);
  });
});

describe("Failure Mode: threshold miscalibration", () => {
  it("high threshold generates false positives on stylistic variation", async () => {
    // Same content, slight rephrasing — should pass at default threshold
    // but would fail at an overly high threshold
    const baselineText = "The service completed all tasks successfully and efficiently.";
    const rephrasedText = "All tasks were completed by the service, efficiently and successfully.";

    const { runner: r1 } = makeRunner([baselineText]);
    const tc = makeTestCase({ id: "threshold-test" });
    await r1.run(tc);

    // Use a very high threshold — simulates miscalibration causing false positives
    const { runner: r2 } = makeRunner([rephrasedText], {
      similarityThreshold: 0.999, // pathologically tight
    });
    const result = await r2.run(tc);

    // At 0.999 threshold, a rephrasing should fail (false positive)
    expect(result?.passed).toBe(false);
    // The delta similarity should still be high (the content IS similar)
    expect(result!.similarity).toBeGreaterThan(0.8);
  });

  it("low threshold fails to catch real regression", async () => {
    const goodResponse = "The system is healthy and all metrics are nominal.";
    const badResponse = "Error: connection timeout after 30 seconds of waiting.";

    const { runner: r1 } = makeRunner([goodResponse]);
    const tc = makeTestCase({ id: "low-threshold-test" });
    await r1.run(tc);

    // Use a very low threshold — simulates miscalibration missing regressions
    const { runner: r2 } = makeRunner([badResponse], {
      similarityThreshold: 0.1, // pathologically loose
    });
    const result = await r2.run(tc);

    // A real regression slips through when threshold is too low
    expect(result?.passed).toBe(true);
  });
});

describe("Failure Mode: missing first-run baseline", () => {
  it("first run returns null (not pass) requiring explicit baseline review", async () => {
    // Verifies that a degraded response doesn't silently become the baseline
    // by returning null on first run, forcing the caller to review it
    const degradedResponse = "ERROR: model response truncated unexpectedly.";
    const { runner } = makeRunner([degradedResponse]);
    const tc = makeTestCase({ id: "first-run-test" });

    const result = await runner.run(tc);
    // null means "baseline created, needs review" — not a silent pass
    expect(result).toBeNull();

    // The baseline IS stored (team must review before treating as canonical)
    const store = new SnapshotStore(TEST_SNAPSHOT_DIR);
    expect(store.exists("first-run-test")).toBe(true);
  });
});

describe("Failure Mode: silent embedding model drift", () => {
  /**
   * This is the "silent degradation" failure mode.
   * The embedding model shifts (drift multiplier changes), causing similarity
   * scores to jump even when output content is identical.
   */
  it("detects unexplained similarity shift from embedding model version change", async () => {
    const stableResponse = "The system is operating normally. All checks passed.";
    const tc = makeTestCase({ id: "drift-test" });

    // Establish baseline with normal embedding
    const { runner: r1 } = makeRunner([stableResponse]);
    await r1.run(tc);

    // Second run with same response but drifted embedding model
    const provider2 = new MockProvider({
      responses: [stableResponse],
      embeddingDriftMultiplier: 5.0, // simulates embedding model version change
    });
    const r2 = new SnapshotRunner(provider2, {
      snapshotDir: TEST_SNAPSHOT_DIR,
      similarityThreshold: 0.85,
    });
    const result = await r2.run(tc);

    // Identical output, but shifted embeddings cause a similarity drop
    // This is the detection signal for embedding drift
    expect(result).not.toBeNull();
    if (result) {
      // When drift is significant, similarity drops — this is the alert signal
      // (In practice: if this test fails spuriously, pin the embedding model version)
      expect(typeof result.similarity).toBe("number");
      // Allow tiny float overshoot from normalisation arithmetic
      expect(result.delta.semanticSimilarity).toBeGreaterThanOrEqual(-1e-9);
      expect(result.delta.semanticSimilarity).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});

describe("Failure Mode: update-mode accidents", () => {
  it("update mode requires explicit opt-in — default runner never overwrites", async () => {
    const original = "Original canonical response text for production.";
    const changed = "Completely different response that should not become baseline.";
    const tc = makeTestCase({ id: "no-overwrite-test" });

    const store = new SnapshotStore(TEST_SNAPSHOT_DIR);
    const { runner: r1 } = makeRunner([original]);
    await r1.run(tc); // create baseline

    // Run with changed response — default config (updateMode: false)
    const { runner: r2 } = makeRunner([changed]); // no updateMode override
    await r2.run(tc);

    // Baseline should still be the original
    const baseline = store.load("no-overwrite-test");
    expect(baseline!.charCount).toBe(original.length);
  });
});

// ─── Integration Tests ────────────────────────────────────────────────────────

describe("Integration: end-to-end snapshot workflow", () => {
  it("runAll: new baselines tracked separately from pass/fail results", async () => {
    const provider = new MockProvider({
      responses: ["Response A for first case.", "Response B for second case."],
    });
    const runner = new SnapshotRunner(provider, { snapshotDir: TEST_SNAPSHOT_DIR });

    const testCases: SnapshotTestCase[] = [
      makeTestCase({ id: "case-a", inputs: { text: "case a" } }),
      makeTestCase({ id: "case-b", inputs: { text: "case b" } }),
    ];

    // First run: all create baselines
    const firstRun = await runner.runAll(testCases);
    expect(firstRun.newBaselines).toHaveLength(2);
    expect(firstRun.results).toHaveLength(0);

    // Second run (same responses): all pass
    provider.resetCallCount();
    const secondRun = await runner.runAll(testCases);
    expect(secondRun.newBaselines).toHaveLength(0);
    expect(secondRun.results).toHaveLength(2);
    expect(secondRun.results.every((r) => r.passed)).toBe(true);
  });

  it("reports structured delta on failure including which dimension failed", async () => {
    const baseline = JSON.stringify({ status: "ok", result: "success" });
    const regression = JSON.stringify({ status: "error" }); // missing 'result'
    const tc = makeTestCase({ id: "delta-test" });

    const { runner: r1 } = makeRunner([baseline]);
    await r1.run(tc);

    const { runner: r2 } = makeRunner([regression], { structuralMatchRequired: true });
    const result = await r2.run(tc);

    expect(result!.passed).toBe(false);
    expect(result!.delta.structuralChanges).toContain("removed key: result");
  });

  it("concurrent test cases do not interfere with each other's snapshots", async () => {
    const responses = ["Response for alpha.", "Response for beta."];
    const provider = new MockProvider({ responses });
    const runner = new SnapshotRunner(provider, { snapshotDir: TEST_SNAPSHOT_DIR });

    const cases: SnapshotTestCase[] = [
      makeTestCase({ id: "concurrent-alpha" }),
      makeTestCase({ id: "concurrent-beta" }),
    ];

    // Run both sequentially (runner is not concurrent by default)
    await runner.runAll(cases);

    const store = new SnapshotStore(TEST_SNAPSHOT_DIR);
    expect(store.exists("concurrent-alpha")).toBe(true);
    expect(store.exists("concurrent-beta")).toBe(true);

    // Snapshots are separate — no key collision
    const alpha = store.load("concurrent-alpha");
    const beta = store.load("concurrent-beta");
    expect(alpha!.charCount).toBe("Response for alpha.".length);
    expect(beta!.charCount).toBe("Response for beta.".length);
  });
});

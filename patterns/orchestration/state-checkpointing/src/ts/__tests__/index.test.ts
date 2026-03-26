import { describe, it, expect, beforeEach, vi } from "vitest";
import { CheckpointedWorkflow } from "../index.js";
import { InMemoryCheckpointStore } from "../stores.js";
import { MockLLMProvider } from "../mock-provider.js";
import { WorkflowStep } from "../types.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

interface TestContext {
  input: string;
}

function makeStep(
  id: string,
  provider: MockLLMProvider,
  prompt: (ctx: TestContext) => string
): WorkflowStep<TestContext, string> {
  return {
    id,
    async execute(context: TestContext): Promise<string> {
      const res = await provider.complete(prompt(context));
      return res.content;
    },
  };
}

function makeWorkflow(
  steps: WorkflowStep<TestContext, unknown>[],
  store: InMemoryCheckpointStore,
  version = "1.0.0"
) {
  return new CheckpointedWorkflow<TestContext, string[]>(
    steps,
    (outputs) => steps.map((s) => outputs[s.id] as string),
    { store, workflowVersion: version, maxRetriesPerStep: 2, retryDelayMs: 0, stepTtlMs: 60_000 }
  );
}

// ─── Unit tests ─────────────────────────────────────────────────────────────

describe("CheckpointedWorkflow — unit tests", () => {
  let store: InMemoryCheckpointStore;
  let provider: MockLLMProvider;

  beforeEach(() => {
    store = new InMemoryCheckpointStore();
    provider = new MockLLMProvider({ latencyMs: 0, latencyJitterMs: 0 });
  });

  it("executes all steps on first run", async () => {
    const steps = [
      makeStep("step-1", provider, () => "prompt 1"),
      makeStep("step-2", provider, () => "prompt 2"),
      makeStep("step-3", provider, () => "prompt 3"),
    ];
    const workflow = makeWorkflow(steps, store);
    const result = await workflow.execute("wf-1", { input: "test" });

    expect(result.stepsExecuted).toBe(3);
    expect(result.stepsSkipped).toBe(0);
    expect(result.output).toHaveLength(3);
    expect(provider.getTotalCalls()).toBe(3);
  });

  it("persists checkpoint after each step", async () => {
    const steps = [makeStep("s1", provider, () => "p1"), makeStep("s2", provider, () => "p2")];
    const workflow = makeWorkflow(steps, store);
    await workflow.execute("wf-persist", { input: "x" });

    const checkpoint = await store.load("wf-persist");
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.steps["s1"]).toBeDefined();
    expect(checkpoint!.steps["s2"]).toBeDefined();
    expect(checkpoint!.status).toBe("completed");
  });

  it("skips completed steps on resume", async () => {
    const steps = [makeStep("s1", provider, () => "p1"), makeStep("s2", provider, () => "p2")];
    const workflow = makeWorkflow(steps, store);

    // First run — completes both steps
    await workflow.execute("wf-resume", { input: "test" });
    expect(provider.getTotalCalls()).toBe(2);

    // Second run — both steps already checkpointed; should skip both
    provider.reset();
    const result = await workflow.execute("wf-resume", { input: "test" });

    expect(result.stepsSkipped).toBe(2);
    expect(result.stepsExecuted).toBe(0);
    expect(provider.getTotalCalls()).toBe(0); // no LLM calls on full resume
  });

  it("resumes from first incomplete step after mid-workflow failure", async () => {
    let callCount = 0;
    const failingProvider = new MockLLMProvider({ latencyMs: 0, latencyJitterMs: 0, errorRate: 0 });

    const steps: WorkflowStep<TestContext, string>[] = [
      makeStep("s1", failingProvider, () => "p1"),
      {
        id: "s2-fail",
        async execute(): Promise<string> {
          callCount++;
          if (callCount === 1) throw new Error("Simulated failure at step 2");
          return "step-2-result";
        },
      },
      makeStep("s3", failingProvider, () => "p3"),
    ];

    const workflow = makeWorkflow(steps, store);

    // First execution fails at step 2
    await expect(workflow.execute("wf-mid-fail", { input: "test" })).rejects.toThrow(
      "Simulated failure at step 2"
    );

    // Step 1 completed and is checkpointed; step 2 is not
    const checkpoint = await store.load("wf-mid-fail");
    expect(checkpoint!.steps["s1"]).toBeDefined();
    expect(checkpoint!.steps["s2-fail"]).toBeUndefined();

    // Second execution resumes — step 1 is skipped, steps 2 and 3 execute
    failingProvider.reset();
    const result = await workflow.execute("wf-mid-fail", { input: "test" });

    expect(result.stepsSkipped).toBe(1); // step 1 skipped
    expect(result.stepsExecuted).toBe(2); // steps 2 and 3 executed
    expect(failingProvider.getTotalCalls()).toBe(1); // only step 3 re-ran via provider
  });

  it("returns the resume point correctly from checkpoint", async () => {
    const steps = [makeStep("s1", provider, () => "p1"), makeStep("s2", provider, () => "p2")];
    const workflow = makeWorkflow(steps, store);

    // Manually inject a partial checkpoint (s1 done, resumeFrom=1)
    await store.save("wf-partial", {
      workflowId: "wf-partial",
      workflowVersion: "1.0.0",
      startedAt: Date.now() - 5000,
      updatedAt: Date.now() - 5000,
      steps: {
        s1: { output: "saved-output", completedAt: Date.now() - 5000, durationMs: 100 },
      },
      status: "running",
      resumeFrom: 1,
    });

    const result = await workflow.execute("wf-partial", { input: "test" });
    expect(result.stepsSkipped).toBe(1);
    expect(result.output[0]).toBe("saved-output"); // loaded from checkpoint, not re-executed
    expect(provider.getTotalCalls()).toBe(1); // only step 2 ran
  });

  it("stores can save and load checkpoints correctly", async () => {
    const checkpoint = {
      workflowId: "wf-store-test",
      workflowVersion: "1.0.0",
      startedAt: 1000,
      updatedAt: 2000,
      steps: { s1: { output: "result", completedAt: 1500, durationMs: 500 } },
      status: "running" as const,
      resumeFrom: 1,
    };

    await store.save("wf-store-test", checkpoint);
    const loaded = await store.load("wf-store-test");

    expect(loaded).toEqual(checkpoint);
    expect(loaded).not.toBe(checkpoint); // deep clone, not reference

    await store.clear("wf-store-test");
    expect(await store.load("wf-store-test")).toBeNull();
  });

  it("defaults: stepTtlMs and maxRetriesPerStep are applied", async () => {
    // Verify that configuration defaults are applied by constructing with minimal config
    const minimal = new CheckpointedWorkflow<TestContext, string[]>(
      [makeStep("s1", provider, () => "p")],
      (outputs) => [outputs["s1"] as string],
      { store, workflowVersion: "1.0.0" } as any // intentionally partial to test defaults
    );
    // Should not throw — defaults fill in missing config
    await expect(minimal.execute("wf-defaults", { input: "x" })).resolves.toBeDefined();
  });
});

// ─── Failure mode tests ──────────────────────────────────────────────────────

describe("CheckpointedWorkflow — failure mode tests", () => {
  let store: InMemoryCheckpointStore;
  let provider: MockLLMProvider;

  beforeEach(() => {
    store = new InMemoryCheckpointStore();
    provider = new MockLLMProvider({ latencyMs: 0, latencyJitterMs: 0 });
  });

  // FM: Stale checkpoint from schema change (workflow version mismatch)
  it("rejects checkpoint from incompatible workflow version", async () => {
    const steps = [makeStep("s1", provider, () => "p1")];
    const workflowV1 = makeWorkflow(steps, store, "1.0.0");

    await workflowV1.execute("wf-version", { input: "test" });

    // Simulate deploying a new workflow version
    const workflowV2 = makeWorkflow(steps, store, "2.0.0");

    await expect(workflowV2.execute("wf-version", { input: "test" })).rejects.toThrow(
      "Checkpoint version mismatch"
    );
  });

  // FM: Checkpoint store becomes unavailable (read fails → can't resume)
  it("fails fast when checkpoint store load throws", async () => {
    const brokenStore: InMemoryCheckpointStore = new InMemoryCheckpointStore();
    vi.spyOn(brokenStore, "load").mockRejectedValue(new Error("Store unavailable"));

    const workflow = makeWorkflow([makeStep("s1", provider, () => "p")], brokenStore);

    await expect(workflow.execute("wf-broken", { input: "test" })).rejects.toThrow(
      "Store unavailable"
    );
  });

  // FM: Checkpoint write fails mid-step (save throws after LLM call succeeds)
  it("propagates checkpoint write failure as workflow error", async () => {
    const partialStore = new InMemoryCheckpointStore();
    let saveCallCount = 0;
    vi.spyOn(partialStore, "save").mockImplementation(async (id, checkpoint) => {
      saveCallCount++;
      if (saveCallCount === 2) throw new Error("Write failed");
      // Use the real implementation for first save
      return InMemoryCheckpointStore.prototype.save.call(partialStore, id, checkpoint);
    });

    const steps = [makeStep("s1", provider, () => "p1"), makeStep("s2", provider, () => "p2")];
    const workflow = makeWorkflow(steps, partialStore);

    await expect(workflow.execute("wf-write-fail", { input: "test" })).rejects.toThrow(
      "Write failed"
    );
  });

  // FM: Resume with wrong workflowId (different namespace = fresh start, not error)
  it("treats unknown workflowId as a fresh start (no cross-namespace bleed)", async () => {
    const steps = [makeStep("s1", provider, () => "p1")];
    const workflow = makeWorkflow(steps, store);

    await workflow.execute("wf-A", { input: "test" });
    provider.reset();

    // Different workflowId — should not pick up wf-A's checkpoint
    const result = await workflow.execute("wf-B", { input: "test" });

    expect(result.stepsSkipped).toBe(0); // fresh start, nothing to skip
    expect(provider.getTotalCalls()).toBe(1); // ran the step from scratch
  });

  // FM: Unbounded checkpoint accumulation (silent degradation)
  // Verifies that clear() actually removes the checkpoint and store size drops
  it("clear() removes checkpoint from store (prevents accumulation)", async () => {
    const steps = [makeStep("s1", provider, () => "p1")];
    const workflow = makeWorkflow(steps, store);

    await workflow.execute("wf-cleanup", { input: "test" });
    expect(store.size()).toBe(1);

    await store.clear("wf-cleanup");
    expect(store.size()).toBe(0);
    expect(await store.load("wf-cleanup")).toBeNull();
  });

  // FM: Step retry exhaustion — maxRetries exceeded
  it("throws after maxRetriesPerStep are exhausted", async () => {
    const alwaysFailing: WorkflowStep<TestContext, string> = {
      id: "always-fail",
      async execute(): Promise<string> {
        throw new Error("Persistent step failure");
      },
    };

    const workflow = new CheckpointedWorkflow<TestContext, string[]>(
      [alwaysFailing],
      (outputs) => [outputs["always-fail"] as string],
      { store, workflowVersion: "1.0.0", maxRetriesPerStep: 2, retryDelayMs: 0, stepTtlMs: 60_000 }
    );

    await expect(workflow.execute("wf-exhausted", { input: "test" })).rejects.toThrow(
      "Persistent step failure"
    );
  });

  // FM: TTL expiry — expired steps re-execute (not silently used)
  it("re-executes steps whose checkpoint has expired (past stepTtlMs)", async () => {
    const steps = [makeStep("s1", provider, () => "p1")];

    // Inject a checkpoint where s1 completed 2 hours ago
    const expiredCheckpoint = {
      workflowId: "wf-expired",
      workflowVersion: "1.0.0",
      startedAt: Date.now() - 7200_000,
      updatedAt: Date.now() - 7200_000,
      steps: {
        s1: {
          output: "stale-output",
          completedAt: Date.now() - 7200_000,
          durationMs: 100,
        },
      },
      status: "running" as const,
      resumeFrom: 0,
    };
    await store.save("wf-expired", expiredCheckpoint);

    // TTL of 1 hour — step is expired
    const workflow = new CheckpointedWorkflow<TestContext, string[]>(
      steps,
      (outputs) => [outputs["s1"] as string],
      { store, workflowVersion: "1.0.0", maxRetriesPerStep: 1, retryDelayMs: 0, stepTtlMs: 3600_000 }
    );

    const result = await workflow.execute("wf-expired", { input: "test" });

    expect(result.stepsSkipped).toBe(0); // expired step was not skipped
    expect(result.stepsExecuted).toBe(1); // re-ran the step
    expect(result.output[0]).not.toBe("stale-output"); // got fresh output
  });
});

// ─── Integration tests ───────────────────────────────────────────────────────

describe("CheckpointedWorkflow — integration tests", () => {
  it("full workflow: 5 steps, end-to-end with mock provider", async () => {
    const store = new InMemoryCheckpointStore();
    const provider = new MockLLMProvider({
      latencyMs: 5,
      latencyJitterMs: 2,
      responses: ["result-1", "result-2", "result-3", "result-4", "result-5"],
    });

    const steps = Array.from({ length: 5 }, (_, i) =>
      makeStep(`step-${i + 1}`, provider, (ctx) => `${ctx.input}: step ${i + 1}`)
    );

    const workflow = new CheckpointedWorkflow<TestContext, string[]>(
      steps,
      (outputs) => steps.map((s) => outputs[s.id] as string),
      { store, workflowVersion: "1.0.0", maxRetriesPerStep: 2, retryDelayMs: 0, stepTtlMs: 60_000 }
    );

    const result = await workflow.execute("wf-full", { input: "test-input" });

    expect(result.stepsExecuted).toBe(5);
    expect(result.stepsSkipped).toBe(0);
    expect(result.output).toEqual(["result-1", "result-2", "result-3", "result-4", "result-5"]);
    expect(provider.getTotalCalls()).toBe(5);
  });

  it("concurrent workflows maintain separate checkpoint namespaces", async () => {
    const store = new InMemoryCheckpointStore();
    const provider = new MockLLMProvider({ latencyMs: 10, latencyJitterMs: 0 });

    const steps = [makeStep("s1", provider, (ctx) => ctx.input)];
    const workflow = new CheckpointedWorkflow<TestContext, string[]>(
      steps,
      (outputs) => [outputs["s1"] as string],
      { store, workflowVersion: "1.0.0", maxRetriesPerStep: 1, retryDelayMs: 0, stepTtlMs: 60_000 }
    );

    // Run 3 workflows concurrently
    const results = await Promise.all([
      workflow.execute("concurrent-1", { input: "A" }),
      workflow.execute("concurrent-2", { input: "B" }),
      workflow.execute("concurrent-3", { input: "C" }),
    ]);

    // All 3 completed
    expect(results).toHaveLength(3);
    results.forEach((r) => expect(r.stepsExecuted).toBe(1));

    // Each has its own checkpoint
    expect(store.size()).toBe(3);
    expect(store.keys()).toContain("concurrent-1");
    expect(store.keys()).toContain("concurrent-2");
    expect(store.keys()).toContain("concurrent-3");
  });

  it("getCheckpoint returns correct state after partial execution", async () => {
    const store = new InMemoryCheckpointStore();
    let failFirst = true;
    const provider = new MockLLMProvider({ latencyMs: 0, latencyJitterMs: 0 });

    const steps: WorkflowStep<TestContext, string>[] = [
      makeStep("s1", provider, () => "p1"),
      {
        id: "s2",
        async execute(): Promise<string> {
          if (failFirst) {
            failFirst = false;
            throw new Error("First attempt fails");
          }
          return "s2-success";
        },
      },
    ];

    const workflow = new CheckpointedWorkflow<TestContext, string[]>(
      steps,
      (outputs) => steps.map((s) => outputs[s.id] as string),
      { store, workflowVersion: "1.0.0", maxRetriesPerStep: 1, retryDelayMs: 0, stepTtlMs: 60_000 }
    );

    // First run fails at s2
    await expect(workflow.execute("wf-partial-check", { input: "x" })).rejects.toThrow();

    // Checkpoint shows s1 done, s2 not
    const checkpoint = await workflow.getCheckpoint("wf-partial-check");
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.steps["s1"]).toBeDefined();
    expect(checkpoint!.steps["s2"]).toBeUndefined();
    expect(checkpoint!.resumeFrom).toBe(1);

    // Resume — s1 skipped, s2 completes
    const result = await workflow.execute("wf-partial-check", { input: "x" });
    expect(result.stepsSkipped).toBe(1);
    expect(result.output[1]).toBe("s2-success");
  });
});

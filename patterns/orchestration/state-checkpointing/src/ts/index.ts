import {
  CheckpointConfig,
  CheckpointStore,
  WorkflowCheckpoint,
  WorkflowResult,
  WorkflowStep,
} from "./types.js";

export { CheckpointStore, WorkflowCheckpoint, WorkflowStep, WorkflowResult, CheckpointConfig };
export { InMemoryCheckpointStore } from "./stores.js";
export { MockLLMProvider } from "./mock-provider.js";
export type { MockProviderConfig } from "./mock-provider.js";

const DEFAULT_CONFIG: Omit<CheckpointConfig, "store"> = {
  workflowVersion: "1.0.0",
  stepTtlMs: 24 * 60 * 60 * 1000, // 24 hours
  maxRetriesPerStep: 3,
  retryDelayMs: 1000,
  checksumContext: false,
};

/**
 * CheckpointedWorkflow wraps a sequence of workflow steps with durable state persistence.
 *
 * On first run: executes all steps in order, saving a checkpoint after each.
 * On retry: loads the last checkpoint, skips completed steps, resumes from the first
 * incomplete step. Completed steps return their saved outputs without re-executing.
 *
 * This means workflows pay for each LLM call exactly once, regardless of how many
 * times the workflow is retried after failure.
 */
export class CheckpointedWorkflow<TContext, TResult> {
  private config: CheckpointConfig;
  private steps: WorkflowStep<TContext, unknown>[];
  private assembler: (outputs: Record<string, unknown>, context: TContext) => TResult;

  constructor(
    steps: WorkflowStep<TContext, unknown>[],
    assembler: (outputs: Record<string, unknown>, context: TContext) => TResult,
    config: Partial<CheckpointConfig> & { store: CheckpointStore }
  ) {
    this.steps = steps;
    this.assembler = assembler;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute workflow from scratch or resume from an existing checkpoint.
   * Uses workflowId as the checkpoint namespace — callers are responsible
   * for generating stable IDs across retry attempts (e.g., job ID, request ID).
   */
  async execute(workflowId: string, context: TContext): Promise<WorkflowResult<TResult>> {
    const startTime = Date.now();

    // Load existing checkpoint or create a fresh one
    const existing = await this.config.store.load(workflowId);
    const checkpoint = this.initCheckpoint(workflowId, existing, context);

    let stepsExecuted = 0;
    let stepsSkipped = 0;
    const previousOutputs: Record<string, unknown> = {};

    // Populate previousOutputs from any completed steps (for resume continuity)
    for (const step of this.steps) {
      const saved = checkpoint.steps[step.id];
      if (saved) {
        previousOutputs[step.id] = saved.output;
      }
    }

    // Execute steps starting from the resume point
    for (let i = checkpoint.resumeFrom; i < this.steps.length; i++) {
      const step = this.steps[i];
      const saved = checkpoint.steps[step.id];

      // Skip steps that completed in a previous run
      if (saved && !this.isExpired(saved.completedAt)) {
        previousOutputs[step.id] = saved.output;
        stepsSkipped++;
        continue;
      }

      // Execute with per-step retry budget
      const output = await this.executeWithRetry(step, context, previousOutputs);
      previousOutputs[step.id] = output;

      // Record completion and persist checkpoint
      checkpoint.steps[step.id] = {
        output,
        completedAt: Date.now(),
        durationMs: Date.now() - startTime,
      };
      checkpoint.resumeFrom = i + 1;
      checkpoint.updatedAt = Date.now();

      await this.config.store.save(workflowId, checkpoint);
      stepsExecuted++;
    }

    // Mark complete and assemble final result
    checkpoint.status = "completed";
    checkpoint.updatedAt = Date.now();
    await this.config.store.save(workflowId, checkpoint);

    const output = this.assembler(previousOutputs, context);

    return {
      output,
      workflowId,
      stepsExecuted,
      stepsSkipped,
      totalDurationMs: Date.now() - startTime,
    };
  }

  /**
   * Convenience method for resuming a workflow that was previously started.
   * Throws if no checkpoint exists for the given workflowId.
   */
  async resume(workflowId: string, context: TContext): Promise<WorkflowResult<TResult>> {
    const checkpoint = await this.config.store.load(workflowId);
    if (!checkpoint) {
      throw new Error(`No checkpoint found for workflow: ${workflowId}`);
    }
    return this.execute(workflowId, context);
  }

  async getCheckpoint(workflowId: string): Promise<WorkflowCheckpoint | null> {
    return this.config.store.load(workflowId);
  }

  private initCheckpoint(
    workflowId: string,
    existing: WorkflowCheckpoint | null,
    _context: TContext
  ): WorkflowCheckpoint {
    if (existing) {
      // Reject checkpoints from incompatible workflow versions
      // to prevent silently mixing outputs from different schemas
      if (existing.workflowVersion !== this.config.workflowVersion) {
        throw new Error(
          `Checkpoint version mismatch: checkpoint is v${existing.workflowVersion}, ` +
            `workflow is v${this.config.workflowVersion}. ` +
            `Clear the checkpoint before running the updated workflow.`
        );
      }
      return existing;
    }

    return {
      workflowId,
      workflowVersion: this.config.workflowVersion,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      steps: {},
      status: "running",
      resumeFrom: 0,
    };
  }

  private isExpired(completedAt: number): boolean {
    return Date.now() - completedAt > this.config.stepTtlMs;
  }

  private async executeWithRetry(
    step: WorkflowStep<TContext, unknown>,
    context: TContext,
    previousOutputs: Record<string, unknown>
  ): Promise<unknown> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.config.maxRetriesPerStep; attempt++) {
      try {
        return await step.execute(context, previousOutputs);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < this.config.maxRetriesPerStep - 1) {
          // Exponential backoff: retryDelayMs * 2^attempt
          const delay = this.config.retryDelayMs * Math.pow(2, attempt);
          await sleep(delay);
        }
      }
    }

    throw lastError ?? new Error(`Step ${step.id} failed after ${this.config.maxRetriesPerStep} attempts`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

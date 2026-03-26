export interface StepResult {
  output: unknown;
  completedAt: number; // Unix ms
  durationMs: number;
  inputHash?: string; // optional: hash of step inputs for drift detection
}

export interface WorkflowCheckpoint {
  workflowId: string;
  workflowVersion: string;
  startedAt: number; // Unix ms
  updatedAt: number; // Unix ms
  steps: Record<string, StepResult>; // stepId → result
  status: "running" | "completed" | "failed";
  resumeFrom: number; // index of next step to execute
  contextHash?: string; // hash of initial context for mismatched-context detection
}

export interface CheckpointStore {
  save(workflowId: string, checkpoint: WorkflowCheckpoint): Promise<void>;
  load(workflowId: string): Promise<WorkflowCheckpoint | null>;
  clear(workflowId: string): Promise<void>;
}

export interface WorkflowStep<TContext, TOutput> {
  id: string;
  execute(context: TContext, previousOutputs: Record<string, unknown>): Promise<TOutput>;
}

export interface CheckpointConfig {
  store: CheckpointStore;
  workflowVersion: string;
  stepTtlMs: number; // how long checkpoints are valid before expiry
  maxRetriesPerStep: number;
  retryDelayMs: number;
  checksumContext: boolean; // whether to hash+verify initial context on resume
}

export interface WorkflowResult<TOutput> {
  output: TOutput;
  workflowId: string;
  stepsExecuted: number;
  stepsSkipped: number; // steps resumed from checkpoint
  totalDurationMs: number;
}

export interface LLMProvider {
  complete(prompt: string, options?: LLMOptions): Promise<LLMResponse>;
}

export interface LLMOptions {
  maxTokens?: number;
  temperature?: number;
}

export interface LLMResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

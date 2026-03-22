/**
 * Type definitions for Prompt Rollout Testing pattern.
 * Supports A/B splits, canary deploys, and shadow mode.
 */

export type RolloutMode = 'ab' | 'canary' | 'shadow';

export type RolloutDecisionAction = 'hold' | 'promote' | 'rollback';

export interface PromptVariant {
  id: string;
  label: string;   // e.g. "current", "candidate-v2"
  prompt: string;
  weight: number;  // 0.0–1.0; all variant weights must sum to 1.0
}

export interface RolloutConfig {
  variants: PromptVariant[];
  mode: RolloutMode;
  /** Minimum samples per variant before statistical evaluation runs */
  minSampleSize: number;
  /** Significance threshold (alpha). Typically 0.05. */
  significanceLevel: number;
  /** Injected scorer: returns a quality value in [0, 1] */
  qualityMetric: (response: string, input: string) => Promise<number>;
  /** If true, fires rollback automatically when rollbackThreshold is crossed */
  autoRollback: boolean;
  /** Absolute quality drop (vs. current variant) that triggers auto-rollback */
  rollbackThreshold: number;
  /** How many requests between statistical evaluation runs */
  evaluationInterval: number;
}

export interface LLMRequest {
  input: string;
  [key: string]: unknown;
}

export interface LLMResponse {
  output: string;
  variantId: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface VariantStats {
  variantId: string;
  label: string;
  requestCount: number;
  qualityScores: number[];
  latenciesMs: number[];
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface RolloutDecision {
  action: RolloutDecisionAction;
  /** 1 - p-value (confidence that the difference is real) */
  confidence: number;
  pValue: number;
  variantStats: Map<string, VariantStats>;
  reasoning: string;
}

export interface LLMProvider {
  complete(prompt: string, input: string): Promise<{
    output: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  }>;
}

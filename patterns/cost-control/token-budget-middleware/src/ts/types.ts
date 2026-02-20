/**
 * Token Budget Middleware — Type Definitions
 *
 * Core types for the token budget enforcement pattern.
 * Framework-agnostic, no external dependencies.
 */

/** A request to an LLM provider. */
export interface LLMRequest {
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  metadata?: Record<string, unknown>;
}

/** A response from an LLM provider. */
export interface LLMResponse {
  content: string;
  tokensUsed: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  finishReason?: string;
}

/** Context for budget enforcement — identifies who/what the budget applies to. */
export interface BudgetContext {
  /** Budget key for spend attribution (e.g., user ID, team ID, feature name). */
  budgetKey: string;
  /** Optional additional keys for hierarchical budget checks. */
  parentKeys?: string[];
}

/** Budget scope granularity. */
export type BudgetScope = 'global' | 'team' | 'user' | 'request';

/** Strategy when budget is exceeded. */
export type ExceededStrategy = 'reject' | 'throttle' | 'warn-only';

/** Configuration for the TokenBudgetMiddleware. */
export interface TokenBudgetConfig {
  /** Maximum tokens allowed per budget window. Default: 1_000_000. */
  maxTokens?: number;

  /** Budget window duration in milliseconds. Default: 86_400_000 (24 hours). */
  windowMs?: number;

  /** Budget scope granularity. Default: "global". */
  budgetScope?: BudgetScope;

  /** Fraction of budget that triggers warning callback (0.0–1.0). Default: 0.8. */
  warningThreshold?: number;

  /** Strategy when budget is exceeded. Default: "reject". */
  onBudgetExceeded?: ExceededStrategy;

  /** Callback fired when warning threshold is crossed. */
  onWarning?: (usage: BudgetUsage) => void;

  /** Custom token estimator. Default: character-based (~4 chars per token). */
  estimateTokens?: (text: string) => number;

  /** LLM provider function to wrap. */
  provider: (request: LLMRequest) => Promise<LLMResponse>;
}

/** Snapshot of budget usage for a given key. */
export interface BudgetUsage {
  /** The budget key this usage applies to. */
  budgetKey: string;
  /** Tokens consumed in the current window. */
  tokensUsed: number;
  /** Maximum tokens allowed in the window. */
  maxTokens: number;
  /** Tokens remaining before the limit. */
  remaining: number;
  /** Utilization as a fraction (0.0–1.0). */
  utilization: number;
  /** When the current window started. */
  windowStart: number;
  /** When the current window expires. */
  windowEnd: number;
}

/** Result of an execute() call, wrapping the LLM response with budget metadata. */
export interface BudgetedResponse {
  /** The LLM response. */
  response: LLMResponse;
  /** Budget usage after this request. */
  usage: BudgetUsage;
  /** Whether the warning threshold was crossed by this request. */
  warningTriggered: boolean;
  /** Estimated tokens for the input (pre-call estimate). */
  estimatedInputTokens: number;
  /** Actual tokens reported by the provider (post-call). */
  actualTokens: number;
}

/** Error thrown when a request would exceed the budget. */
export class BudgetExceededError extends Error {
  public readonly usage: BudgetUsage;
  public readonly estimatedCost: number;

  constructor(usage: BudgetUsage, estimatedCost: number) {
    super(
      `Token budget exceeded for "${usage.budgetKey}": ` +
        `${usage.tokensUsed}/${usage.maxTokens} tokens used, ` +
        `request would add ~${estimatedCost} tokens`
    );
    this.name = 'BudgetExceededError';
    this.usage = usage;
    this.estimatedCost = estimatedCost;
  }
}

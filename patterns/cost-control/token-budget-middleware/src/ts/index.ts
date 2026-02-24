/**
 * Token Budget Middleware — Core Implementation
 *
 * Wraps any LLM provider call with token budget enforcement.
 * Tracks cumulative spend across configurable time windows,
 * rejects or throttles requests that would exceed limits.
 *
 * Framework-agnostic. No external dependencies.
 */

import type {
  LLMRequest,
  LLMResponse,
  BudgetContext,
  BudgetUsage,
  BudgetedResponse,
  TokenBudgetConfig,
} from './types.js';
import { BudgetExceededError } from './types.js';

/** Internal state for a single budget window. */
interface BudgetWindow {
  tokensUsed: number;
  windowStart: number;
  warningFired: boolean;
}

/**
 * Default token estimator: ~4 characters per token for English text.
 * Intentionally overestimates slightly to provide a safety margin.
 */
function defaultEstimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class TokenBudgetMiddleware {
  private readonly maxTokens: number;
  private readonly windowMs: number;
  private readonly warningThreshold: number;
  private readonly exceededStrategy: string;
  private readonly onWarning: ((usage: BudgetUsage) => void) | null;
  private readonly estimateTokens: (text: string) => number;
  private readonly provider: (request: LLMRequest) => Promise<LLMResponse>;

  // Budget state keyed by budget key string
  private readonly windows: Map<string, BudgetWindow> = new Map();

  constructor(config: TokenBudgetConfig) {
    this.maxTokens = config.maxTokens ?? 1_000_000;
    this.windowMs = config.windowMs ?? 86_400_000; // 24 hours
    this.warningThreshold = config.warningThreshold ?? 0.8;
    this.exceededStrategy = config.onBudgetExceeded ?? 'reject';
    this.onWarning = config.onWarning ?? null;
    this.estimateTokens = config.estimateTokens ?? defaultEstimateTokens;
    this.provider = config.provider;
  }

  /**
   * Execute an LLM request with budget enforcement.
   *
   * 1. Estimate input tokens
   * 2. Check if the request fits within the budget
   * 3. Forward to the provider if allowed
   * 4. Record actual usage from the response
   */
  async execute(
    request: LLMRequest,
    context: BudgetContext = { budgetKey: 'global' }
  ): Promise<BudgetedResponse> {
    const estimatedInputTokens = this.estimateTokens(request.prompt);

    // Get or create the budget window for this key
    const window = this.getOrCreateWindow(context.budgetKey);

    // Pre-call budget check: will this request likely exceed the limit?
    const projectedUsage = window.tokensUsed + estimatedInputTokens;
    if (projectedUsage > this.maxTokens) {
      const usage = this.buildUsage(context.budgetKey, window);

      if (this.exceededStrategy === 'reject') {
        throw new BudgetExceededError(usage, estimatedInputTokens);
      }
      // warn-only: continue but the caller gets the usage info in the response
    }

    // Forward to provider
    const response = await this.provider(request);

    // Post-call: record actual tokens from the provider response
    const actualTokens = response.tokensUsed;
    window.tokensUsed += actualTokens;

    // Check warning threshold
    let warningTriggered = false;
    const utilization = window.tokensUsed / this.maxTokens;
    if (utilization >= this.warningThreshold && !window.warningFired) {
      window.warningFired = true;
      warningTriggered = true;
      const usage = this.buildUsage(context.budgetKey, window);
      this.onWarning?.(usage);
    }

    // Also check parent keys if hierarchical enforcement is needed
    if (context.parentKeys) {
      for (const parentKey of context.parentKeys) {
        const parentWindow = this.getOrCreateWindow(parentKey);
        parentWindow.tokensUsed += actualTokens;

        const parentUtilization = parentWindow.tokensUsed / this.maxTokens;
        if (parentUtilization >= this.warningThreshold && !parentWindow.warningFired) {
          parentWindow.warningFired = true;
          const parentUsage = this.buildUsage(parentKey, parentWindow);
          this.onWarning?.(parentUsage);
        }
      }
    }

    return {
      response,
      usage: this.buildUsage(context.budgetKey, window),
      warningTriggered,
      estimatedInputTokens,
      actualTokens,
    };
  }

  /** Get current usage for a budget key. */
  getUsage(budgetKey: string): BudgetUsage {
    const window = this.getOrCreateWindow(budgetKey);
    return this.buildUsage(budgetKey, window);
  }

  /** Get tokens remaining in the current window for a budget key. */
  getRemainingBudget(budgetKey: string): number {
    const window = this.getOrCreateWindow(budgetKey);
    return Math.max(0, this.maxTokens - window.tokensUsed);
  }

  /** Manually reset a budget key's window. */
  resetBudget(budgetKey: string): void {
    this.windows.set(budgetKey, {
      tokensUsed: 0,
      windowStart: Date.now(),
      warningFired: false,
    });
  }

  /** Reset all budget windows. */
  resetAll(): void {
    this.windows.clear();
  }

  // -- Internal helpers --

  private getOrCreateWindow(budgetKey: string): BudgetWindow {
    const now = Date.now();
    const existing = this.windows.get(budgetKey);

    if (existing) {
      // Check if the window has expired
      if (now - existing.windowStart >= this.windowMs) {
        const fresh: BudgetWindow = {
          tokensUsed: 0,
          windowStart: now,
          warningFired: false,
        };
        this.windows.set(budgetKey, fresh);
        return fresh;
      }
      return existing;
    }

    const fresh: BudgetWindow = {
      tokensUsed: 0,
      windowStart: now,
      warningFired: false,
    };
    this.windows.set(budgetKey, fresh);
    return fresh;
  }

  private buildUsage(budgetKey: string, window: BudgetWindow): BudgetUsage {
    const remaining = Math.max(0, this.maxTokens - window.tokensUsed);
    return {
      budgetKey,
      tokensUsed: window.tokensUsed,
      maxTokens: this.maxTokens,
      remaining,
      utilization: window.tokensUsed / this.maxTokens,
      windowStart: window.windowStart,
      windowEnd: window.windowStart + this.windowMs,
    };
  }
}

export { BudgetExceededError } from './types.js';
export type {
  LLMRequest,
  LLMResponse,
  BudgetContext,
  BudgetUsage,
  BudgetedResponse,
  TokenBudgetConfig,
  BudgetScope,
  ExceededStrategy,
} from './types.js';

/**
 * Agent Loop Guards — Core Implementation
 *
 * Wraps an agent's tool-calling loop with three enforcement layers:
 * 1. Budget Gate — hard limits on turns, tokens, and wall-clock time
 * 2. Convergence Detector — repetition and progress analysis
 * 3. Completion Check — natural termination detection
 */

import { createHash } from 'crypto';
import type {
  AgentResult,
  HaltReason,
  LLMProvider,
  LLMResponse,
  LoopContext,
  LoopGuardConfig,
  Message,
  ToolCall,
  ToolDefinition,
  ToolExecutor,
} from './types';
import { DEFAULT_CONFIG } from './types';

export class AgentLoopGuard {
  private config: LoopGuardConfig;

  constructor(config: Partial<LoopGuardConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run the guarded agent loop.
   *
   * @param provider - LLM provider to call
   * @param tools - Tool definitions available to the agent
   * @param toolExecutor - Function that executes tool calls
   * @param messages - Initial messages (system prompt + user input)
   * @param abortSignal - Optional AbortSignal for external cancellation
   */
  async run(
    provider: LLMProvider,
    tools: ToolDefinition[],
    toolExecutor: ToolExecutor,
    messages: Message[],
    abortSignal?: AbortSignal
  ): Promise<AgentResult> {
    const context: LoopContext = {
      turnCount: 0,
      totalTokens: 0,
      elapsedMs: 0,
      toolCallHistory: [],
    };

    const startTime = performance.now();
    const conversationMessages = [...messages];
    let lastResponse: LLMResponse | undefined;

    while (true) {
      // Update elapsed time using monotonic clock (performance.now)
      // to avoid wall-clock skew issues in distributed environments
      context.elapsedMs = performance.now() - startTime;

      // --- Layer 1: Budget Gate ---
      const budgetHalt = this.checkBudget(context, abortSignal);
      if (budgetHalt) {
        return this.halt(budgetHalt, context, lastResponse);
      }

      // --- Layer 2: LLM Call ---
      let response: LLMResponse;
      try {
        response = await provider.call(conversationMessages, tools);
      } catch (error) {
        // LLM call failure — include in context and halt
        context.haltReason = 'max_turns'; // Treat as a budget issue
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          response: `Agent halted due to LLM error: ${errorMessage}`,
          halted: true,
          haltReason: 'max_turns',
          context,
        };
      }

      context.turnCount++;
      context.totalTokens += response.tokensUsed;
      lastResponse = response;

      // --- Layer 3: Completion Check (no tool calls = done) ---
      if (response.toolCalls.length === 0) {
        context.elapsedMs = performance.now() - startTime;
        return {
          response: response.text ?? '',
          halted: false,
          context,
        };
      }

      // --- Layer 4: Convergence Check (before executing tools) ---
      // Record tool calls for pattern detection
      for (const tc of response.toolCalls) {
        context.toolCallHistory.push(tc);
      }

      const convergenceHalt = this.checkConvergence(context);
      if (convergenceHalt) {
        return this.halt(convergenceHalt, context, lastResponse);
      }

      // --- Layer 5: Tool Execution ---
      for (const toolCall of response.toolCalls) {
        // Check abort signal between tool executions
        if (abortSignal?.aborted) {
          return this.halt('abort_signal', context, lastResponse);
        }

        let result: unknown;
        try {
          result = await toolExecutor(toolCall.name, toolCall.arguments);
        } catch (error) {
          result = { error: error instanceof Error ? error.message : String(error) };
        }

        // Add tool result to conversation
        conversationMessages.push({
          role: 'assistant',
          content: JSON.stringify({ toolCalls: [toolCall] }),
        });
        conversationMessages.push({
          role: 'tool',
          content: JSON.stringify(result),
          toolCallId: toolCall.name,
        });
      }

      // Add model's text response to conversation if present
      if (response.text) {
        conversationMessages.push({
          role: 'assistant',
          content: response.text,
        });
      }
    }
  }

  /**
   * Check hard budget limits.
   * Returns the halt reason if any limit is exceeded, undefined otherwise.
   */
  private checkBudget(context: LoopContext, abortSignal?: AbortSignal): HaltReason | undefined {
    if (abortSignal?.aborted) return 'abort_signal';
    if (context.turnCount >= this.config.maxTurns) return 'max_turns';
    if (context.totalTokens >= this.config.maxTokens) return 'max_tokens';
    if (context.elapsedMs >= this.config.maxDurationMs) return 'max_duration';
    return undefined;
  }

  /**
   * Check for convergence failures — repeated tool calls or lack of progress.
   *
   * Uses tool call identity (name + arguments hash) rather than full response
   * text, because response text varies even in loops (the model rephrases),
   * but identical tool arguments are a strong repetition signal.
   */
  private checkConvergence(context: LoopContext): HaltReason | undefined {
    const history = context.toolCallHistory;

    // Check for consecutive identical tool calls
    if (history.length >= this.config.maxRepeatedCalls) {
      const recentCalls = history.slice(-this.config.maxRepeatedCalls);
      const hashes = recentCalls.map(tc => this.hashToolCall(tc));
      if (hashes.every(h => h === hashes[0])) {
        return 'repeated_calls';
      }
    }

    // Check for cycles within the convergence window
    // A cycle is when the last N tool calls repeat an earlier sequence
    if (history.length >= this.config.convergenceWindow * 2) {
      const windowSize = this.config.convergenceWindow;
      const recent = history.slice(-windowSize).map(tc => this.hashToolCall(tc));
      const prior = history.slice(-windowSize * 2, -windowSize).map(tc => this.hashToolCall(tc));

      if (recent.every((h, i) => h === prior[i])) {
        return 'no_progress';
      }
    }

    return undefined;
  }

  /**
   * Hash a tool call for deduplication.
   * Uses SHA-256 truncated to 16 chars for collision resistance
   * without excessive memory use in the history array.
   */
  private hashToolCall(tc: ToolCall): string {
    const payload = JSON.stringify({ name: tc.name, args: tc.arguments });
    return createHash('sha256').update(payload).digest('hex').slice(0, 16);
  }

  /** Build a halt result with context and reason */
  private halt(
    reason: HaltReason,
    context: LoopContext,
    lastResponse?: LLMResponse
  ): AgentResult {
    context.haltReason = reason;
    context.elapsedMs = performance.now() - (performance.now() - context.elapsedMs);

    if (this.config.onHalt) {
      this.config.onHalt(reason, context);
    }

    return {
      response: lastResponse?.text ?? `Agent halted: ${reason}`,
      halted: true,
      haltReason: reason,
      context,
    };
  }

  /** Get current configuration (for inspection/testing) */
  getConfig(): Readonly<LoopGuardConfig> {
    return { ...this.config };
  }
}

export { DEFAULT_CONFIG } from './types';
export type {
  AgentResult,
  HaltReason,
  LLMProvider,
  LLMResponse,
  LoopContext,
  LoopGuardConfig,
  Message,
  ToolCall,
  ToolDefinition,
  ToolExecutor,
} from './types';

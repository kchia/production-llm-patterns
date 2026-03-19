export type Role = 'system' | 'user' | 'assistant';
export type StrategyName = 'sliding-window' | 'priority' | 'summarize';

export interface Message {
  role: Role;
  content: string;
  /** Unique identifier for this message — returned by add(), used by remove(). */
  id: string;
  /**
   * Importance score from 0–1. Higher = more likely to survive trimming.
   * Defaults to 0.5 if not set. System messages ignore this — they're always kept.
   */
  priority: number;
  /** Cached token count. Populated by ContextManager.add() to avoid re-counting. */
  tokens?: number;
}

export interface ContextConfig {
  /** Total context window size for the model being called. Match to the model. */
  maxTokens: number;
  /**
   * Tokens to reserve for the model's output.
   * Available message budget = maxTokens - reserveForOutput.
   */
  reserveForOutput: number;
  /** How to trim messages when total tokens exceed available budget. */
  strategy: StrategyName;
  /**
   * Summarize strategy only: how many of the most recent messages to keep verbatim.
   * Older messages are compressed into a summary placeholder.
   */
  keepRecent: number;
}

export interface ContextWindow {
  /** Messages to send to the LLM. Safe to pass directly as the messages array. */
  messages: Message[];
  /** Total tokens for the included messages. */
  totalTokens: number;
  /** Number of messages excluded due to budget constraints. */
  droppedMessages: number;
  /** Fraction of available budget consumed (0–1). Alert if approaching 1.0. */
  budgetUsed: number;
  /** Which strategy was used to produce this window. */
  strategy: StrategyName;
}

export interface ContextStats {
  totalMessages: number;
  totalTokens: number;
  /** Fraction of available budget currently used by the full history. */
  budgetUsed: number;
}

export interface Tokenizer {
  countTokens(text: string): number;
}

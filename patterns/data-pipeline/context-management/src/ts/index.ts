import type {
  ContextConfig,
  ContextStats,
  ContextWindow,
  Message,
  Role,
  StrategyName,
  Tokenizer,
} from './types.js';
import { createMockSummarizer, createMockTokenizer, type Summarizer } from './mock-provider.js';

export { createMockSummarizer, createMockTokenizer } from './mock-provider.js';
export type {
  ContextConfig,
  ContextStats,
  ContextWindow,
  Message,
  Tokenizer,
} from './types.js';

// ─── Default Configuration ────────────────────────────────────────────────────

const DEFAULTS: ContextConfig = {
  maxTokens: 128_000,
  reserveForOutput: 4_000,
  strategy: 'sliding-window',
  keepRecent: 10,
};

// ─── ID Generation ────────────────────────────────────────────────────────────

let _idCounter = 0;
function generateId(): string {
  return `msg-${Date.now()}-${++_idCounter}`;
}

// ─── Trim Strategies ─────────────────────────────────────────────────────────

/**
 * Keeps all system messages and the most recent non-system messages that fit.
 * Simple and predictable — recency bias is usually correct for conversations.
 */
function slidingWindow(
  messages: Message[],
  budget: number,
  tokenizer: Tokenizer,
): Message[] {
  const systemMessages = messages.filter((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');

  const systemTokens = systemMessages.reduce(
    (sum, m) => sum + (m.tokens ?? tokenizer.countTokens(m.content)),
    0,
  );
  let remaining = budget - systemTokens;

  // Walk non-system messages from most recent to oldest, keeping what fits.
  const kept: Message[] = [];
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const msgTokens = nonSystem[i].tokens ?? tokenizer.countTokens(nonSystem[i].content);
    if (msgTokens <= remaining) {
      kept.unshift(nonSystem[i]);
      remaining -= msgTokens;
    }
    // Messages that don't fit are silently dropped (counted in ContextWindow.droppedMessages)
  }

  return [...systemMessages, ...kept];
}

/**
 * Keeps all system messages and the highest-priority non-system messages that fit.
 * Within equal priority, recency wins (higher index = more recent).
 *
 * Requires callers to set meaningful priority scores — otherwise degrades to
 * an arbitrary selection where all messages share the same default priority.
 */
function priorityTrim(
  messages: Message[],
  budget: number,
  tokenizer: Tokenizer,
): Message[] {
  const systemMessages = messages.filter((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');

  const systemTokens = systemMessages.reduce(
    (sum, m) => sum + (m.tokens ?? tokenizer.countTokens(m.content)),
    0,
  );
  let remaining = budget - systemTokens;

  // Sort by priority descending, then by original index descending (recency tiebreaker).
  const indexed = nonSystem.map((m, i) => ({ m, i }));
  indexed.sort((a, b) => {
    const pd = b.m.priority - a.m.priority;
    return pd !== 0 ? pd : b.i - a.i;
  });

  const selected: Array<{ m: Message; i: number }> = [];
  for (const entry of indexed) {
    const msgTokens = entry.m.tokens ?? tokenizer.countTokens(entry.m.content);
    if (msgTokens <= remaining) {
      selected.push(entry);
      remaining -= msgTokens;
    }
  }

  // Restore original order for the LLM call.
  selected.sort((a, b) => a.i - b.i);
  return [...systemMessages, ...selected.map((e) => e.m)];
}

/**
 * Keeps the most recent `keepRecent` non-system messages verbatim.
 * Compresses older messages into a single summary message.
 * Falls back to sliding-window if summary itself doesn't fit.
 *
 * In production: replace MockSummarizer with a real LLM compression call
 * (run asynchronously, not inline, to avoid doubling per-request latency).
 */
function summarizeTrim(
  messages: Message[],
  budget: number,
  keepRecent: number,
  tokenizer: Tokenizer,
  summarizer: Summarizer,
): Message[] {
  const systemMessages = messages.filter((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');

  const systemTokens = systemMessages.reduce(
    (sum, m) => sum + (m.tokens ?? tokenizer.countTokens(m.content)),
    0,
  );
  const availableForNonSystem = budget - systemTokens;

  // Recent messages stay verbatim.
  const recentMessages = nonSystem.slice(-keepRecent);
  const olderMessages = nonSystem.slice(0, -keepRecent);

  const recentTokens = recentMessages.reduce(
    (sum, m) => sum + (m.tokens ?? tokenizer.countTokens(m.content)),
    0,
  );

  if (olderMessages.length === 0) {
    // Nothing to compress — just keep recent within budget.
    return [...systemMessages, ...slidingWindow(recentMessages, availableForNonSystem, tokenizer)];
  }

  const summaryBudget = availableForNonSystem - recentTokens;
  if (summaryBudget <= 0) {
    // No room for even a summary — fall back to sliding window over full history.
    return slidingWindow(messages, budget, tokenizer);
  }

  const summary = summarizer.compress(olderMessages, summaryBudget);
  const summaryTokens = summary.tokens ?? tokenizer.countTokens(summary.content);

  if (summaryTokens > summaryBudget) {
    // Summary itself is too large — fall back to sliding window.
    return slidingWindow(messages, budget, tokenizer);
  }

  return [...systemMessages, summary, ...recentMessages];
}

// ─── ContextManager (Public API) ──────────────────────────────────────────────

/**
 * Manages what goes into an LLM context window.
 *
 * Maintains a growing history of messages and trims to a token budget when
 * build() is called. The trimming strategy is configurable; system messages
 * are always preserved regardless of strategy.
 *
 * Usage:
 *   const manager = new ContextManager({ maxTokens: 128_000, reserveForOutput: 4_000 });
 *   manager.add({ role: 'system', content: 'You are a helpful assistant.' });
 *   manager.add({ role: 'user', content: 'Hello!' });
 *   const window = manager.build();
 *   // Pass window.messages to your LLM API call.
 */
export class ContextManager {
  private readonly config: ContextConfig;
  private readonly tokenizer: Tokenizer;
  private readonly summarizer: Summarizer;
  private history: Message[] = [];

  constructor(
    config: Partial<ContextConfig> = {},
    tokenizer?: Tokenizer,
    summarizer?: Summarizer,
  ) {
    this.config = { ...DEFAULTS, ...config };
    this.tokenizer = tokenizer ?? createMockTokenizer();
    this.summarizer = summarizer ?? createMockSummarizer(this.tokenizer);
  }

  /**
   * Add a message to the history.
   * Token count is cached on the message object to avoid re-counting on every build().
   * @returns The generated message id (use with remove() if needed).
   */
  add(message: Omit<Message, 'id'> & { id?: string }): string {
    const id = message.id ?? generateId();
    const tokens = this.tokenizer.countTokens(message.content);
    this.history.push({
      role: message.role,
      content: message.content,
      id,
      priority: message.priority ?? 0.5,
      tokens,
    });
    return id;
  }

  /**
   * Remove a specific message by id.
   * @returns true if the message was found and removed.
   */
  remove(id: string): boolean {
    const idx = this.history.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    this.history.splice(idx, 1);
    return true;
  }

  /** Clear all history. */
  clear(): void {
    this.history = [];
  }

  /** Read-only view of the full history (before any trimming). */
  getHistory(): ReadonlyArray<Message> {
    return this.history;
  }

  /**
   * Build a context window that fits within the token budget.
   * Applies the configured strategy if trimming is needed.
   * System messages are always preserved.
   */
  build(): ContextWindow {
    const available = this.config.maxTokens - this.config.reserveForOutput;
    const allTokens = this.history.reduce(
      (sum, m) => sum + (m.tokens ?? this.tokenizer.countTokens(m.content)),
      0,
    );

    let included: Message[];

    if (allTokens <= available) {
      // Everything fits — no trimming needed.
      included = [...this.history];
    } else {
      included = this.applyStrategy(available);
    }

    const totalTokens = included.reduce(
      (sum, m) => sum + (m.tokens ?? this.tokenizer.countTokens(m.content)),
      0,
    );

    return {
      messages: included,
      totalTokens,
      droppedMessages: this.history.length - included.length,
      budgetUsed: available > 0 ? totalTokens / available : 0,
      strategy: this.config.strategy,
    };
  }

  /** Current memory and budget stats without building a trimmed window. */
  stats(): ContextStats {
    const available = this.config.maxTokens - this.config.reserveForOutput;
    const totalTokens = this.history.reduce(
      (sum, m) => sum + (m.tokens ?? this.tokenizer.countTokens(m.content)),
      0,
    );
    return {
      totalMessages: this.history.length,
      totalTokens,
      budgetUsed: available > 0 ? totalTokens / available : 0,
    };
  }

  getConfig(): Readonly<ContextConfig> {
    return { ...this.config };
  }

  private applyStrategy(budget: number): Message[] {
    switch (this.config.strategy) {
      case 'sliding-window':
        return slidingWindow(this.history, budget, this.tokenizer);
      case 'priority':
        return priorityTrim(this.history, budget, this.tokenizer);
      case 'summarize':
        return summarizeTrim(
          this.history,
          budget,
          this.config.keepRecent,
          this.tokenizer,
          this.summarizer,
        );
    }
  }
}

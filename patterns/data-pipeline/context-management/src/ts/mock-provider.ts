/**
 * Mock tokenizer and summarizer for tests and benchmarks.
 *
 * In production, replace MockTokenizer with tiktoken or a model-specific tokenizer.
 * Replace MockSummarizer with an actual LLM call that compresses conversation history.
 */

import type { Message, Tokenizer } from './types.js';

// ─── Mock Tokenizer ───────────────────────────────────────────────────────────

export class MockTokenizer implements Tokenizer {
  private readonly tokensPerWord: number;
  private readonly errorRate: number;
  private _callCount = 0;

  constructor(opts: { tokensPerWord?: number; errorRate?: number } = {}) {
    // Real GPT tokenizers average ~1.3 tokens/word for English prose.
    this.tokensPerWord = opts.tokensPerWord ?? 1.3;
    this.errorRate = opts.errorRate ?? 0;
  }

  countTokens(text: string): number {
    this._callCount++;
    if (this.errorRate > 0 && Math.random() < this.errorRate) {
      throw new Error('MockTokenizer: simulated tokenization failure');
    }
    const words = text.split(/\s+/).filter(Boolean).length;
    return Math.ceil(words * this.tokensPerWord);
  }

  get callCount(): number {
    return this._callCount;
  }
}

export function createMockTokenizer(opts: { tokensPerWord?: number } = {}): MockTokenizer {
  return new MockTokenizer(opts);
}

// ─── Mock Summarizer ──────────────────────────────────────────────────────────

/**
 * Mock compressor for the summarize strategy.
 *
 * In production, replace with an LLM call:
 *   const summary = await openai.chat.completions.create({
 *     messages: [{ role: 'user', content: `Summarize: ${JSON.stringify(messages)}` }],
 *     max_tokens: targetTokens,
 *   });
 *
 * The mock produces a deterministic placeholder so tests stay fast and offline.
 */
export interface Summarizer {
  compress(messages: Message[], targetTokens: number): Message;
}

export class MockSummarizer implements Summarizer {
  private readonly tokenizer: Tokenizer;

  constructor(tokenizer?: Tokenizer) {
    this.tokenizer = tokenizer ?? createMockTokenizer();
  }

  compress(messages: Message[], targetTokens: number): Message {
    const totalOriginalTokens = messages.reduce(
      (sum, m) => sum + (m.tokens ?? this.tokenizer.countTokens(m.content)),
      0,
    );
    const content = `[Summary: ${messages.length} messages (${totalOriginalTokens} tokens) compressed]`;
    return {
      role: 'user',
      content,
      id: `summary-${Date.now()}`,
      priority: 0.9, // summaries are high-priority — they represent compressed history
      tokens: this.tokenizer.countTokens(content),
    };
  }
}

export function createMockSummarizer(tokenizer?: Tokenizer): MockSummarizer {
  return new MockSummarizer(tokenizer);
}

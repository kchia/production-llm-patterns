import { describe, it, expect, vi } from 'vitest';
import {
  MockProvider,
  ProviderError,
  createStaticHandler,
  createCacheHandler,
  createRuleBasedHandler,
  createSequenceProvider,
  mockLLMStream,
  MockSlowConsumer,
} from '../index.js';
import type { LLMRequest } from '../index.js';

const req: LLMRequest = { prompt: 'test prompt' };

// ─── MockProvider Unit Tests ──────────────────────────────────────────────────

describe('MockProvider', () => {
  it('returns a response with content and tokensUsed', async () => {
    const provider = new MockProvider({ latencyMs: 0, tokensPerResponse: 42 });
    const res = await provider.call(req);
    expect(res.content).toBeTruthy();
    expect(res.tokensUsed).toBe(42);
    expect(res.model).toBe('mock-model');
    expect(res.finishReason).toBe('stop');
  });

  it('uses static responseContent when provided', async () => {
    const provider = new MockProvider({ latencyMs: 0, responseContent: 'hello world' });
    const res = await provider.call(req);
    expect(res.content).toBe('hello world');
  });

  it('generates content from prompt when responseContent is empty', async () => {
    const provider = new MockProvider({ latencyMs: 0 });
    const res = await provider.call({ prompt: 'What is 2+2?' });
    expect(res.content).toContain('What is 2+2');
  });

  it('uses custom model name', async () => {
    const provider = new MockProvider({ latencyMs: 0, model: 'gpt-4o-test' });
    const res = await provider.call(req);
    expect(res.model).toBe('gpt-4o-test');
  });

  it('tracks call count', async () => {
    const provider = new MockProvider({ latencyMs: 0 });
    expect(provider.callCount).toBe(0);
    await provider.call(req);
    await provider.call(req);
    expect(provider.callCount).toBe(2);
  });

  it('increments call count even on failure', async () => {
    const provider = new MockProvider({ latencyMs: 0, failureRate: 1.0 });
    try { await provider.call(req); } catch { /* expected */ }
    expect(provider.callCount).toBe(1);
  });

  it('resets call count and sequence index', async () => {
    const provider = new MockProvider({
      latencyMs: 0,
      errorSequence: [503],
    });
    try { await provider.call(req); } catch { /* expected */ }
    provider.reset();
    expect(provider.callCount).toBe(0);
    // After reset, sequence restarts — 503 again
    await expect(provider.call(req)).rejects.toThrow(ProviderError);
  });

  it('throws ProviderError on failure with correct statusCode', async () => {
    const provider = new MockProvider({
      latencyMs: 0,
      failureRate: 1.0,
      failureStatusCode: 429,
    });
    await expect(provider.call(req)).rejects.toBeInstanceOf(ProviderError);
    try {
      await provider.call(req);
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).statusCode).toBe(429);
    }
  });

  it('attaches retryAfterMs to 429 errors', async () => {
    const provider = new MockProvider({
      latencyMs: 0,
      failureRate: 1.0,
      failureStatusCode: 429,
      retryAfterMs: 500,
    });
    try {
      await provider.call(req);
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).retryAfterMs).toBe(500);
    }
  });

  it('does not attach retryAfterMs to non-429 errors', async () => {
    const provider = new MockProvider({
      latencyMs: 0,
      failureRate: 1.0,
      failureStatusCode: 503,
      retryAfterMs: 500,
    });
    try {
      await provider.call(req);
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).retryAfterMs).toBeUndefined();
    }
  });

  it('follows deterministic error sequence in order', async () => {
    const provider = new MockProvider({
      latencyMs: 0,
      errorSequence: [503, 'success', 429],
    });

    await expect(provider.call(req)).rejects.toMatchObject({ statusCode: 503 });
    const res = await provider.call(req);
    expect(res.finishReason).toBe('stop');
    await expect(provider.call(req)).rejects.toMatchObject({ statusCode: 429 });
  });

  it('falls back to probabilistic failure after sequence exhaustion', async () => {
    const provider = new MockProvider({
      latencyMs: 0,
      errorSequence: ['success'],
      failureRate: 1.0, // always fail after sequence
    });

    const res = await provider.call(req); // consumed 'success'
    expect(res.finishReason).toBe('stop');
    await expect(provider.call(req)).rejects.toBeInstanceOf(ProviderError);
  });

  it('updateConfig modifies behavior mid-test', async () => {
    const provider = new MockProvider({ latencyMs: 0, failureRate: 0 });
    const res1 = await provider.call(req);
    expect(res1.finishReason).toBe('stop');

    provider.updateConfig({ failureRate: 1.0 });
    await expect(provider.call(req)).rejects.toBeInstanceOf(ProviderError);
  });

  it('updateConfig replaces errorSequence and resets sequence index', async () => {
    const provider = new MockProvider({
      latencyMs: 0,
      errorSequence: [503, 503], // would fail twice
    });

    provider.updateConfig({ errorSequence: ['success', 'success'] });
    const r1 = await provider.call(req);
    const r2 = await provider.call(req);
    expect(r1.finishReason).toBe('stop');
    expect(r2.finishReason).toBe('stop');
  });

  it('records latencyMs in response', async () => {
    const provider = new MockProvider({ latencyMs: 20 });
    const res = await provider.call(req);
    // latencyMs should be >= configured delay
    expect(res.latencyMs).toBeGreaterThanOrEqual(15);
  });
});

// ─── ProviderError Unit Tests ─────────────────────────────────────────────────

describe('ProviderError', () => {
  it('has correct name', () => {
    const err = new ProviderError('oops', 503);
    expect(err.name).toBe('ProviderError');
  });

  it('carries statusCode', () => {
    const err = new ProviderError('rate limited', 429);
    expect(err.statusCode).toBe(429);
  });

  it('carries retryAfterMs when provided', () => {
    const err = new ProviderError('too many', 429, { retryAfterMs: 1000 });
    expect(err.retryAfterMs).toBe(1000);
  });

  it('has undefined retryAfterMs when omitted', () => {
    const err = new ProviderError('server error', 500);
    expect(err.retryAfterMs).toBeUndefined();
  });
});

// ─── Handler Factory Tests ────────────────────────────────────────────────────

describe('createStaticHandler', () => {
  it('always returns the configured content', async () => {
    const handler = createStaticHandler('fallback response');
    const res = await handler({ prompt: 'anything' });
    expect(res.content).toBe('fallback response');
    expect(res.model).toBe('static');
    expect(res.finishReason).toBe('static_fallback');
  });
});

describe('createCacheHandler', () => {
  it('throws on cache miss', async () => {
    const { handler } = createCacheHandler();
    await expect(handler({ prompt: 'unseen' })).rejects.toThrow('Cache miss');
  });

  it('returns cached content after populate', async () => {
    const { handler, populate } = createCacheHandler();
    populate('my prompt', 'my cached response');
    const res = await handler({ prompt: 'my prompt' });
    expect(res.content).toBe('my cached response');
    expect(res.finishReason).toBe('cache_hit');
  });

  it('clear empties the cache', async () => {
    const { handler, populate, clear } = createCacheHandler();
    populate('q', 'a');
    clear();
    await expect(handler({ prompt: 'q' })).rejects.toThrow('Cache miss');
  });

  it('tracks size accurately', () => {
    const { populate, clear, size } = createCacheHandler();
    expect(size).toBe(0);
    populate('a', 'response a');
    expect(size).toBe(1);
    clear();
    expect(size).toBe(0);
  });
});

describe('createRuleBasedHandler', () => {
  it('matches first rule', async () => {
    const handler = createRuleBasedHandler([
      { pattern: /hello/i, response: 'Hi there!' },
      { pattern: /.*/,     response: 'Fallback' },
    ]);
    const res = await handler({ prompt: 'hello world' });
    expect(res.content).toBe('Hi there!');
    expect(res.finishReason).toBe('rule_match');
  });

  it('falls through to second rule', async () => {
    const handler = createRuleBasedHandler([
      { pattern: /hello/i, response: 'Hi there!' },
      { pattern: /help/i,  response: 'Here to help' },
    ]);
    const res = await handler({ prompt: 'I need help' });
    expect(res.content).toBe('Here to help');
  });

  it('throws when no rule matches', async () => {
    const handler = createRuleBasedHandler([
      { pattern: /hello/i, response: 'Hi!' },
    ]);
    await expect(handler({ prompt: 'xyz123' })).rejects.toThrow('No matching rule');
  });
});

describe('createSequenceProvider', () => {
  it('returns responses in order and cycles', async () => {
    const p = createSequenceProvider(['a', 'b', 'c'], { latencyMs: 0 });
    const r1 = await p.call(req);
    const r2 = await p.call(req);
    const r3 = await p.call(req);
    const r4 = await p.call(req); // cycles back
    expect(r1.content).toBe('a');
    expect(r2.content).toBe('b');
    expect(r3.content).toBe('c');
    expect(r4.content).toBe('a');
  });

  it('tracks callIndex', async () => {
    const p = createSequenceProvider(['x', 'y'], { latencyMs: 0 });
    expect(p.callIndex).toBe(0);
    await p.call(req);
    expect(p.callIndex).toBe(1);
  });

  it('reset restarts the sequence', async () => {
    const p = createSequenceProvider(['first', 'second'], { latencyMs: 0 });
    await p.call(req);
    p.reset();
    const res = await p.call(req);
    expect(res.content).toBe('first');
  });

  it('throws on empty responses', () => {
    expect(() => createSequenceProvider([])).toThrow('responses must be non-empty');
  });
});

// ─── Streaming Mock Tests ─────────────────────────────────────────────────────

describe('mockLLMStream', () => {
  async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
    const chunks: string[] = [];
    for await (const chunk of gen) chunks.push(chunk);
    return chunks;
  }

  it('emits tokenCount chunks', async () => {
    const chunks = await collect(mockLLMStream({ tokenCount: 5, tokenDelayMs: 0 }));
    expect(chunks).toHaveLength(5);
  });

  it('uses custom tokenContent', async () => {
    const chunks = await collect(mockLLMStream({ tokenCount: 3, tokenDelayMs: 0, tokenContent: 'word ' }));
    expect(chunks).toEqual(['word ', 'word ', 'word ']);
  });

  it('throws at errorAfterTokens', async () => {
    const gen = mockLLMStream({ tokenCount: 10, tokenDelayMs: 0, errorAfterTokens: 3 });
    const chunks: string[] = [];
    await expect(async () => {
      for await (const chunk of gen) chunks.push(chunk);
    }).rejects.toThrow('injected error at token 3');
    expect(chunks).toHaveLength(3);
  });

  it('stops early on AbortSignal', async () => {
    const controller = new AbortController();
    const chunks: string[] = [];
    const gen = mockLLMStream({ tokenCount: 100, tokenDelayMs: 5 }, controller.signal);

    for await (const chunk of gen) {
      chunks.push(chunk);
      if (chunks.length === 3) controller.abort();
    }

    // Should stop shortly after abort — not all 100 tokens
    expect(chunks.length).toBeLessThan(20);
  });
});

describe('MockSlowConsumer', () => {
  it('returns true when buffer has capacity', () => {
    const consumer = new MockSlowConsumer(5, 0);
    const canWrite = consumer.write('chunk');
    expect(canWrite).toBe(true);
    expect(consumer.written).toHaveLength(1);
  });

  it('returns false when buffer reaches capacity', () => {
    const consumer = new MockSlowConsumer(2, 0);
    consumer.write('a');
    const backpressure = consumer.write('b'); // fills to capacity
    expect(backpressure).toBe(false);
  });

  it('emits drain and allows writes after drain delay', async () => {
    const consumer = new MockSlowConsumer(2, 10);
    consumer.write('a');
    consumer.write('b'); // triggers backpressure

    await new Promise<void>((resolve) => consumer.once('drain', resolve));

    const canWriteAfterDrain = consumer.write('c');
    expect(canWriteAfterDrain).toBe(true);
    expect(consumer.drainCount).toBeGreaterThan(0);
  });

  it('tracks all written chunks', () => {
    const consumer = new MockSlowConsumer(10, 0);
    consumer.write('x');
    consumer.write('y');
    consumer.write('z');
    expect(consumer.written).toEqual(['x', 'y', 'z']);
  });
});

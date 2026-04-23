/**
 * test-fixtures — Core Implementation
 *
 * Exports:
 *   MockProvider          — mock LLM with latency, failure rate, error sequences
 *   ProviderError         — typed provider error (re-exported from types)
 *   createStaticHandler   — always returns the same response
 *   createCacheHandler    — prompt-keyed in-memory cache handler
 *   createRuleBasedHandler — regex-matched rule handler
 *   createSequenceProvider — cycles through a fixed list of responses
 *   mockLLMStream         — async generator simulating token streaming
 *   MockSlowConsumer      — writable sink with configurable backpressure
 *
 * Every pattern's mock-provider.ts duplicated a subset of this. Import from
 * here — one canonical implementation, same behavior across all 35 patterns.
 */

import type {
  LLMRequest,
  LLMResponse,
  MockProviderConfig,
  MockStreamOptions,
} from './types.js';

export { ProviderError } from './types.js';
export type { LLMRequest, LLMResponse, MockProviderConfig, MockStreamOptions } from './types.js';

import { ProviderError } from './types.js';

// ─── MockProvider ─────────────────────────────────────────────────────────────

/**
 * Mock LLM provider with configurable latency, token counts, and error injection.
 *
 * Design decisions:
 * - Deterministic `errorSequence` takes priority over probabilistic `failureRate`.
 *   This lets tests script exact failure patterns without relying on Math.random().
 * - `retryAfterMs` only attaches to 429 errors, matching real provider behavior.
 * - `latencyMs: 0` skips the setTimeout entirely — avoids event loop overhead
 *   in tight benchmark loops.
 */
export class MockProvider {
  private config: Required<
    Pick<
      MockProviderConfig,
      | 'latencyMs'
      | 'failureRate'
      | 'failureStatusCode'
      | 'errorMessage'
      | 'retryAfterMs'
      | 'tokensPerResponse'
      | 'model'
      | 'responseContent'
    >
  > & { errorSequence: Array<'success' | number> };

  private _callCount = 0;
  private _sequenceIndex = 0;

  constructor(config: MockProviderConfig = {}) {
    this.config = {
      latencyMs:         config.latencyMs         ?? 50,
      failureRate:       config.failureRate        ?? 0.0,
      failureStatusCode: config.failureStatusCode  ?? 503,
      errorMessage:      config.errorMessage       ?? 'Provider unavailable',
      retryAfterMs:      config.retryAfterMs       ?? 0,
      tokensPerResponse: config.tokensPerResponse  ?? 100,
      model:             config.model              ?? 'mock-model',
      responseContent:   config.responseContent    ?? '',
      errorSequence:     config.errorSequence      ?? [],
    };
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    this._callCount++;
    const start = performance.now();

    if (this.config.latencyMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.config.latencyMs));
    }

    // Deterministic sequence takes priority over probabilistic failure
    if (this._sequenceIndex < this.config.errorSequence.length) {
      const outcome = this.config.errorSequence[this._sequenceIndex++];
      if (outcome !== 'success') {
        this._throwProviderError(outcome);
      }
      // 'success' falls through to the response below
    } else if (Math.random() < this.config.failureRate) {
      this._throwProviderError(this.config.failureStatusCode);
    }

    const latencyMs = performance.now() - start;
    const content =
      this.config.responseContent ||
      `Mock response for: ${request.prompt.slice(0, 50)}`;

    return {
      content,
      tokensUsed: this.config.tokensPerResponse,
      model: this.config.model,
      finishReason: 'stop',
      latencyMs,
    };
  }

  private _throwProviderError(statusCode: number): never {
    const retryAfter =
      statusCode === 429 && this.config.retryAfterMs > 0
        ? this.config.retryAfterMs
        : undefined;
    throw new ProviderError(this.config.errorMessage, statusCode, {
      retryAfterMs: retryAfter,
    });
  }

  /** Total calls made to this provider (including failures). */
  get callCount(): number {
    return this._callCount;
  }

  /** Resets call counter and error sequence index. Safe to call between tests. */
  reset(): void {
    this._callCount = 0;
    this._sequenceIndex = 0;
  }

  /** Applies partial config updates mid-test without constructing a new provider. */
  updateConfig(partial: Partial<MockProviderConfig>): void {
    if (partial.latencyMs         !== undefined) this.config.latencyMs         = partial.latencyMs;
    if (partial.failureRate       !== undefined) this.config.failureRate       = partial.failureRate;
    if (partial.failureStatusCode !== undefined) this.config.failureStatusCode = partial.failureStatusCode;
    if (partial.errorMessage      !== undefined) this.config.errorMessage      = partial.errorMessage;
    if (partial.retryAfterMs      !== undefined) this.config.retryAfterMs      = partial.retryAfterMs;
    if (partial.tokensPerResponse !== undefined) this.config.tokensPerResponse = partial.tokensPerResponse;
    if (partial.model             !== undefined) this.config.model             = partial.model;
    if (partial.responseContent   !== undefined) this.config.responseContent   = partial.responseContent;
    if (partial.errorSequence     !== undefined) {
      this.config.errorSequence = partial.errorSequence;
      this._sequenceIndex = 0; // Reset index when sequence is replaced
    }
  }
}

// ─── Handler Factories ────────────────────────────────────────────────────────

/**
 * A handler that always returns the same response content.
 * Zero latency, zero dependencies — the last resort in degradation chains.
 */
export function createStaticHandler(content: string) {
  return async (_request: LLMRequest): Promise<LLMResponse> => ({
    content,
    model: 'static',
    finishReason: 'static_fallback',
  });
}

/**
 * A simple prompt-keyed in-memory cache handler.
 *
 * Returns a cache-miss error when the prompt hasn't been populated.
 * Use `populate(prompt, content)` in test setup to seed it.
 */
export function createCacheHandler() {
  const cache = new Map<string, { content: string; cachedAt: number }>();

  const handler = async (request: LLMRequest): Promise<LLMResponse> => {
    const entry = cache.get(request.prompt);
    if (!entry) throw new Error('Cache miss');
    return {
      content: entry.content,
      model: 'cache',
      finishReason: 'cache_hit',
    };
  };

  return {
    handler,
    populate: (prompt: string, content: string): void => {
      cache.set(prompt, { content, cachedAt: Date.now() });
    },
    clear: (): void => cache.clear(),
    get size(): number { return cache.size; },
  };
}

/**
 * A rule-based handler that matches prompts against regex patterns.
 *
 * Rules are evaluated in order — first match wins. Throws on no match.
 * Useful for testing degradation chains where a rule tier handles predictable
 * intents without a real LLM call.
 */
export function createRuleBasedHandler(
  rules: Array<{ pattern: RegExp; response: string }>,
) {
  return async (request: LLMRequest): Promise<LLMResponse> => {
    for (const rule of rules) {
      if (rule.pattern.test(request.prompt)) {
        return {
          content: rule.response,
          model: 'rule-based',
          finishReason: 'rule_match',
        };
      }
    }
    throw new Error('No matching rule');
  };
}

/**
 * Creates a provider that returns responses from a fixed list, in order.
 * After the list is exhausted, it cycles back to the beginning.
 *
 * Useful for testing multi-turn flows, A/B comparisons, and scenarios where
 * you need the Nth call to return a specific response.
 */
export function createSequenceProvider(
  responses: string[],
  options: { latencyMs?: number; model?: string } = {},
) {
  if (responses.length === 0) throw new Error('responses must be non-empty');
  let index = 0;
  const latencyMs = options.latencyMs ?? 0;
  const model = options.model ?? 'sequence-mock';

  return {
    call: async (_request: LLMRequest): Promise<LLMResponse> => {
      if (latencyMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, latencyMs));
      }
      const content = responses[index % responses.length];
      index++;
      return { content, model, finishReason: 'stop' };
    },
    /** Current position in the sequence (0-based). */
    get callIndex(): number { return index; },
    /** Reset to the beginning of the sequence. */
    reset: (): void => { index = 0; },
  };
}

// ─── Streaming Mocks ──────────────────────────────────────────────────────────

/**
 * Async generator that simulates an LLM streaming response.
 *
 * Honors the provided AbortSignal — stops early on cancellation, matching what
 * real LLM clients do when the downstream consumer disconnects.
 *
 * `errorAfterTokens` injects a mid-stream error, which tests backpressure
 * handlers and partial-content recovery logic.
 */
export async function* mockLLMStream(
  options: MockStreamOptions = {},
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const {
    tokenCount    = 100,
    tokenDelayMs  = 10,
    errorAfterTokens,
    tokenContent  = 'token ',
  } = options;

  for (let i = 0; i < tokenCount; i++) {
    if (signal?.aborted) return;

    if (errorAfterTokens !== undefined && i >= errorAfterTokens) {
      throw new Error(`mockLLMStream: injected error at token ${i}`);
    }

    yield tokenContent;

    if (tokenDelayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, tokenDelayMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('AbortError'));
        }, { once: true });
      }).catch(() => {
        return Promise.reject(new Error('AbortError'));
      });
    }
  }
}

/**
 * Writable sink that simulates a slow downstream consumer with backpressure.
 *
 * `write()` returns `false` (backpressure) when the internal buffer reaches
 * capacity. After a configurable drain delay, it emits 'drain' so producers
 * know they can resume. Mirrors the Node.js Writable stream interface.
 */
export class MockSlowConsumer {
  private buffer: string[] = [];
  private draining = false;
  private drainListeners: Array<() => void> = [];
  readonly written: string[] = [];
  drainCount = 0;

  constructor(
    private readonly bufferCapacity: number = 5,
    private readonly drainDelayMs: number = 20,
  ) {}

  /** Returns false when the buffer is full — caller must wait for 'drain'. */
  write(chunk: string): boolean {
    this.buffer.push(chunk);
    this.written.push(chunk);

    if (!this.draining && this.buffer.length >= this.bufferCapacity) {
      this.draining = true;
      setTimeout(() => {
        this.buffer = [];
        this.draining = false;
        this.drainCount++;
        const listeners = this.drainListeners.splice(0);
        for (const l of listeners) l();
      }, this.drainDelayMs);
      return false; // backpressure: pause producer
    }

    return true; // buffer has capacity
  }

  on(event: 'drain', listener: () => void): this {
    if (event === 'drain') this.drainListeners.push(listener);
    return this;
  }

  once(event: 'drain', listener: () => void): this {
    const wrapper = () => {
      listener();
      const idx = this.drainListeners.indexOf(wrapper);
      if (idx !== -1) this.drainListeners.splice(idx, 1);
    };
    this.drainListeners.push(wrapper);
    return this;
  }

  end(): void { /* no-op for mock */ }
}

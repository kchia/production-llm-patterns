/**
 * Mock LLM provider for testing and benchmarks.
 * Simulates realistic streaming behavior: configurable token rate,
 * latency, and error injection — no real API calls required.
 */
export interface MockProviderOptions {
  /** Tokens to emit per stream call. Default 100. */
  tokenCount?: number;
  /** Delay between tokens in ms. Default 10ms (~100 tokens/sec). */
  tokenDelayMs?: number;
  /** If set, throw this error after emitting `errorAfterTokens` tokens. */
  errorAfterTokens?: number;
  /** Content of each emitted token. Default 'token '. */
  tokenContent?: string;
}

/**
 * Simulates an LLM streaming response as an async generator.
 * Honors the provided AbortSignal — stops early on cancellation,
 * which is what real LLM clients should do on client disconnect.
 */
export async function* mockLLMStream(
  options: MockProviderOptions = {},
  signal?: AbortSignal
): AsyncGenerator<string> {
  const {
    tokenCount = 100,
    tokenDelayMs = 10,
    errorAfterTokens,
    tokenContent = 'token ',
  } = options;

  for (let i = 0; i < tokenCount; i++) {
    if (signal?.aborted) {
      return; // upstream cancellation: stop generating
    }

    if (errorAfterTokens !== undefined && i >= errorAfterTokens) {
      throw new Error(`MockProvider: injected error at token ${i}`);
    }

    yield tokenContent;

    if (tokenDelayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, tokenDelayMs);
        // Clean up timer if aborted mid-delay
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('AbortError'));
        }, { once: true });
      }).catch(() => {
        // AbortError from signal during delay — stop iteration
        return Promise.reject(new Error('AbortError'));
      });
    }
  }
}

/**
 * Creates a mock writable sink that simulates a slow consumer.
 * The sink's `write()` returns false (signaling backpressure) when
 * its internal buffer exceeds capacity, and emits 'drain' after a delay.
 */
export class MockSlowConsumer {
  private buffer: string[] = [];
  private draining = false;
  private drainListeners: (() => void)[] = [];
  private errorListeners: ((err: Error) => void)[] = [];
  public written: string[] = [];
  public drainCount = 0;

  constructor(
    private bufferCapacity: number = 5,
    private drainDelayMs: number = 20
  ) {}

  /**
   * Returns false when buffer is full (backpressure signal).
   * Callers must wait for 'drain' before calling write() again.
   */
  write(chunk: string): boolean {
    this.buffer.push(chunk);
    this.written.push(chunk);

    if (!this.draining && this.buffer.length >= this.bufferCapacity) {
      this.draining = true;
      // Simulate slow consumer: drain after delay
      setTimeout(() => {
        this.buffer = [];
        this.draining = false;
        this.drainCount++;
        const listeners = this.drainListeners.splice(0);
        for (const l of listeners) l();
      }, this.drainDelayMs);
      return false; // backpressure: pause producer
    }

    return true; // buffer has capacity: producer may continue
  }

  on(event: 'drain', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this {
    if (event === 'drain') {
      this.drainListeners.push(listener as () => void);
    } else if (event === 'error') {
      this.errorListeners.push(listener as (err: Error) => void);
    }
    return this;
  }

  once(event: 'drain', listener: () => void): this {
    const wrapper = () => {
      listener();
      // Remove the wrapper from drainListeners if still present
      const idx = this.drainListeners.indexOf(wrapper);
      if (idx !== -1) this.drainListeners.splice(idx, 1);
    };
    this.drainListeners.push(wrapper);
    return this;
  }

  emit(event: 'drain' | 'error', ...args: unknown[]): void {
    if (event === 'drain') {
      const listeners = this.drainListeners.splice(0);
      for (const l of listeners) l();
    } else if (event === 'error') {
      for (const l of this.errorListeners) l(args[0] as Error);
    }
  }

  end(): void {
    /* no-op for mock */
  }
}

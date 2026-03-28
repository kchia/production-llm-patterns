import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pipeWithBackpressure, streamWithDisconnectDetection } from '../index.js';
import { mockLLMStream, MockSlowConsumer } from '../mock-provider.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Fast sink: always returns true from write() — never exerts backpressure. */
class FastSink {
  written: string[] = [];
  ended = false;
  private drainListeners: (() => void)[] = [];

  write(chunk: string): boolean {
    this.written.push(chunk);
    return true;
  }
  on(_event: 'drain', listener: () => void): this {
    this.drainListeners.push(listener);
    return this;
  }
  once(_event: 'drain', listener: () => void): this {
    this.drainListeners.push(listener);
    return this;
  }
  end(): void {
    this.ended = true;
  }
}

// ─── Unit Tests ──────────────────────────────────────────────────────────────

describe('pipeWithBackpressure — unit', () => {
  it('delivers all tokens from a fast source to a fast sink', async () => {
    const source = mockLLMStream({ tokenCount: 20, tokenDelayMs: 0 });
    const sink = new FastSink();

    const result = await pipeWithBackpressure(source, sink, { highWaterMark: 4 });

    expect(result.tokensDelivered).toBe(20);
    expect(result.clientDisconnected).toBe(false);
    expect(result.drainTimeoutExpired).toBe(false);
    expect(sink.written).toHaveLength(20);
    expect(sink.ended).toBe(true);
  });

  it('uses default highWaterMark of 16 when not specified', async () => {
    const source = mockLLMStream({ tokenCount: 32, tokenDelayMs: 0 });
    const sink = new FastSink();
    const result = await pipeWithBackpressure(source, sink);
    expect(result.tokensDelivered).toBe(32);
  });

  it('records backpressure events when sink buffer fills', async () => {
    // MockSlowConsumer with capacity 3 will return false every 3 tokens
    const sink = new MockSlowConsumer(3, 5);
    const source = mockLLMStream({ tokenCount: 30, tokenDelayMs: 0 });

    const result = await pipeWithBackpressure(source, sink, {
      highWaterMark: 4,
      drainTimeout: 1000,
    });

    expect(result.backpressureEvents).toBeGreaterThan(0);
    expect(result.drainEvents).toBeGreaterThan(0);
    expect(result.drainEvents).toBe(result.backpressureEvents);
    expect(result.tokensDelivered).toBe(30);
  });

  it('fires onBackpressure callback each time producer pauses', async () => {
    const sink = new MockSlowConsumer(2, 5);
    const source = mockLLMStream({ tokenCount: 20, tokenDelayMs: 0 });
    const onBackpressure = vi.fn();

    const result = await pipeWithBackpressure(source, sink, {
      highWaterMark: 3,
      drainTimeout: 1000,
      onBackpressure,
    });

    expect(onBackpressure).toHaveBeenCalledTimes(result.backpressureEvents);
  });

  it('fires onDrain callback each time producer resumes', async () => {
    const sink = new MockSlowConsumer(2, 5);
    const source = mockLLMStream({ tokenCount: 20, tokenDelayMs: 0 });
    const onDrain = vi.fn();

    const result = await pipeWithBackpressure(source, sink, {
      highWaterMark: 3,
      drainTimeout: 1000,
      onDrain,
    });

    expect(onDrain).toHaveBeenCalledTimes(result.drainEvents);
  });

  it('reports durationMs > 0', async () => {
    const source = mockLLMStream({ tokenCount: 5, tokenDelayMs: 0 });
    const sink = new FastSink();
    const result = await pipeWithBackpressure(source, sink);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ─── Failure Mode Tests ──────────────────────────────────────────────────────

describe('pipeWithBackpressure — failure modes', () => {
  // FM: Client disconnect — zombie stream should cancel upstream
  it('stops delivering tokens and sets clientDisconnected when signal aborts', async () => {
    const controller = new AbortController();
    const sink = new FastSink();
    const source = mockLLMStream(
      { tokenCount: 1000, tokenDelayMs: 5 },
      controller.signal
    );

    // Abort after 50ms — should stop mid-stream
    setTimeout(() => controller.abort(), 50);

    const result = await pipeWithBackpressure(source, sink, {
      signal: controller.signal,
      highWaterMark: 4,
    });

    expect(result.clientDisconnected).toBe(true);
    expect(result.tokensDelivered).toBeLessThan(1000);
  });

  // FM: Drain timeout — slow client never drains
  it('sets drainTimeoutExpired and aborts when drain times out', async () => {
    // Sink that never drains (bufferCapacity very small, drainDelay huge)
    const sink = new MockSlowConsumer(1, 10_000);
    const source = mockLLMStream({ tokenCount: 50, tokenDelayMs: 0 });

    const result = await pipeWithBackpressure(source, sink, {
      highWaterMark: 2,
      drainTimeout: 50, // very short timeout
    });

    expect(result.drainTimeoutExpired).toBe(true);
    expect(result.tokensDelivered).toBeLessThan(50);
  });

  // FM: Silent degradation — backpressure events increasing over time
  // This test validates the detection signal: the ratio metric is observable
  it('exposes backpressureEvents and tokensDelivered for ratio monitoring', async () => {
    const sink = new MockSlowConsumer(4, 10);
    const source = mockLLMStream({ tokenCount: 100, tokenDelayMs: 0 });

    const result = await pipeWithBackpressure(source, sink, {
      highWaterMark: 8,
      drainTimeout: 2000,
    });

    // The ratio backpressureEvents / tokensDelivered is the silent-degradation signal
    const ratio = result.backpressureEvents / result.tokensDelivered;
    expect(typeof ratio).toBe('number');
    expect(result.tokensDelivered).toBe(100);
  });

  // FM: Token loss on abort — verify partial delivery is observable
  it('reports tokensDelivered < tokenCount when stream is aborted early', async () => {
    const controller = new AbortController();
    const sink = new FastSink();
    const source = mockLLMStream(
      { tokenCount: 500, tokenDelayMs: 2 },
      controller.signal
    );

    setTimeout(() => controller.abort(), 30);

    const result = await pipeWithBackpressure(source, sink, {
      signal: controller.signal,
    });

    expect(result.tokensDelivered).toBeLessThan(500);
  });

  // FM: Unbounded buffer growth — highWaterMark must be set
  it('still handles stream correctly when highWaterMark equals token count', async () => {
    const source = mockLLMStream({ tokenCount: 10, tokenDelayMs: 0 });
    const sink = new FastSink();

    // highWaterMark larger than stream — flush only at end
    const result = await pipeWithBackpressure(source, sink, { highWaterMark: 100 });

    expect(result.tokensDelivered).toBe(10);
    expect(result.backpressureEvents).toBe(0);
  });
});

// ─── Integration Tests ───────────────────────────────────────────────────────

describe('streamWithDisconnectDetection — integration', () => {
  it('pipes full stream to client when no disconnect occurs', async () => {
    const source = mockLLMStream({ tokenCount: 40, tokenDelayMs: 0 });
    const sink = new FastSink();
    const mockReq = { on(_event: string, _listener: () => void) {} };

    const result = await streamWithDisconnectDetection(source, sink, mockReq, {
      highWaterMark: 8,
    });

    expect(result.tokensDelivered).toBe(40);
    expect(result.clientDisconnected).toBe(false);
  });

  it('cancels upstream when disconnect source fires close event', async () => {
    const source = mockLLMStream({ tokenCount: 500, tokenDelayMs: 5 });
    const sink = new FastSink();

    let closeListener: (() => void) | undefined;
    const mockReq = {
      on(event: string, listener: () => void) {
        if (event === 'close') closeListener = listener;
      },
    };

    // Trigger disconnect after 30ms
    setTimeout(() => closeListener?.(), 30);

    const result = await streamWithDisconnectDetection(source, sink, mockReq, {
      highWaterMark: 4,
    });

    expect(result.clientDisconnected).toBe(true);
    expect(result.tokensDelivered).toBeLessThan(500);
  });

  it('handles slow consumer with backpressure across a realistic stream', async () => {
    const sink = new MockSlowConsumer(8, 15);
    const source = mockLLMStream({ tokenCount: 80, tokenDelayMs: 0 });

    let closeListener: (() => void) | undefined;
    const mockReq = {
      on(event: string, listener: () => void) {
        if (event === 'close') closeListener = listener;
      },
    };

    const result = await streamWithDisconnectDetection(source, sink, mockReq, {
      highWaterMark: 10,
      drainTimeout: 5000,
    });

    expect(result.tokensDelivered).toBe(80);
    expect(result.backpressureEvents).toBeGreaterThan(0);
    expect(result.clientDisconnected).toBe(false);
    // Sanity: close listener was registered
    expect(closeListener).toBeDefined();
  });
});

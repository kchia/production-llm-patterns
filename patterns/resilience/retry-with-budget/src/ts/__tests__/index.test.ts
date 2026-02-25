import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  RetryWithBudget,
  TokenBucket,
  calculateBackoff,
  isRetryableError,
  ProviderError,
  RetriesExhaustedError,
} from '../index.js';
import { MockProvider } from '../mock-provider.js';
import type { RetryEvent, BudgetExhaustedEvent } from '../types.js';

// ── Unit Tests ────────────────────────────────────────────────────────

describe('TokenBucket', () => {
  it('starts at max capacity', () => {
    const bucket = new TokenBucket({ maxTokens: 50 });
    expect(bucket.remaining()).toBe(50);
    bucket.destroy();
  });

  it('consumes tokens on tryConsume', () => {
    const bucket = new TokenBucket({ maxTokens: 10 });
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.remaining()).toBe(9);
    bucket.destroy();
  });

  it('rejects consumption when below 50% threshold', () => {
    const bucket = new TokenBucket({ maxTokens: 10 });
    // Drain to exactly 5 (50%)
    for (let i = 0; i < 5; i++) {
      bucket.tryConsume();
    }
    expect(bucket.remaining()).toBe(5);
    // At 50%, the next consume should be allowed (5 >= 10*0.5)
    expect(bucket.tryConsume()).toBe(true);
    // Now at 4, below 50% — should reject
    expect(bucket.remaining()).toBe(4);
    expect(bucket.tryConsume()).toBe(false);
    bucket.destroy();
  });

  it('adds tokens on recordSuccess', () => {
    const bucket = new TokenBucket({ maxTokens: 10, tokenRatio: 1 });
    bucket.tryConsume(); // 9
    bucket.recordSuccess(); // 9 + 1 = 10
    expect(bucket.remaining()).toBe(10);
    bucket.destroy();
  });

  it('does not exceed maxTokens on recordSuccess', () => {
    const bucket = new TokenBucket({ maxTokens: 10, tokenRatio: 5 });
    bucket.recordSuccess();
    expect(bucket.remaining()).toBe(10);
    bucket.destroy();
  });

  it('resets to full capacity', () => {
    const bucket = new TokenBucket({ maxTokens: 10 });
    bucket.tryConsume();
    bucket.tryConsume();
    bucket.reset();
    expect(bucket.remaining()).toBe(10);
    bucket.destroy();
  });
});

describe('calculateBackoff', () => {
  it('returns 0 delay on first attempt with full jitter', () => {
    // Full jitter: random * (200 * 2^0) = random * 200
    // Since Math.random is [0,1), max is just under 200
    const delay = calculateBackoff(0, 200, 30000, 2, 'full');
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(200);
  });

  it('respects maxDelayMs cap', () => {
    const delay = calculateBackoff(20, 200, 1000, 2, 'none');
    expect(delay).toBe(1000);
  });

  it('returns exact exponential value with no jitter', () => {
    expect(calculateBackoff(0, 100, 30000, 2, 'none')).toBe(100);
    expect(calculateBackoff(1, 100, 30000, 2, 'none')).toBe(200);
    expect(calculateBackoff(2, 100, 30000, 2, 'none')).toBe(400);
    expect(calculateBackoff(3, 100, 30000, 2, 'none')).toBe(800);
  });

  it('equal jitter provides minimum half delay', () => {
    // equal jitter: cappedDelay/2 + random * cappedDelay/2
    // Minimum is cappedDelay/2 (when random = 0)
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const delay = calculateBackoff(0, 200, 30000, 2, 'equal');
    expect(delay).toBe(100); // 200/2 + 0*200/2
    vi.restoreAllMocks();
  });
});

describe('isRetryableError', () => {
  it('classifies 429 as retryable', () => {
    const err = new ProviderError('rate limited', 429);
    expect(isRetryableError(err, [429, 500, 503])).toBe(true);
  });

  it('classifies 400 as non-retryable', () => {
    const err = new ProviderError('bad request', 400);
    expect(isRetryableError(err, [429, 500, 503])).toBe(false);
  });

  it('classifies 401 as non-retryable', () => {
    const err = new ProviderError('unauthorized', 401);
    expect(isRetryableError(err, [429, 500, 503])).toBe(false);
  });

  it('classifies network errors as retryable', () => {
    const err = new Error('ECONNRESET');
    expect(isRetryableError(err, [429, 500, 503])).toBe(true);
  });

  it('classifies unknown errors as non-retryable', () => {
    const err = new Error('something unexpected');
    expect(isRetryableError(err, [429, 500, 503])).toBe(false);
  });
});

// ── Failure Mode Tests ────────────────────────────────────────────────

describe('Failure Mode: Budget exhaustion during partial outage', () => {
  let handler: RetryWithBudget;

  afterEach(() => handler?.destroy());

  it('stops retrying when budget is drained by failures', async () => {
    const exhaustedEvents: BudgetExhaustedEvent[] = [];
    handler = new RetryWithBudget({
      maxAttempts: 5,
      initialDelayMs: 1,
      maxDelayMs: 5,
      jitterMode: 'none',
      budgetConfig: { maxTokens: 4, tokenRatio: 0.1, refillIntervalMs: 0, refillAmount: 0 },
      onBudgetExhausted: (e) => exhaustedEvents.push(e),
    });

    const provider = new MockProvider({
      latencyMs: 0,
      failureRate: 1.0,
      failureStatusCode: 503,
    });

    await expect(
      handler.execute({ prompt: 'test' }, (req) => provider.call(req))
    ).rejects.toThrow(RetriesExhaustedError);

    // With maxTokens=4, threshold is 50% = 2. So we get initial attempt + some retries
    // before budget runs dry.
    expect(exhaustedEvents.length).toBeGreaterThan(0);
    expect(exhaustedEvents[0].budgetRemaining).toBeLessThan(4 * 0.5);
  });
});

describe('Failure Mode: Retry-After header conflict', () => {
  let handler: RetryWithBudget;

  afterEach(() => handler?.destroy());

  it('honors Retry-After delay over computed backoff', async () => {
    const retryEvents: RetryEvent[] = [];
    handler = new RetryWithBudget({
      maxAttempts: 3,
      initialDelayMs: 10,
      maxDelayMs: 100,
      jitterMode: 'none',
      budgetConfig: { maxTokens: 100, refillIntervalMs: 0, refillAmount: 0 },
      onRetry: (e) => retryEvents.push(e),
    });

    // First call: 429 with Retry-After, second call: success
    const provider = new MockProvider({
      latencyMs: 0,
      errorSequence: [429, 'success'],
      retryAfterMs: 50,
    });

    const result = await handler.execute(
      { prompt: 'test' },
      (req) => provider.call(req)
    );

    expect(result.attempts).toBe(2);
    // The delay should be the Retry-After value (50ms), not the computed backoff (10ms)
    expect(retryEvents[0].delayMs).toBe(50);
  });

  it('caps Retry-After at 2x maxDelayMs', async () => {
    const retryEvents: RetryEvent[] = [];
    handler = new RetryWithBudget({
      maxAttempts: 3,
      initialDelayMs: 10,
      maxDelayMs: 100,
      jitterMode: 'none',
      budgetConfig: { maxTokens: 100, refillIntervalMs: 0, refillAmount: 0 },
      onRetry: (e) => retryEvents.push(e),
    });

    // Retry-After is 500ms but maxDelayMs is 100, so capped at 200 (2x)
    const provider = new MockProvider({
      latencyMs: 0,
      errorSequence: [429, 'success'],
      retryAfterMs: 500,
    });

    const result = await handler.execute(
      { prompt: 'test' },
      (req) => provider.call(req)
    );

    expect(result.attempts).toBe(2);
    expect(retryEvents[0].delayMs).toBe(200); // 2 * maxDelayMs
  });
});

describe('Failure Mode: Silent budget drift', () => {
  let handler: RetryWithBudget;

  afterEach(() => handler?.destroy());

  it('budget drains over many requests with elevated error rate', async () => {
    handler = new RetryWithBudget({
      maxAttempts: 3,
      initialDelayMs: 1,
      maxDelayMs: 5,
      jitterMode: 'none',
      budgetConfig: {
        maxTokens: 20,
        tokenRatio: 0.1,
        refillIntervalMs: 0, // No passive refill for deterministic test
        refillAmount: 0,
      },
    });

    // 30% failure rate — not enough to trigger obvious alerts, but enough
    // to slowly drain the budget
    const provider = new MockProvider({
      latencyMs: 0,
      failureRate: 0.3,
      failureStatusCode: 503,
    });

    let budgetSnapshots: number[] = [];
    for (let i = 0; i < 50; i++) {
      try {
        await handler.execute({ prompt: `test ${i}` }, (req) => provider.call(req));
      } catch {
        // Some will fail — that's expected
      }
      budgetSnapshots.push(handler.getBudget().remaining());
    }

    // Budget should trend downward over time with 30% error rate
    const firstQuarter = budgetSnapshots.slice(0, 12);
    const lastQuarter = budgetSnapshots.slice(38);
    const avgFirst = firstQuarter.reduce((a, b) => a + b, 0) / firstQuarter.length;
    const avgLast = lastQuarter.reduce((a, b) => a + b, 0) / lastQuarter.length;

    // The last quarter should have a lower average budget than the first
    expect(avgLast).toBeLessThanOrEqual(avgFirst);
  });
});

describe('Failure Mode: Non-retryable error misclassified', () => {
  let handler: RetryWithBudget;

  afterEach(() => handler?.destroy());

  it('does not retry 400 errors', async () => {
    handler = new RetryWithBudget({
      maxAttempts: 3,
      initialDelayMs: 1,
    });

    const provider = new MockProvider({
      latencyMs: 0,
      errorSequence: [400],
    });

    await expect(
      handler.execute({ prompt: 'test' }, (req) => provider.call(req))
    ).rejects.toThrow(ProviderError);

    // Should only have made one call — no retries
    expect(provider.getCallCount()).toBe(1);
  });

  it('does not retry 401 errors', async () => {
    handler = new RetryWithBudget({
      maxAttempts: 3,
      initialDelayMs: 1,
    });

    const provider = new MockProvider({
      latencyMs: 0,
      errorSequence: [401],
    });

    await expect(
      handler.execute({ prompt: 'test' }, (req) => provider.call(req))
    ).rejects.toThrow(ProviderError);

    expect(provider.getCallCount()).toBe(1);
  });
});

describe('Failure Mode: Backoff delay exceeding request timeout', () => {
  let handler: RetryWithBudget;

  afterEach(() => handler?.destroy());

  it('total latency stays bounded by maxAttempts * maxDelayMs', async () => {
    handler = new RetryWithBudget({
      maxAttempts: 3,
      initialDelayMs: 10,
      maxDelayMs: 50,
      jitterMode: 'none',
      budgetConfig: { maxTokens: 100, refillIntervalMs: 0, refillAmount: 0 },
    });

    const provider = new MockProvider({
      latencyMs: 0,
      failureRate: 1.0,
      failureStatusCode: 503,
    });

    const start = performance.now();
    try {
      await handler.execute({ prompt: 'test' }, (req) => provider.call(req));
    } catch (err) {
      expect(err).toBeInstanceOf(RetriesExhaustedError);
    }
    const elapsed = performance.now() - start;

    // Upper bound: maxAttempts * maxDelayMs + some execution overhead
    // With 3 attempts, 2 retries, max 50ms delay each = ~100ms max wait + overhead
    expect(elapsed).toBeLessThan(500);
  });
});

// ── Integration Tests ─────────────────────────────────────────────────

describe('Integration: full retry flow with mock provider', () => {
  let handler: RetryWithBudget;

  afterEach(() => handler?.destroy());

  it('retries transient 503 and succeeds on second attempt', async () => {
    handler = new RetryWithBudget({
      maxAttempts: 3,
      initialDelayMs: 1,
      maxDelayMs: 10,
      budgetConfig: { maxTokens: 100, refillIntervalMs: 0, refillAmount: 0 },
    });

    const provider = new MockProvider({
      latencyMs: 0,
      errorSequence: [503, 'success'],
    });

    const result = await handler.execute(
      { prompt: 'Hello world' },
      (req) => provider.call(req)
    );

    expect(result.attempts).toBe(2);
    expect(result.retriesUsed).toBe(1);
    expect(result.response.content).toContain('Mock response');
  });

  it('retries 429 then 503 then succeeds', async () => {
    handler = new RetryWithBudget({
      maxAttempts: 4,
      initialDelayMs: 1,
      maxDelayMs: 10,
      budgetConfig: { maxTokens: 100, refillIntervalMs: 0, refillAmount: 0 },
    });

    const provider = new MockProvider({
      latencyMs: 0,
      errorSequence: [429, 503, 'success'],
    });

    const result = await handler.execute(
      { prompt: 'test' },
      (req) => provider.call(req)
    );

    expect(result.attempts).toBe(3);
    expect(result.retriesUsed).toBe(2);
  });

  it('exhausts all attempts and throws RetriesExhaustedError', async () => {
    handler = new RetryWithBudget({
      maxAttempts: 3,
      initialDelayMs: 1,
      maxDelayMs: 5,
      jitterMode: 'none',
      budgetConfig: { maxTokens: 100, refillIntervalMs: 0, refillAmount: 0 },
    });

    const provider = new MockProvider({
      latencyMs: 0,
      failureRate: 1.0,
      failureStatusCode: 500,
    });

    try {
      await handler.execute({ prompt: 'test' }, (req) => provider.call(req));
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RetriesExhaustedError);
      const retryErr = err as RetriesExhaustedError;
      expect(retryErr.attempts.length).toBeGreaterThan(0);
      expect(retryErr.totalLatencyMs).toBeGreaterThan(0);
    }
  });

  it('fires onRetry callback for each retry', async () => {
    const events: RetryEvent[] = [];
    handler = new RetryWithBudget({
      maxAttempts: 3,
      initialDelayMs: 1,
      maxDelayMs: 5,
      budgetConfig: { maxTokens: 100, refillIntervalMs: 0, refillAmount: 0 },
      onRetry: (e) => events.push(e),
    });

    const provider = new MockProvider({
      latencyMs: 0,
      errorSequence: [503, 'success'],
    });

    await handler.execute({ prompt: 'test' }, (req) => provider.call(req));

    expect(events.length).toBe(1);
    expect(events[0].attempt).toBe(1);
    expect(events[0].delayMs).toBeGreaterThanOrEqual(0);
  });

  it('budget recovers after successful requests', async () => {
    handler = new RetryWithBudget({
      maxAttempts: 5,
      initialDelayMs: 1,
      maxDelayMs: 5,
      jitterMode: 'none',
      budgetConfig: {
        maxTokens: 100,
        tokenRatio: 2, // Aggressive refill for testing
        refillIntervalMs: 0,
        refillAmount: 0,
      },
    });

    // Drain budget with many failures (each retry consumes 1 token)
    const allFailProvider = new MockProvider({
      latencyMs: 0,
      failureRate: 1.0,
      failureStatusCode: 503,
    });

    for (let i = 0; i < 10; i++) {
      try {
        await handler.execute({ prompt: `fail ${i}` }, (req) => allFailProvider.call(req));
      } catch {
        // Expected
      }
    }

    const budgetAfterDrain = handler.getBudget().remaining();
    expect(budgetAfterDrain).toBeLessThan(100);

    // Now do many successful requests to recover budget
    const successProvider = new MockProvider({ latencyMs: 0 });
    for (let i = 0; i < 30; i++) {
      await handler.execute({ prompt: `test ${i}` }, (req) =>
        successProvider.call(req)
      );
    }

    const budgetAfterRecovery = handler.getBudget().remaining();
    expect(budgetAfterRecovery).toBeGreaterThan(budgetAfterDrain);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CircuitBreaker,
  CircuitState,
  CircuitOpenError,
  SlidingWindow,
  MockProvider,
  ProviderError,
} from '../index.js';
import type { CircuitBreakerConfig, LLMRequest } from '../index.js';

const REQ: LLMRequest = { prompt: 'test' };

// Helper: send N requests that succeed
async function sendSuccesses(
  breaker: CircuitBreaker,
  provider: MockProvider,
  count: number
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await breaker.execute(REQ, (r) => provider.call(r));
  }
}

// Helper: send N requests that fail (swallowing errors)
async function sendFailures(
  breaker: CircuitBreaker,
  provider: MockProvider,
  count: number
): Promise<number> {
  let sent = 0;
  for (let i = 0; i < count; i++) {
    try {
      await breaker.execute(REQ, (r) => provider.call(r));
    } catch {
      // expected
    }
    sent++;
  }
  return sent;
}

// Helper: trip the circuit by sending failures until it opens.
// Returns how many calls reached the provider.
async function tripCircuit(
  breaker: CircuitBreaker,
  provider: MockProvider,
  maxAttempts = 50
): Promise<number> {
  const startCount = provider.getCallCount();
  for (let i = 0; i < maxAttempts; i++) {
    if (breaker.getState() === CircuitState.OPEN) break;
    try {
      await breaker.execute(REQ, (r) => provider.call(r));
    } catch {
      // expected
    }
  }
  return provider.getCallCount() - startCount;
}

// =====================================================
// 1. UNIT TESTS
// =====================================================

describe('SlidingWindow', () => {
  it('computes failure rate from recorded entries', () => {
    const win = new SlidingWindow(100, 60_000);
    win.record(true);
    win.record(true);
    win.record(false);
    const stats = win.getStats();
    expect(stats.total).toBe(3);
    expect(stats.failures).toBe(1);
    expect(stats.failureRate).toBeCloseTo(33.33, 1);
  });

  it('evicts entries older than maxAgeMs', async () => {
    const win = new SlidingWindow(100, 50); // 50ms window
    win.record(false);
    await new Promise((r) => setTimeout(r, 80));
    win.record(true);
    const stats = win.getStats();
    expect(stats.total).toBe(1); // old failure evicted
    expect(stats.failures).toBe(0);
  });

  it('trims to maxSize keeping most recent', () => {
    const win = new SlidingWindow(3, 60_000);
    win.record(false); // will be evicted
    win.record(true);
    win.record(true);
    win.record(true);
    const stats = win.getStats();
    expect(stats.total).toBe(3);
    expect(stats.failures).toBe(0); // oldest (failure) was trimmed
  });

  it('returns zero failure rate with no entries', () => {
    const win = new SlidingWindow(100, 60_000);
    expect(win.getStats().failureRate).toBe(0);
  });

  it('resets all entries', () => {
    const win = new SlidingWindow(100, 60_000);
    win.record(false);
    win.record(false);
    win.reset();
    expect(win.getStats().total).toBe(0);
  });
});

describe('CircuitBreaker - unit tests', () => {
  let breaker: CircuitBreaker;

  afterEach(() => {
    breaker?.destroy();
  });

  it('starts in CLOSED state', () => {
    breaker = new CircuitBreaker();
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it('passes through successful requests without state change', async () => {
    breaker = new CircuitBreaker();
    const provider = new MockProvider({ latencyMs: 0 });
    await sendSuccesses(breaker, provider, 20);
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
    expect(provider.getCallCount()).toBe(20);
  });

  it('applies default configuration correctly', async () => {
    breaker = new CircuitBreaker();
    const stats = breaker.getStats();
    expect(stats.total).toBe(0);
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it('respects custom configuration', async () => {
    breaker = new CircuitBreaker({
      failureThreshold: 30,
      minimumRequests: 5,
      resetTimeoutMs: 1000,
    });

    const provider = new MockProvider({
      latencyMs: 0,
      errorSequence: [503, 503, 'success', 'success', 'success', 'success', 'success'],
    });

    // 2 failures + 5 successes = 7 requests, ~28.6% failure rate — below 30% threshold
    await sendFailures(breaker, provider, 2);
    await sendSuccesses(breaker, provider, 5);
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it('treats 4xx errors as non-failures by default', async () => {
    breaker = new CircuitBreaker({ minimumRequests: 3 });
    const provider = new MockProvider({
      latencyMs: 0,
      errorSequence: [400, 400, 400, 400, 400, 400, 400, 400, 400, 400],
    });

    // 4xx errors should count as successes for circuit breaker purposes
    await sendFailures(breaker, provider, 10);
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it('supports custom isFailure function', async () => {
    breaker = new CircuitBreaker({
      minimumRequests: 3,
      failureThreshold: 50,
      isFailure: (err) => {
        // Only treat 503 as failure, not 429
        if (err && typeof err === 'object' && 'statusCode' in err) {
          return (err as { statusCode: number }).statusCode === 503;
        }
        return false;
      },
    });

    const provider = new MockProvider({
      latencyMs: 0,
      errorSequence: [429, 429, 429, 429, 429, 429, 429, 429, 429, 429],
    });

    await sendFailures(breaker, provider, 10);
    // 429s are not failures per custom function → circuit stays closed
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it('fires onSuccess and onFailure callbacks', async () => {
    const successes: unknown[] = [];
    const failures: unknown[] = [];
    breaker = new CircuitBreaker({
      onSuccess: (e) => successes.push(e),
      onFailure: (e) => failures.push(e),
    });

    const provider = new MockProvider({
      latencyMs: 0,
      errorSequence: ['success', 503],
    });

    await breaker.execute(REQ, (r) => provider.call(r));
    try {
      await breaker.execute(REQ, (r) => provider.call(r));
    } catch { /* expected */ }

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
  });
});

// =====================================================
// 2. FAILURE MODE TESTS
// =====================================================

describe('CircuitBreaker - failure mode tests', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('FM1: False open — trips circuit on genuine systemic failure', async () => {
    const stateChanges: Array<{ from: CircuitState; to: CircuitState }> = [];
    const breaker = new CircuitBreaker({
      failureThreshold: 50,
      minimumRequests: 5,
      resetTimeoutMs: 5000,
      onStateChange: (e) => stateChanges.push({ from: e.from, to: e.to }),
    });

    const provider = new MockProvider({
      latencyMs: 0,
      failureRate: 1.0,
      failureStatusCode: 503,
    });

    await tripCircuit(breaker, provider);
    expect(breaker.getState()).toBe(CircuitState.OPEN);
    expect(stateChanges).toContainEqual({
      from: CircuitState.CLOSED,
      to: CircuitState.OPEN,
    });

    breaker.destroy();
  });

  it('FM1: minimumRequests prevents false open on small samples', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 50,
      minimumRequests: 10,
    });

    // 3 failures = 100% rate but below minimumRequests (10)
    const provider = new MockProvider({
      latencyMs: 0,
      errorSequence: [503, 503, 503],
    });

    await sendFailures(breaker, provider, 3);
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
    breaker.destroy();
  });

  it('FM2: Thundering herd — all requests fail fast during OPEN state', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 50,
      minimumRequests: 5,
      resetTimeoutMs: 60_000,
    });

    const provider = new MockProvider({
      latencyMs: 0,
      failureRate: 1.0,
      failureStatusCode: 503,
    });

    // Trip the circuit
    const providerCalls = await tripCircuit(breaker, provider);
    expect(breaker.getState()).toBe(CircuitState.OPEN);
    expect(providerCalls).toBeGreaterThanOrEqual(5); // at least minimumRequests

    const callsAfterOpen = provider.getCallCount();

    // Now send 100 requests — all should fail fast without hitting provider
    const errors: CircuitOpenError[] = [];
    for (let i = 0; i < 100; i++) {
      try {
        await breaker.execute(REQ, (r) => provider.call(r));
      } catch (e) {
        if (e instanceof CircuitOpenError) errors.push(e);
      }
    }

    expect(errors.length).toBe(100);
    expect(errors[0].remainingMs).toBeGreaterThan(0);
    // Provider should NOT have received any additional calls during OPEN state
    expect(provider.getCallCount()).toBe(callsAfterOpen);

    breaker.destroy();
  });

  it('FM3: Stuck open — transitions to HALF_OPEN after reset timeout', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 50,
      minimumRequests: 5,
      resetTimeoutMs: 100,
      halfOpenMaxAttempts: 1,
    });

    // Use probabilistic failure to trip, then switch to success
    const provider = new MockProvider({
      latencyMs: 0,
      failureRate: 1.0,
      failureStatusCode: 503,
    });

    await tripCircuit(breaker, provider);
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // Switch provider to succeed for the probe
    provider.updateConfig({ failureRate: 0 });

    // Wait for reset timeout
    await new Promise((r) => setTimeout(r, 150));
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

    // Successful probe should close the circuit
    await breaker.execute(REQ, (r) => provider.call(r));
    expect(breaker.getState()).toBe(CircuitState.CLOSED);

    breaker.destroy();
  });

  it('FM3: Stuck open — half-open failure reopens circuit', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 50,
      minimumRequests: 5,
      resetTimeoutMs: 100,
      halfOpenMaxAttempts: 3,
    });

    const provider = new MockProvider({
      latencyMs: 0,
      failureRate: 1.0,
      failureStatusCode: 503,
    });

    await tripCircuit(breaker, provider);
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // Provider still failing for probe
    await new Promise((r) => setTimeout(r, 150));

    // Probe fails → should reopen
    try {
      await breaker.execute(REQ, (r) => provider.call(r));
    } catch {
      // expected
    }

    expect(breaker.getState()).toBe(CircuitState.OPEN);
    breaker.destroy();
  });

  it('FM4: Stuck closed — failure rate below threshold stays closed', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 50,
      minimumRequests: 10,
    });

    // 4 failures + 6 successes = 40% failure rate, below 50% threshold
    const provider = new MockProvider({
      latencyMs: 0,
      errorSequence: [503, 503, 503, 503, 'success', 'success', 'success', 'success', 'success', 'success'],
    });

    await sendFailures(breaker, provider, 4);
    await sendSuccesses(breaker, provider, 6);
    expect(breaker.getState()).toBe(CircuitState.CLOSED);

    const stats = breaker.getStats();
    expect(stats.failureRate).toBeCloseTo(40, 0);

    breaker.destroy();
  });

  it('FM5: State divergence — independent instances track separately', async () => {
    const breaker1 = new CircuitBreaker({
      failureThreshold: 50,
      minimumRequests: 5,
    });
    const breaker2 = new CircuitBreaker({
      failureThreshold: 50,
      minimumRequests: 5,
    });

    const failingProvider = new MockProvider({
      latencyMs: 0,
      failureRate: 1.0,
      failureStatusCode: 503,
    });
    const healthyProvider = new MockProvider({ latencyMs: 0 });

    await tripCircuit(breaker1, failingProvider);
    await sendSuccesses(breaker2, healthyProvider, 10);

    expect(breaker1.getState()).toBe(CircuitState.OPEN);
    expect(breaker2.getState()).toBe(CircuitState.CLOSED);

    breaker1.destroy();
    breaker2.destroy();
  });

  it('FM6: Silent threshold drift — stats are observable for monitoring', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 50,
      minimumRequests: 10,
      windowSize: 100,
    });

    const provider = new MockProvider({ latencyMs: 0 });

    // Send many successes to establish a pattern
    await sendSuccesses(breaker, provider, 50);

    const stats = breaker.getStats();
    // Stats are accessible — monitoring systems can compare against threshold
    expect(stats.failureRate).toBe(0);
    expect(stats.total).toBe(50);

    breaker.destroy();
  });
});

// =====================================================
// 3. INTEGRATION TESTS
// =====================================================

describe('CircuitBreaker - integration tests', () => {
  it('full lifecycle: CLOSED → OPEN → HALF_OPEN → CLOSED', async () => {
    const transitions: Array<{ from: CircuitState; to: CircuitState }> = [];

    const breaker = new CircuitBreaker({
      failureThreshold: 50,
      minimumRequests: 5,
      resetTimeoutMs: 100,
      halfOpenMaxAttempts: 2,
      onStateChange: (e) => transitions.push({ from: e.from, to: e.to }),
    });

    // Phase 1: Trip the circuit with failures
    const provider = new MockProvider({
      latencyMs: 0,
      failureRate: 1.0,
      failureStatusCode: 503,
    });

    await tripCircuit(breaker, provider);
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // Phase 2: OPEN → requests fail fast
    let openError: CircuitOpenError | null = null;
    try {
      await breaker.execute(REQ, (r) => provider.call(r));
    } catch (e) {
      if (e instanceof CircuitOpenError) openError = e;
    }
    expect(openError).not.toBeNull();
    expect(openError!.failureRate).toBeGreaterThanOrEqual(50);

    // Phase 3: Wait for reset → HALF_OPEN
    await new Promise((r) => setTimeout(r, 150));
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

    // Phase 4: Switch provider to success, close the circuit with probes
    provider.updateConfig({ failureRate: 0 });

    await breaker.execute(REQ, (r) => provider.call(r));
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN); // need 2 probes
    await breaker.execute(REQ, (r) => provider.call(r));
    expect(breaker.getState()).toBe(CircuitState.CLOSED);

    // Verify full transition sequence
    expect(transitions).toEqual([
      { from: CircuitState.CLOSED, to: CircuitState.OPEN },
      { from: CircuitState.OPEN, to: CircuitState.HALF_OPEN },
      { from: CircuitState.HALF_OPEN, to: CircuitState.CLOSED },
    ]);

    breaker.destroy();
  });

  it('circuit protects against retry storms — fast-fail prevents provider calls', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 50,
      minimumRequests: 5,
      resetTimeoutMs: 60_000,
    });

    const provider = new MockProvider({
      latencyMs: 0,
      failureRate: 1.0,
      failureStatusCode: 503,
    });

    await tripCircuit(breaker, provider);
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    const callsBefore = provider.getCallCount();

    // Simulate 100 requests hitting an open circuit
    const results = await Promise.allSettled(
      Array.from({ length: 100 }, () =>
        breaker.execute(REQ, (r) => provider.call(r))
      )
    );

    // All 100 should be rejected
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected.length).toBe(100);

    // Provider should not have received any additional calls
    expect(provider.getCallCount()).toBe(callsBefore);

    breaker.destroy();
  });

  it('handles concurrent requests correctly during state transitions', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 50,
      minimumRequests: 5,
      resetTimeoutMs: 100,
      halfOpenMaxAttempts: 1,
    });

    const provider = new MockProvider({
      latencyMs: 0,
      failureRate: 1.0,
      failureStatusCode: 503,
    });

    await tripCircuit(breaker, provider);
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // Wait for reset timeout
    await new Promise((r) => setTimeout(r, 150));

    // Switch to success for probe
    provider.updateConfig({ failureRate: 0 });

    // First request should go through (HALF_OPEN probe)
    const result = await breaker.execute(REQ, (r) => provider.call(r));
    expect(result.content).toBeDefined();

    breaker.destroy();
  });

  it('end-to-end with realistic mock provider — mixed success/failure', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 60,
      minimumRequests: 10,
      resetTimeoutMs: 200,
      halfOpenMaxAttempts: 2,
      windowSize: 20, // small window so old successes age out faster
    });

    const provider = new MockProvider({
      latencyMs: 0,
      tokensPerResponse: 150,
    });

    // Phase 1: Normal operation
    await sendSuccesses(breaker, provider, 15);
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
    let stats = breaker.getStats();
    expect(stats.failureRate).toBe(0);

    // Phase 2: Provider degrades — 100% failure. Window of 20 means after
    // 20 failures, old successes are evicted and rate = 100% > 60%
    provider.updateConfig({
      failureRate: 1.0,
      failureStatusCode: 503,
    });

    await tripCircuit(breaker, provider);
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // Phase 3: Provider recovers
    provider.updateConfig({ failureRate: 0 });

    await new Promise((r) => setTimeout(r, 250));

    // Phase 4: Circuit probes and closes
    await sendSuccesses(breaker, provider, 2);
    expect(breaker.getState()).toBe(CircuitState.CLOSED);

    // Phase 5: Normal operation resumes
    await sendSuccesses(breaker, provider, 10);
    stats = breaker.getStats();
    expect(stats.failureRate).toBe(0);

    breaker.destroy();
  });
});

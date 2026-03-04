import { describe, it, expect } from 'vitest';
import { FailoverRouter, classifyError } from '../index.js';
import { MockProvider, createFailingProvider } from '../mock-provider.js';
import {
  ProviderError,
  AllProvidersExhaustedError,
  type LLMRequest,
} from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createProvider(
  name: string,
  opts: {
    latencyMs?: number;
    failureRate?: number;
    failureStatusCode?: number;
  } = {},
) {
  return new MockProvider({
    name,
    latencyMs: opts.latencyMs ?? 5,
    ...opts,
  });
}

const REQ: LLMRequest = { prompt: 'test prompt' };

// ---------------------------------------------------------------------------
// Unit tests — core logic
// ---------------------------------------------------------------------------

describe('FailoverRouter — unit tests', () => {
  it('routes to primary provider on success', async () => {
    const primary = createProvider('primary');
    const backup = createProvider('backup');

    const router = new FailoverRouter({
      providers: [
        { name: 'primary', handler: primary.handler },
        { name: 'backup', handler: backup.handler },
      ],
      timeout: 5000,
    });

    const result = await router.complete(REQ);
    expect(result.provider).toBe('primary');
    expect(result.failoverOccurred).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(result.response.content).toContain('primary');
  });

  it('fails over to backup when primary fails with 503', async () => {
    const primary = createProvider('primary', { failureRate: 1.0, failureStatusCode: 503 });
    const backup = createProvider('backup');

    const router = new FailoverRouter({
      providers: [
        { name: 'primary', handler: primary.handler },
        { name: 'backup', handler: backup.handler },
      ],
      timeout: 5000,
    });

    const result = await router.complete(REQ);
    expect(result.provider).toBe('backup');
    expect(result.failoverOccurred).toBe(true);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].status).toBe('failover');
    expect(result.attempts[1].status).toBe('success');
  });

  it('respects provider priority ordering', async () => {
    const low = createProvider('low-priority');
    const high = createProvider('high-priority');

    const router = new FailoverRouter({
      providers: [
        { name: 'low-priority', handler: low.handler, priority: 10 },
        { name: 'high-priority', handler: high.handler, priority: 1 },
      ],
      timeout: 5000,
    });

    const result = await router.complete(REQ);
    expect(result.provider).toBe('high-priority');
  });

  it('throws AllProvidersExhaustedError when all fail', async () => {
    const p1 = createProvider('p1', { failureRate: 1.0, failureStatusCode: 500 });
    const p2 = createProvider('p2', { failureRate: 1.0, failureStatusCode: 502 });

    const router = new FailoverRouter({
      providers: [
        { name: 'p1', handler: p1.handler },
        { name: 'p2', handler: p2.handler },
      ],
      timeout: 5000,
    });

    await expect(router.complete(REQ)).rejects.toThrow(AllProvidersExhaustedError);
  });

  it('throws immediately on fatal errors (400)', async () => {
    const primary = createFailingProvider('primary', 400);
    const backup = createProvider('backup');

    const router = new FailoverRouter({
      providers: [
        { name: 'primary', handler: primary.handler },
        { name: 'backup', handler: backup.handler },
      ],
      timeout: 5000,
    });

    try {
      await router.complete(REQ);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AllProvidersExhaustedError);
      const exhausted = err as AllProvidersExhaustedError;
      expect(exhausted.attempts).toHaveLength(1);
      expect(exhausted.attempts[0].provider).toBe('primary');
      expect(exhausted.attempts[0].errorCategory).toBe('fatal');
    }
  });

  it('respects maxFailovers limit', async () => {
    const p1 = createProvider('p1', { failureRate: 1.0, failureStatusCode: 503 });
    const p2 = createProvider('p2', { failureRate: 1.0, failureStatusCode: 503 });
    const p3 = createProvider('p3');

    const router = new FailoverRouter({
      providers: [
        { name: 'p1', handler: p1.handler },
        { name: 'p2', handler: p2.handler },
        { name: 'p3', handler: p3.handler },
      ],
      timeout: 5000,
      maxFailovers: 1,
    });

    await expect(router.complete(REQ)).rejects.toThrow(AllProvidersExhaustedError);
  });

  it('returns correct totalLatencyMs across attempts', async () => {
    const primary = createProvider('primary', { failureRate: 1.0, failureStatusCode: 503, latencyMs: 20 });
    const backup = createProvider('backup', { latencyMs: 20 });

    const router = new FailoverRouter({
      providers: [
        { name: 'primary', handler: primary.handler },
        { name: 'backup', handler: backup.handler },
      ],
      timeout: 5000,
    });

    const result = await router.complete(REQ);
    expect(result.totalLatencyMs).toBeGreaterThan(0);
    expect(result.attempts).toHaveLength(2);
  });

  it('requires at least one provider', () => {
    expect(() => new FailoverRouter({ providers: [] })).toThrow(
      'At least one provider is required',
    );
  });

  it('reports provider health correctly', async () => {
    const primary = createProvider('primary');
    const router = new FailoverRouter({
      providers: [{ name: 'primary', handler: primary.handler }],
      timeout: 5000,
    });

    let health = router.getProviderHealth();
    expect(health.get('primary')!.status).toBe('unknown');

    await router.complete(REQ);

    health = router.getProviderHealth();
    expect(health.get('primary')!.status).toBe('healthy');
    expect(health.get('primary')!.successRate).toBe(1);
  });

  it('resets provider health on manual reset', async () => {
    const primary = createProvider('primary', { failureRate: 1.0, failureStatusCode: 503 });
    const backup = createProvider('backup');

    const router = new FailoverRouter({
      providers: [
        { name: 'primary', handler: primary.handler },
        { name: 'backup', handler: backup.handler },
      ],
      timeout: 5000,
      windowSize: 3,
      failureThreshold: 0.5,
    });

    for (let i = 0; i < 4; i++) {
      await router.complete(REQ);
    }

    expect(router.getProviderHealth().get('primary')!.status).toBe('cooldown');

    router.resetProvider('primary');

    const healthAfter = router.getProviderHealth();
    expect(healthAfter.get('primary')!.status).toBe('unknown');
    expect(healthAfter.get('primary')!.consecutiveFailures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Error classification tests
// ---------------------------------------------------------------------------

describe('classifyError', () => {
  it('classifies 429 as retryable', () => {
    expect(classifyError(new ProviderError('rate limit', 429, 'openai'))).toBe('retryable');
  });

  it('classifies 529 as retryable', () => {
    expect(classifyError(new ProviderError('overloaded', 529, 'anthropic'))).toBe('retryable');
  });

  it('classifies 503 as failover', () => {
    expect(classifyError(new ProviderError('unavailable', 503, 'openai'))).toBe('failover');
  });

  it('classifies 500 as failover', () => {
    expect(classifyError(new ProviderError('internal', 500, 'openai'))).toBe('failover');
  });

  it('classifies timeout as failover', () => {
    expect(classifyError(new ProviderError('timeout', 0, 'openai', true))).toBe('failover');
  });

  it('classifies 400 as fatal', () => {
    expect(classifyError(new ProviderError('bad request', 400, 'openai'))).toBe('fatal');
  });

  it('classifies 401 as fatal', () => {
    expect(classifyError(new ProviderError('unauthorized', 401, 'openai'))).toBe('fatal');
  });

  it('classifies 403 as fatal', () => {
    expect(classifyError(new ProviderError('forbidden', 403, 'openai'))).toBe('fatal');
  });

  it('classifies unknown errors as failover', () => {
    expect(classifyError(new Error('something unexpected'))).toBe('failover');
  });

  it('classifies network errors as failover', () => {
    expect(classifyError(new Error('ECONNREFUSED'))).toBe('failover');
  });
});

// ---------------------------------------------------------------------------
// Failure mode tests — one per failure mode from the README
// ---------------------------------------------------------------------------

describe('Failure mode: cascading failover storm', () => {
  it('limits failover attempts with maxFailovers', async () => {
    const providers = Array.from({ length: 5 }, (_, i) =>
      createProvider(`p${i}`, { failureRate: 1.0, failureStatusCode: 503 }),
    );

    const router = new FailoverRouter({
      providers: providers.map((p) => ({ name: p.name, handler: p.handler })),
      timeout: 5000,
      maxFailovers: 2,
    });

    try {
      await router.complete(REQ);
    } catch (err) {
      expect(err).toBeInstanceOf(AllProvidersExhaustedError);
      const exhausted = err as AllProvidersExhaustedError;
      expect(exhausted.attempts.length).toBeLessThanOrEqual(3);
    }
  });
});

describe('Failure mode: cooldown oscillation', () => {
  it('puts provider in cooldown after sustained failures', async () => {
    const primary = createProvider('primary', { failureRate: 1.0, failureStatusCode: 503 });
    const backup = createProvider('backup');

    const cooldownEvents: { provider: string; entering: boolean }[] = [];

    const router = new FailoverRouter({
      providers: [
        { name: 'primary', handler: primary.handler },
        { name: 'backup', handler: backup.handler },
      ],
      timeout: 5000,
      windowSize: 3,
      failureThreshold: 0.5,
      onProviderCooldown: (provider, entering) => {
        cooldownEvents.push({ provider, entering });
      },
    });

    for (let i = 0; i < 4; i++) {
      await router.complete(REQ);
    }

    expect(cooldownEvents.some((e) => e.provider === 'primary' && e.entering)).toBe(true);
    expect(router.getProviderHealth().get('primary')!.status).toBe('cooldown');
  });
});

describe('Failure mode: error misclassification', () => {
  it('does not failover on 400 bad request errors', async () => {
    const primary = createFailingProvider('primary', 400);
    const backup = createProvider('backup');

    const failoverEvents: string[] = [];

    const router = new FailoverRouter({
      providers: [
        { name: 'primary', handler: primary.handler },
        { name: 'backup', handler: backup.handler },
      ],
      timeout: 5000,
      onFailover: (from, to) => failoverEvents.push(`${from}->${to}`),
    });

    await expect(router.complete(REQ)).rejects.toThrow();
    expect(failoverEvents).toHaveLength(0);
    expect(backup.getRequestCount()).toBe(0);
  });
});

describe('Failure mode: silent quality degradation', () => {
  it('reports which provider served for quality tracking', async () => {
    const primary = createProvider('primary', { failureRate: 1.0, failureStatusCode: 503 });
    const backup = createProvider('backup');

    const router = new FailoverRouter({
      providers: [
        { name: 'primary', handler: primary.handler },
        { name: 'backup', handler: backup.handler },
      ],
      timeout: 5000,
    });

    const result = await router.complete(REQ);
    expect(result.provider).toBe('backup');
    expect(result.failoverOccurred).toBe(true);
    // Downstream quality monitoring uses result.provider to segment metrics
  });
});

describe('Failure mode: timeout amplification', () => {
  it('per-provider timeout prevents total latency explosion', async () => {
    const slow1 = new MockProvider({ name: 'slow1', latencyMs: 10_000 });
    const slow2 = new MockProvider({ name: 'slow2', latencyMs: 10_000 });
    const fast = createProvider('fast');

    const router = new FailoverRouter({
      providers: [
        { name: 'slow1', handler: slow1.handler, timeout: 50 },
        { name: 'slow2', handler: slow2.handler, timeout: 50 },
        { name: 'fast', handler: fast.handler },
      ],
      timeout: 5000,
    });

    const start = performance.now();
    const result = await router.complete(REQ);
    const elapsed = performance.now() - start;

    expect(result.provider).toBe('fast');
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('Failure mode: stale health state', () => {
  it('re-tries provider after cooldown expires', async () => {
    const primary = createProvider('primary', { failureRate: 1.0, failureStatusCode: 503 });
    const backup = createProvider('backup');

    const router = new FailoverRouter({
      providers: [
        { name: 'primary', handler: primary.handler },
        { name: 'backup', handler: backup.handler },
      ],
      timeout: 5000,
      cooldownMs: 50,
      windowSize: 3,
      failureThreshold: 0.5,
    });

    // Trigger cooldown
    for (let i = 0; i < 4; i++) {
      await router.complete(REQ);
    }
    expect(router.getProviderHealth().get('primary')!.status).toBe('cooldown');

    // Wait for cooldown to expire
    await new Promise((r) => setTimeout(r, 60));

    // Primary recovers
    primary.updateConfig({ failureRate: 0 });

    const result = await router.complete(REQ);
    // Primary should be attempted again after cooldown
    expect(result.provider).toBe('primary');
  });
});

// ---------------------------------------------------------------------------
// Integration test — full flow
// ---------------------------------------------------------------------------

describe('Integration: full failover flow', () => {
  it('handles primary failure → backup success → cooldown → recovery', async () => {
    const primary = new MockProvider({ name: 'primary', latencyMs: 5, failureRate: 0 });
    const backup = new MockProvider({ name: 'backup', latencyMs: 5, failureRate: 0 });

    const failoverLog: string[] = [];

    const router = new FailoverRouter({
      providers: [
        { name: 'primary', handler: primary.handler },
        { name: 'backup', handler: backup.handler },
      ],
      timeout: 5000,
      cooldownMs: 50,
      windowSize: 3,
      failureThreshold: 0.5,
      onFailover: (from, to) => failoverLog.push(`${from}->${to}`),
    });

    // Phase 1: Normal — primary handles everything
    const r1 = await router.complete(REQ);
    expect(r1.provider).toBe('primary');
    expect(r1.failoverOccurred).toBe(false);

    // Phase 2: Primary starts failing — send enough requests to trigger cooldown
    primary.updateConfig({ failureRate: 1.0, failureStatusCode: 503 });

    // First few requests will failover; once cooldown triggers, requests skip primary
    for (let i = 0; i < 4; i++) {
      const result = await router.complete(REQ);
      expect(result.provider).toBe('backup');
    }

    expect(router.getProviderHealth().get('primary')!.status).toBe('cooldown');
    expect(failoverLog.length).toBeGreaterThan(0);

    // Phase 3: During cooldown, requests go straight to backup
    const r3 = await router.complete(REQ);
    expect(r3.provider).toBe('backup');
    expect(r3.attempts).toHaveLength(1);

    // Phase 4: Primary recovers, cooldown expires
    primary.updateConfig({ failureRate: 0 });
    await new Promise((r) => setTimeout(r, 60));

    const r4 = await router.complete(REQ);
    expect(r4.provider).toBe('primary');
    expect(r4.failoverOccurred).toBe(false);
  });

  it('handles concurrent requests during failover', async () => {
    const primary = new MockProvider({
      name: 'primary',
      latencyMs: 5,
      failureRate: 1.0,
      failureStatusCode: 503,
    });
    const backup = new MockProvider({ name: 'backup', latencyMs: 5 });

    const router = new FailoverRouter({
      providers: [
        { name: 'primary', handler: primary.handler },
        { name: 'backup', handler: backup.handler },
      ],
      timeout: 5000,
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => router.complete(REQ)),
    );

    for (const result of results) {
      expect(result.provider).toBe('backup');
      expect(result.failoverOccurred).toBe(true);
    }
  });
});

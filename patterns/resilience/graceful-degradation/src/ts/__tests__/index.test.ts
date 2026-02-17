import { describe, it, expect, vi } from 'vitest';
import { DegradationChain, AllTiersExhaustedError } from '../index.js';
import {
  MockProvider,
  createCacheHandler,
  createRuleBasedHandler,
  createStaticHandler,
} from '../mock-provider.js';
import type { DegradationTier, LLMRequest } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrimaryTier(
  config: { failureRate?: number; latencyMs?: number } = {}
): DegradationTier {
  const provider = new MockProvider({
    latencyMs: config.latencyMs ?? 5,
    failureRate: config.failureRate ?? 0,
    modelName: 'primary-model',
  });
  return {
    name: 'primary',
    handler: (req) => provider.call(req),
    qualityScore: 1.0,
    timeoutMs: 500,
  };
}

function makeFallbackTier(
  config: { failureRate?: number; latencyMs?: number } = {}
): DegradationTier {
  const provider = new MockProvider({
    latencyMs: config.latencyMs ?? 5,
    failureRate: config.failureRate ?? 0,
    modelName: 'fallback-model',
  });
  return {
    name: 'fallback',
    handler: (req) => provider.call(req),
    qualityScore: 0.7,
    timeoutMs: 500,
  };
}

function makeStaticTier(): DegradationTier {
  return {
    name: 'static',
    handler: createStaticHandler('Service is temporarily limited.'),
    qualityScore: 0.1,
    timeoutMs: 100,
  };
}

function makeCacheTier(): { tier: DegradationTier; populate: (prompt: string, content: string) => void; clear: () => void } {
  const cache = createCacheHandler();
  return {
    tier: {
      name: 'cache',
      handler: cache.handler,
      qualityScore: 0.5,
      timeoutMs: 200,
    },
    populate: cache.populate,
    clear: cache.clear,
  };
}

function makeRuleTier(): DegradationTier {
  return {
    name: 'rule-based',
    handler: createRuleBasedHandler([
      { pattern: /hello|hi|hey/i, response: 'Hello! How can I help?' },
      { pattern: /help/i, response: 'Here are some common options...' },
    ]),
    qualityScore: 0.3,
    timeoutMs: 100,
  };
}

// ---------------------------------------------------------------------------
// 1. Unit Tests — core logic, configuration, state
// ---------------------------------------------------------------------------

describe('Unit Tests', () => {
  it('returns primary tier response when healthy', async () => {
    const chain = new DegradationChain({
      tiers: [makePrimaryTier()],
    });

    const result = await chain.execute({ prompt: 'Hello' });

    expect(result.tier).toBe('primary');
    expect(result.quality).toBe(1.0);
    expect(result.degraded).toBe(false);
    expect(result.response.content).toBeTruthy();
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(result.attemptedTiers).toHaveLength(1);
    expect(result.attemptedTiers[0].status).toBe('success');
  });

  it('walks through tiers in order on failure', async () => {
    const chain = new DegradationChain({
      tiers: [
        makePrimaryTier({ failureRate: 1.0 }),
        makeFallbackTier(),
        makeStaticTier(),
      ],
    });

    const result = await chain.execute({ prompt: 'Hello' });

    expect(result.tier).toBe('fallback');
    expect(result.degraded).toBe(true);
    expect(result.attemptedTiers).toHaveLength(2);
    expect(result.attemptedTiers[0].status).toBe('failure');
    expect(result.attemptedTiers[1].status).toBe('success');
  });

  it('requires at least one tier', () => {
    expect(() => new DegradationChain({ tiers: [] })).toThrow(
      'DegradationChain requires at least one tier'
    );
  });

  it('applies default globalTimeoutMs of 5000', async () => {
    const chain = new DegradationChain({
      tiers: [makePrimaryTier()],
    });

    const result = await chain.execute({ prompt: 'test' });
    // Should succeed — default timeout is 5000ms, primary takes 5ms
    expect(result.tier).toBe('primary');
  });

  it('applies default minQuality of 0.0', async () => {
    const chain = new DegradationChain({
      tiers: [
        makePrimaryTier({ failureRate: 1.0 }),
        makeStaticTier(), // quality 0.1
      ],
    });

    const result = await chain.execute({ prompt: 'test' });
    // Should reach static tier since minQuality defaults to 0.0
    expect(result.tier).toBe('static');
  });

  it('skips tiers below minQuality', async () => {
    const chain = new DegradationChain({
      tiers: [
        makePrimaryTier({ failureRate: 1.0 }),
        makeFallbackTier({ failureRate: 1.0 }),
        makeStaticTier(), // quality 0.1
      ],
      minQuality: 0.5,
    });

    // Static tier (0.1) should be skipped, all tiers exhausted
    await expect(chain.execute({ prompt: 'test' })).rejects.toThrow(
      AllTiersExhaustedError
    );
  });

  it('skips unhealthy tiers', async () => {
    const unhealthyPrimary: DegradationTier = {
      ...makePrimaryTier(),
      isHealthy: () => false,
    };

    const chain = new DegradationChain({
      tiers: [unhealthyPrimary, makeFallbackTier()],
    });

    const result = await chain.execute({ prompt: 'test' });

    expect(result.tier).toBe('fallback');
    expect(result.attemptedTiers[0].status).toBe('skipped_unhealthy');
  });

  it('fires onDegradation callback when not primary', async () => {
    const callback = vi.fn();

    const chain = new DegradationChain({
      tiers: [
        makePrimaryTier({ failureRate: 1.0 }),
        makeFallbackTier(),
      ],
      onDegradation: callback,
    });

    await chain.execute({ prompt: 'test' });

    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0][0].tier).toBe('fallback');
    expect(callback.mock.calls[0][0].degraded).toBe(true);
  });

  it('does not fire onDegradation when primary succeeds', async () => {
    const callback = vi.fn();

    const chain = new DegradationChain({
      tiers: [makePrimaryTier(), makeFallbackTier()],
      onDegradation: callback,
    });

    await chain.execute({ prompt: 'test' });

    expect(callback).not.toHaveBeenCalled();
  });

  it('records latency in result and attempt metadata', async () => {
    const chain = new DegradationChain({
      tiers: [makePrimaryTier({ latencyMs: 20 })],
    });

    const result = await chain.execute({ prompt: 'test' });

    expect(result.latencyMs).toBeGreaterThanOrEqual(15);
    expect(result.attemptedTiers[0].latencyMs).toBeGreaterThanOrEqual(15);
  });
});

// ---------------------------------------------------------------------------
// 2. Failure Mode Tests — one per failure mode from the table
// ---------------------------------------------------------------------------

describe('Failure Mode Tests', () => {
  // FM1: Stale cache served indefinitely
  it('FM1: detects stale cache being served', async () => {
    const { tier: cacheTier, populate } = makeCacheTier();
    populate('stale query', 'Old cached response from last week');

    const chain = new DegradationChain({
      tiers: [
        makePrimaryTier({ failureRate: 1.0 }),
        cacheTier,
      ],
    });

    const result = await chain.execute({ prompt: 'stale query' });

    // Detection: response came from cache tier, not primary
    expect(result.tier).toBe('cache');
    expect(result.degraded).toBe(true);
    expect(result.quality).toBe(0.5);
    // Mitigation: cached_at would be checked by the consumer via response metadata
    expect(result.response.finishReason).toBe('cache_hit');
  });

  // FM2: All tiers fail simultaneously
  it('FM2: throws AllTiersExhaustedError with per-tier details when all fail', async () => {
    const chain = new DegradationChain({
      tiers: [
        makePrimaryTier({ failureRate: 1.0 }),
        makeFallbackTier({ failureRate: 1.0 }),
      ],
    });

    try {
      await chain.execute({ prompt: 'test' });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AllTiersExhaustedError);
      const exhausted = err as AllTiersExhaustedError;
      expect(exhausted.attempts).toHaveLength(2);
      expect(exhausted.attempts[0].tier).toBe('primary');
      expect(exhausted.attempts[0].status).toBe('failure');
      expect(exhausted.attempts[1].tier).toBe('fallback');
      expect(exhausted.attempts[1].status).toBe('failure');
      expect(exhausted.message).toContain('All degradation tiers exhausted');
    }
  });

  // FM3: Health check false positive
  it('FM3: skips tier with false-positive health check, succeeds on next', async () => {
    let primaryActuallyHealthy = true;
    const healthyPrimary: DegradationTier = {
      ...makePrimaryTier(),
      // Health check says unhealthy even though provider is fine
      isHealthy: () => !primaryActuallyHealthy,
    };

    const chain = new DegradationChain({
      tiers: [healthyPrimary, makeFallbackTier()],
    });

    // Simulate false positive: primary is healthy but health check returns false
    primaryActuallyHealthy = true;
    const result = await chain.execute({ prompt: 'test' });

    // Detection: traffic went to fallback unnecessarily
    expect(result.tier).toBe('fallback');
    expect(result.attemptedTiers[0].status).toBe('skipped_unhealthy');
    expect(result.degraded).toBe(true);
  });

  // FM4: Fallback quality too low for use case
  it('FM4: minQuality prevents serving responses below threshold', async () => {
    const chain = new DegradationChain({
      tiers: [
        makePrimaryTier({ failureRate: 1.0 }),
        makeRuleTier(),    // quality 0.3
        makeStaticTier(),  // quality 0.1
      ],
      minQuality: 0.5,
    });

    // Both rule-based (0.3) and static (0.1) are below minQuality 0.5
    await expect(chain.execute({ prompt: 'hello' })).rejects.toThrow(
      AllTiersExhaustedError
    );
  });

  // FM5: Timeout cascade across tiers
  it('FM5: global timeout prevents cascade of slow tiers', async () => {
    const chain = new DegradationChain({
      tiers: [
        makePrimaryTier({ latencyMs: 300, failureRate: 1.0 }),
        makeFallbackTier({ latencyMs: 300, failureRate: 1.0 }),
        makeStaticTier(),
      ],
      globalTimeoutMs: 400,
    });

    const start = performance.now();
    try {
      await chain.execute({ prompt: 'test' });
      expect.fail('Should have thrown due to global timeout');
    } catch (err) {
      const elapsed = performance.now() - start;
      expect(err).toBeInstanceOf(AllTiersExhaustedError);
      const exhausted = err as AllTiersExhaustedError;

      // Global timeout prevented the full 600ms+ cascade (300+300 per-tier)
      expect(elapsed).toBeLessThan(550);

      // Static tier was skipped because global budget was exhausted
      const staticAttempt = exhausted.attempts.find((a) => a.tier === 'static');
      expect(staticAttempt?.status).toBe('timeout');
      expect(staticAttempt?.error).toContain('Global timeout');
    }
  });

  // FM6: Tier ordering becomes suboptimal
  it('FM6: per-tier metrics are available for ordering review', async () => {
    const chain = new DegradationChain({
      tiers: [
        makePrimaryTier({ latencyMs: 100 }),
        makeFallbackTier({ latencyMs: 5 }),
      ],
    });

    const result = await chain.execute({ prompt: 'test' });

    // Detection: primary works but is much slower than fallback would be
    expect(result.tier).toBe('primary');
    expect(result.attemptedTiers[0].latencyMs).toBeGreaterThan(50);
    // If we could compare: fallback latency (5ms) << primary latency (100ms)
    // The attemptedTiers metadata enables this comparison
  });

  // FM7: Cache poisoning
  it('FM7: poisoned cache entry is served when primary fails', async () => {
    const { tier: cacheTier, populate } = makeCacheTier();
    // Simulate a bad/hallucinated response getting cached
    populate('important query', '');

    const chain = new DegradationChain({
      tiers: [
        makePrimaryTier({ failureRate: 1.0 }),
        cacheTier,
        makeStaticTier(),
      ],
    });

    const result = await chain.execute({ prompt: 'important query' });

    // Detection: cache returns empty/bad content
    expect(result.tier).toBe('cache');
    expect(result.response.content).toBe('');
    // Mitigation: consumer should validate cache responses aren't empty
  });

  // FM8: Fallback tier behavioral divergence
  it('FM8: fallback tier returns structurally different responses', async () => {
    const ruleHandler = createRuleBasedHandler([
      { pattern: /.*/, response: 'Generic rule response' },
    ]);

    const chain = new DegradationChain({
      tiers: [
        makePrimaryTier({ failureRate: 1.0 }),
        {
          name: 'rule-based',
          handler: ruleHandler,
          qualityScore: 0.3,
          timeoutMs: 100,
        },
      ],
    });

    const result = await chain.execute({ prompt: 'complex analysis request' });

    // Detection: response came from rule-based tier for a complex request
    expect(result.tier).toBe('rule-based');
    expect(result.response.model).toBe('rule-based');
    expect(result.response.finishReason).toBe('rule_match');
    // The response metadata makes it clear this isn't an LLM response
  });

  // FM9: Silent degradation — quality tier drift
  it('FM9: quality tier drift is detectable via tier distribution tracking', async () => {
    let primaryHealthy = true;
    const primary: DegradationTier = {
      ...makePrimaryTier(),
      isHealthy: () => primaryHealthy,
    };

    const chain = new DegradationChain({
      tiers: [primary, makeFallbackTier()],
    });

    // Simulate a period of requests — track tier distribution
    const tierCounts: Record<string, number> = { primary: 0, fallback: 0 };

    // Week 1: primary is healthy
    for (let i = 0; i < 10; i++) {
      const result = await chain.execute({ prompt: `query ${i}` });
      tierCounts[result.tier]++;
    }

    // Week 1: should be 100% primary
    expect(tierCounts.primary).toBe(10);
    expect(tierCounts.fallback).toBe(0);

    // Simulate drift: primary becomes intermittently unhealthy
    primaryHealthy = false;
    for (let i = 0; i < 10; i++) {
      const result = await chain.execute({ prompt: `query ${i}` });
      tierCounts[result.tier]++;
    }

    // Detection: primary percentage has dropped significantly
    const total = tierCounts.primary + tierCounts.fallback;
    const primaryPercentage = tierCounts.primary / total;

    // Primary went from 100% to 50% — this drift is detectable
    expect(primaryPercentage).toBeLessThan(0.85);
    expect(tierCounts.fallback).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Integration Tests — end-to-end with mock provider
// ---------------------------------------------------------------------------

describe('Integration Tests', () => {
  it('full chain walks through all tiers to static', async () => {
    const { tier: cacheTier } = makeCacheTier();

    const chain = new DegradationChain({
      tiers: [
        makePrimaryTier({ failureRate: 1.0 }),
        makeFallbackTier({ failureRate: 1.0 }),
        cacheTier, // will miss since nothing cached
        makeRuleTier(), // won't match "xyz123"
        makeStaticTier(),
      ],
    });

    const result = await chain.execute({ prompt: 'xyz123 unmatched prompt' });

    expect(result.tier).toBe('static');
    expect(result.quality).toBe(0.1);
    expect(result.degraded).toBe(true);
    expect(result.response.content).toBe('Service is temporarily limited.');
    expect(result.attemptedTiers).toHaveLength(5);
    expect(result.attemptedTiers[0].status).toBe('failure'); // primary
    expect(result.attemptedTiers[1].status).toBe('failure'); // fallback
    expect(result.attemptedTiers[2].status).toBe('failure'); // cache miss
    expect(result.attemptedTiers[3].status).toBe('failure'); // no rule match
    expect(result.attemptedTiers[4].status).toBe('success'); // static
  });

  it('cache tier serves when populated and primary fails', async () => {
    const { tier: cacheTier, populate } = makeCacheTier();
    populate('What is TypeScript?', 'TypeScript is a typed superset of JavaScript.');

    const chain = new DegradationChain({
      tiers: [
        makePrimaryTier({ failureRate: 1.0 }),
        cacheTier,
        makeStaticTier(),
      ],
    });

    const result = await chain.execute({ prompt: 'What is TypeScript?' });

    expect(result.tier).toBe('cache');
    expect(result.quality).toBe(0.5);
    expect(result.response.content).toContain('TypeScript');
  });

  it('rule-based tier matches patterns when upstream fails', async () => {
    const chain = new DegradationChain({
      tiers: [
        makePrimaryTier({ failureRate: 1.0 }),
        makeRuleTier(),
        makeStaticTier(),
      ],
    });

    const result = await chain.execute({ prompt: 'Hello there!' });

    expect(result.tier).toBe('rule-based');
    expect(result.quality).toBe(0.3);
    expect(result.response.content).toBe('Hello! How can I help?');
  });

  it('handles concurrent requests independently', async () => {
    const chain = new DegradationChain({
      tiers: [makePrimaryTier({ latencyMs: 10 }), makeStaticTier()],
    });

    const results = await Promise.all([
      chain.execute({ prompt: 'request 1' }),
      chain.execute({ prompt: 'request 2' }),
      chain.execute({ prompt: 'request 3' }),
    ]);

    // All should succeed independently
    expect(results).toHaveLength(3);
    results.forEach((r) => {
      expect(r.tier).toBe('primary');
      expect(r.degraded).toBe(false);
    });
  });

  it('per-tier timeout triggers fallthrough', async () => {
    const slowPrimary: DegradationTier = {
      name: 'primary',
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return { content: 'slow response', model: 'slow' };
      },
      qualityScore: 1.0,
      timeoutMs: 50, // 50ms timeout, handler takes 1000ms
    };

    const chain = new DegradationChain({
      tiers: [slowPrimary, makeStaticTier()],
      globalTimeoutMs: 5000,
    });

    const result = await chain.execute({ prompt: 'test' });

    expect(result.tier).toBe('static');
    expect(result.attemptedTiers[0].status).toBe('timeout');
    expect(result.attemptedTiers[0].latencyMs).toBeLessThan(200);
  });

  it('mixed healthy/unhealthy tiers with cache hit', async () => {
    const unhealthyPrimary: DegradationTier = {
      ...makePrimaryTier(),
      isHealthy: () => false,
    };

    const { tier: cacheTier, populate } = makeCacheTier();
    populate('cached prompt', 'Previously cached response');

    const chain = new DegradationChain({
      tiers: [
        unhealthyPrimary,
        makeFallbackTier({ failureRate: 1.0 }),
        cacheTier,
        makeStaticTier(),
      ],
    });

    const result = await chain.execute({ prompt: 'cached prompt' });

    expect(result.tier).toBe('cache');
    expect(result.attemptedTiers[0].status).toBe('skipped_unhealthy');
    expect(result.attemptedTiers[1].status).toBe('failure');
    expect(result.attemptedTiers[2].status).toBe('success');
  });
});

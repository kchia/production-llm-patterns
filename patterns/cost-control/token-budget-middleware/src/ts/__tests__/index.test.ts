import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenBudgetMiddleware, BudgetExceededError } from '../index.js';
import { MockProvider } from '../mock-provider.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMiddleware(
  overrides: Partial<Parameters<typeof TokenBudgetMiddleware.prototype.execute>[0]> & {
    maxTokens?: number;
    windowMs?: number;
    warningThreshold?: number;
    onBudgetExceeded?: 'reject' | 'throttle' | 'warn-only';
    onWarning?: (usage: any) => void;
    estimateTokens?: (text: string) => number;
    providerConfig?: ConstructorParameters<typeof MockProvider>[0];
  } = {}
) {
  const provider = new MockProvider({
    latencyMs: 0,
    outputTokensPerResponse: 100,
    ...overrides.providerConfig,
  });
  const middleware = new TokenBudgetMiddleware({
    maxTokens: overrides.maxTokens ?? 10_000,
    windowMs: overrides.windowMs ?? 86_400_000,
    warningThreshold: overrides.warningThreshold ?? 0.8,
    onBudgetExceeded: overrides.onBudgetExceeded ?? 'reject',
    onWarning: overrides.onWarning,
    estimateTokens: overrides.estimateTokens,
    provider: (req) => provider.call(req),
  });
  return { middleware, provider };
}

// ---------------------------------------------------------------------------
// Unit Tests
// ---------------------------------------------------------------------------

describe('Unit: core budget logic', () => {
  it('tracks token usage across multiple requests', async () => {
    const { middleware } = createMiddleware({
      maxTokens: 10_000,
      providerConfig: { outputTokensPerResponse: 50 },
    });

    await middleware.execute({ prompt: 'a'.repeat(200) }); // ~50 input + 50 output = 100
    await middleware.execute({ prompt: 'b'.repeat(200) });

    const usage = middleware.getUsage('global');
    expect(usage.tokensUsed).toBeGreaterThanOrEqual(100);
    expect(usage.utilization).toBeGreaterThan(0);
  });

  it('returns correct remaining budget', async () => {
    const { middleware } = createMiddleware({ maxTokens: 1_000 });

    const before = middleware.getRemainingBudget('global');
    expect(before).toBe(1_000);

    await middleware.execute({ prompt: 'test' });

    const after = middleware.getRemainingBudget('global');
    expect(after).toBeLessThan(1_000);
  });

  it('resets budget for a specific key', async () => {
    const { middleware } = createMiddleware({ maxTokens: 1_000 });

    await middleware.execute({ prompt: 'test' });
    expect(middleware.getUsage('global').tokensUsed).toBeGreaterThan(0);

    middleware.resetBudget('global');
    expect(middleware.getUsage('global').tokensUsed).toBe(0);
  });

  it('uses default token estimation (~4 chars per token)', async () => {
    const { middleware } = createMiddleware({
      maxTokens: 100_000,
      providerConfig: { outputTokensPerResponse: 10 },
    });

    const result = await middleware.execute({ prompt: 'a'.repeat(400) });
    // 400 chars / 4 = 100 estimated input tokens
    expect(result.estimatedInputTokens).toBe(100);
  });

  it('accepts custom token estimator', async () => {
    const customEstimator = (text: string) => text.length; // 1 token per char
    const { middleware } = createMiddleware({
      maxTokens: 100_000,
      estimateTokens: customEstimator,
    });

    const result = await middleware.execute({ prompt: 'hello' });
    expect(result.estimatedInputTokens).toBe(5);
  });

  it('supports separate budget keys for different users', async () => {
    const { middleware } = createMiddleware({ maxTokens: 1_000 });

    await middleware.execute({ prompt: 'test' }, { budgetKey: 'user-a' });
    await middleware.execute({ prompt: 'test' }, { budgetKey: 'user-b' });

    const usageA = middleware.getUsage('user-a');
    const usageB = middleware.getUsage('user-b');
    expect(usageA.tokensUsed).toBeGreaterThan(0);
    expect(usageB.tokensUsed).toBeGreaterThan(0);
    // Each user has independent spend
    expect(usageA.tokensUsed).toBe(usageB.tokensUsed);
  });

  it('tracks parent keys for hierarchical budget enforcement', async () => {
    const { middleware } = createMiddleware({ maxTokens: 100_000 });

    await middleware.execute(
      { prompt: 'test' },
      { budgetKey: 'user-1', parentKeys: ['team-a', 'global'] }
    );

    expect(middleware.getUsage('user-1').tokensUsed).toBeGreaterThan(0);
    expect(middleware.getUsage('team-a').tokensUsed).toBeGreaterThan(0);
    expect(middleware.getUsage('global').tokensUsed).toBeGreaterThan(0);
  });

  it('resets window when duration expires', async () => {
    const { middleware } = createMiddleware({
      maxTokens: 1_000,
      windowMs: 50, // 50ms window for testing
    });

    await middleware.execute({ prompt: 'test' });
    expect(middleware.getUsage('global').tokensUsed).toBeGreaterThan(0);

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 60));

    const usage = middleware.getUsage('global');
    expect(usage.tokensUsed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Failure Mode Tests
// ---------------------------------------------------------------------------

describe('Failure mode: budget exceeded (reject strategy)', () => {
  it('throws BudgetExceededError when budget would be exceeded', async () => {
    const { middleware } = createMiddleware({
      maxTokens: 50, // Very small budget
      providerConfig: { outputTokensPerResponse: 100 },
    });

    // First request uses the budget
    await middleware.execute({ prompt: 'hi' });

    // Second request should exceed
    await expect(
      middleware.execute({ prompt: 'hello again' })
    ).rejects.toThrow(BudgetExceededError);
  });

  it('includes usage details in BudgetExceededError', async () => {
    const { middleware } = createMiddleware({
      maxTokens: 50,
      providerConfig: { outputTokensPerResponse: 100 },
    });

    await middleware.execute({ prompt: 'hi' });

    try {
      await middleware.execute({ prompt: 'hello' });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      const budgetErr = err as BudgetExceededError;
      expect(budgetErr.usage.budgetKey).toBe('global');
      expect(budgetErr.usage.tokensUsed).toBeGreaterThan(0);
      expect(budgetErr.estimatedCost).toBeGreaterThan(0);
    }
  });
});

describe('Failure mode: warn-only strategy allows requests through', () => {
  it('does not throw when budget exceeded in warn-only mode', async () => {
    const { middleware } = createMiddleware({
      maxTokens: 50,
      onBudgetExceeded: 'warn-only',
      providerConfig: { outputTokensPerResponse: 100 },
    });

    await middleware.execute({ prompt: 'hi' });

    // Second request exceeds budget but warn-only lets it through
    const result = await middleware.execute({ prompt: 'hello again' });
    expect(result.response.content).toBeTruthy();
  });
});

describe('Failure mode: token estimation drift', () => {
  it('detects when actual tokens diverge from estimates', async () => {
    // Estimator says 10 tokens, provider returns 500 — big drift
    const { middleware } = createMiddleware({
      maxTokens: 100_000,
      estimateTokens: () => 10,
      providerConfig: { outputTokensPerResponse: 500 },
    });

    const result = await middleware.execute({ prompt: 'test' });
    const drift = Math.abs(result.actualTokens - result.estimatedInputTokens) / result.actualTokens;
    // Drift is measurable — the caller can compare estimatedInputTokens vs actualTokens
    expect(drift).toBeGreaterThan(0.5);
  });
});

describe('Failure mode: window boundary reset', () => {
  it('resets token count when window expires', async () => {
    const { middleware } = createMiddleware({
      maxTokens: 200,
      windowMs: 50,
      providerConfig: { outputTokensPerResponse: 100 },
    });

    // Fill the budget
    await middleware.execute({ prompt: 'test' });
    expect(middleware.getUsage('global').tokensUsed).toBeGreaterThan(0);

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 60));

    // Should succeed — budget reset
    const result = await middleware.execute({ prompt: 'test again' });
    expect(result.response.content).toBeTruthy();
  });
});

describe('Failure mode: warning threshold', () => {
  it('fires warning callback when threshold is crossed', async () => {
    const warningFn = vi.fn();
    const { middleware } = createMiddleware({
      maxTokens: 200,
      warningThreshold: 0.5, // warn at 50%
      onWarning: warningFn,
      providerConfig: { outputTokensPerResponse: 150 },
    });

    await middleware.execute({ prompt: 'test' });

    expect(warningFn).toHaveBeenCalledOnce();
    expect(warningFn.mock.calls[0][0].utilization).toBeGreaterThanOrEqual(0.5);
  });

  it('fires warning only once per window', async () => {
    const warningFn = vi.fn();
    const { middleware } = createMiddleware({
      maxTokens: 10_000,
      warningThreshold: 0.01, // very low — will trigger immediately
      onWarning: warningFn,
      onBudgetExceeded: 'warn-only',
      providerConfig: { outputTokensPerResponse: 50 },
    });

    await middleware.execute({ prompt: 'test1' });
    await middleware.execute({ prompt: 'test2' });
    await middleware.execute({ prompt: 'test3' });

    expect(warningFn).toHaveBeenCalledOnce();
  });
});

describe('Failure mode: silent budget erosion', () => {
  it('tracks increasing average tokens per request over time', async () => {
    const { middleware } = createMiddleware({
      maxTokens: 100_000,
      providerConfig: { outputTokensPerResponse: 100 },
    });

    // Simulate "prompt growth" by increasing prompt size
    const tokenHistory: number[] = [];

    for (let i = 0; i < 10; i++) {
      // Each request has a longer prompt, simulating prompt drift
      const prompt = 'x'.repeat(100 * (i + 1));
      const result = await middleware.execute({ prompt });
      tokenHistory.push(result.actualTokens);
    }

    // Verify tokens-per-request is increasing (proxy for detecting drift)
    const firstHalf = tokenHistory.slice(0, 5);
    const secondHalf = tokenHistory.slice(5);
    const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

    // Second half should have higher avg tokens due to longer prompts
    expect(avgSecond).toBeGreaterThan(avgFirst);
  });
});

describe('Failure mode: over-aggressive rejection', () => {
  it('does not reject when budget has headroom', async () => {
    const { middleware } = createMiddleware({
      maxTokens: 10_000,
      providerConfig: { outputTokensPerResponse: 50 },
    });

    // Should succeed — well within budget
    const result = await middleware.execute({ prompt: 'small request' });
    expect(result.response.content).toBeTruthy();
    expect(result.usage.remaining).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe('Integration: end-to-end with mock provider', () => {
  it('processes multiple requests until budget is exhausted', async () => {
    const { middleware, provider } = createMiddleware({
      maxTokens: 500,
      providerConfig: { outputTokensPerResponse: 100 },
    });

    let completed = 0;
    let rejected = false;

    for (let i = 0; i < 10; i++) {
      try {
        await middleware.execute({ prompt: `request ${i}` });
        completed++;
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          rejected = true;
          break;
        }
        throw err;
      }
    }

    expect(completed).toBeGreaterThan(0);
    expect(completed).toBeLessThan(10);
    expect(rejected).toBe(true);
    expect(provider.getCallCount()).toBe(completed);
  });

  it('isolates budgets across concurrent users', async () => {
    const { middleware } = createMiddleware({
      maxTokens: 300,
      providerConfig: { outputTokensPerResponse: 200 },
    });

    // User A exhausts budget (200 output + ~25 input = ~225 per call)
    await middleware.execute({ prompt: 'a'.repeat(100) }, { budgetKey: 'user-a' });

    // User A should be blocked — already at ~225, next estimate ~25 → 250 + 25 > 300?
    // Actually, used 225, next estimated 25 → 250 < 300. Use bigger prompts.
    await expect(
      middleware.execute({ prompt: 'a'.repeat(400) }, { budgetKey: 'user-a' })
    ).rejects.toThrow(BudgetExceededError);

    // User B should still work — independent budget
    const result = await middleware.execute(
      { prompt: 'b1' },
      { budgetKey: 'user-b' }
    );
    expect(result.response.content).toBeTruthy();
  });

  it('tracks budget correctly with variable-length responses', async () => {
    const { middleware } = createMiddleware({
      maxTokens: 10_000,
      providerConfig: {
        outputTokensPerResponse: 100,
        outputTokenVariance: 50, // ±50 tokens
      },
    });

    const results: number[] = [];
    for (let i = 0; i < 20; i++) {
      const result = await middleware.execute({ prompt: `req ${i}` });
      results.push(result.actualTokens);
    }

    // With variance, not all responses should have identical token counts
    const unique = new Set(results);
    expect(unique.size).toBeGreaterThan(1);

    // Total tracked should match sum of individual actuals
    const totalTracked = middleware.getUsage('global').tokensUsed;
    const totalActual = results.reduce((a, b) => a + b, 0);
    expect(totalTracked).toBe(totalActual);
  });
});

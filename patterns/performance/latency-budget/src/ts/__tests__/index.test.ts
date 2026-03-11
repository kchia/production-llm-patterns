import { describe, it, expect, vi } from 'vitest';
import {
  LatencyBudget,
  LatencyBudgetPipeline,
  PipelineStep,
  createStep,
} from '../index';
import { MockProvider } from '../mock-provider';
import { PipelineMetrics } from '../types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Unit Tests ──────────────────────────────────────────────────────

describe('LatencyBudget', () => {
  it('reports remaining time accurately', () => {
    const budget = new LatencyBudget(1000);
    expect(budget.remaining()).toBeGreaterThan(990);
    expect(budget.remaining()).toBeLessThanOrEqual(1000);
  });

  it('reports elapsed time', async () => {
    const budget = new LatencyBudget(5000);
    await sleep(50);
    expect(budget.elapsed()).toBeGreaterThanOrEqual(40);
  });

  it('detects expiration', async () => {
    const budget = new LatencyBudget(30);
    expect(budget.isExpired()).toBe(false);
    await sleep(50);
    expect(budget.isExpired()).toBe(true);
  });

  it('reports utilization as a fraction', async () => {
    const budget = new LatencyBudget(100);
    await sleep(50);
    const util = budget.utilization();
    expect(util).toBeGreaterThan(0.3);
    expect(util).toBeLessThan(1.5);
  });

  it('creates child budget capped at parent remaining', () => {
    const parent = new LatencyBudget(500);
    const child = parent.child(2000);
    expect(child.remaining()).toBeLessThanOrEqual(500);
  });

  it('creates child budget at requested amount when parent has surplus', () => {
    const parent = new LatencyBudget(5000);
    const child = parent.child(200);
    expect(child.remaining()).toBeLessThanOrEqual(200);
    expect(child.remaining()).toBeGreaterThan(190);
  });

  it('handles zero budget', () => {
    const budget = new LatencyBudget(0);
    expect(budget.remaining()).toBe(0);
    expect(budget.isExpired()).toBe(true);
  });
});

describe('PipelineStep', () => {
  it('executes a step and reports timing', async () => {
    const step = createStep('test-step', async (input: string) => {
      await sleep(20);
      return `processed: ${input}`;
    }, { minBudgetMs: 10 });

    const budget = new LatencyBudget(5000);
    const result = await step.execute('hello', budget);

    expect(result.skipped).toBe(false);
    expect(result.output).toBe('processed: hello');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(15);
  });

  it('skips when budget is below minBudgetMs', async () => {
    const step = createStep('expensive-step', async () => {
      await sleep(100);
      return 'done';
    }, { minBudgetMs: 500 });

    const budget = new LatencyBudget(50);
    const result = await step.execute('input', budget);

    expect(result.skipped).toBe(true);
    expect(result.output).toBeNull();
  });

  it('uses child budget when timeoutMs is configured', async () => {
    const step = createStep('timed-step', async (input: string, budget) => {
      expect(budget.remaining()).toBeLessThanOrEqual(200);
      return 'done';
    }, { minBudgetMs: 10, timeoutMs: 200 });

    const budget = new LatencyBudget(5000);
    await step.execute('input', budget);
  });

  it('catches errors on optional steps and marks as skipped', async () => {
    const step = createStep('failing-optional', async () => {
      throw new Error('step failed');
    }, { minBudgetMs: 10, optional: true });

    const budget = new LatencyBudget(5000);
    const result = await step.execute('input', budget);
    expect(result.skipped).toBe(true);
    expect(result.output).toBeNull();
  });

  it('propagates errors on required steps', async () => {
    const step = createStep('failing-required', async () => {
      throw new Error('critical failure');
    }, { minBudgetMs: 10, optional: false });

    const budget = new LatencyBudget(5000);
    await expect(step.execute('input', budget)).rejects.toThrow('critical failure');
  });
});

describe('LatencyBudgetPipeline', () => {
  it('applies default config values', async () => {
    const step = createStep('simple', async (i: string) => i);
    const pipeline = new LatencyBudgetPipeline([step]);

    const { metrics } = await pipeline.execute('test');
    expect(metrics.deadlineExceeded).toBe(false);
  });

  it('passes output from one step to the next', async () => {
    const step1 = createStep('step1', async (i: string) => `${i}+step1`);
    const step2 = createStep('step2', async (i: string) => `${i}+step2`);
    const pipeline = new LatencyBudgetPipeline([step1, step2], { totalBudgetMs: 5000 });

    const { results } = await pipeline.execute('start');
    expect(results[1].output).toBe('start+step1+step2');
  });

  it('emits metrics via callback', async () => {
    let capturedMetrics: PipelineMetrics | null = null;
    const step = createStep('simple', async (i: string) => i);
    const pipeline = new LatencyBudgetPipeline([step]);
    pipeline.onMetrics((m) => { capturedMetrics = m; });

    await pipeline.execute('test');
    expect(capturedMetrics).not.toBeNull();
    expect(capturedMetrics!.stepTimings).toHaveLength(1);
  });
});

// ── Failure Mode Tests ──────────────────────────────────────────────

describe('Failure Mode: Budget too tight', () => {
  it('skips optional steps when budget is insufficient', async () => {
    const provider = new MockProvider({ latencyMs: 100, varianceMs: 0 });

    const step1 = createStep('retrieval', async (i: string) => {
      await provider.generate(i);
      return i;
    }, { minBudgetMs: 50 });

    const step2 = createStep('reranking', async (i: string) => {
      await sleep(50);
      return i;
    }, { minBudgetMs: 100, optional: true });

    const step3 = createStep('generation', async (i: string) => {
      await provider.generate(i);
      return 'generated';
    }, { minBudgetMs: 50 });

    const pipeline = new LatencyBudgetPipeline([step1, step2, step3], {
      totalBudgetMs: 250,
      reserveMs: 50,
    });

    const { metrics } = await pipeline.execute('query');
    expect(metrics.skippedSteps).toBeGreaterThanOrEqual(1);
  });
});

describe('Failure Mode: Budget too loose', () => {
  it('never skips when budget is extremely generous', async () => {
    const steps = [
      createStep('fast1', async (i: string) => i, { minBudgetMs: 10, optional: true }),
      createStep('fast2', async (i: string) => i, { minBudgetMs: 10, optional: true }),
      createStep('fast3', async (i: string) => i, { minBudgetMs: 10, optional: true }),
    ];

    const pipeline = new LatencyBudgetPipeline(steps, { totalBudgetMs: 60000 });

    const { metrics } = await pipeline.execute('test');
    expect(metrics.skippedSteps).toBe(0);
    expect(metrics.budgetUtilization).toBeLessThan(0.01);
  });
});

describe('Failure Mode: Cascading skips', () => {
  it('one slow step causes all downstream optional steps to skip', async () => {
    const step1 = createStep('slow-retrieval', async (i: string) => {
      await sleep(150);
      return i;
    }, { minBudgetMs: 50 });

    const step2 = createStep('reranking', async (i: string) => {
      return `reranked: ${i}`;
    }, { minBudgetMs: 80, optional: true });

    const step3 = createStep('validation', async (i: string) => {
      return `validated: ${i}`;
    }, { minBudgetMs: 80, optional: true });

    const pipeline = new LatencyBudgetPipeline([step1, step2, step3], {
      totalBudgetMs: 250,
      reserveMs: 50,
    });

    const { metrics } = await pipeline.execute('query');
    expect(metrics.skippedSteps).toBe(2);
  });
});

describe('Failure Mode: Budget check overhead', () => {
  it('budget operations are sub-millisecond', () => {
    const budget = new LatencyBudget(5000);
    const iterations = 10000;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      budget.remaining();
      budget.elapsed();
      budget.isExpired();
      budget.utilization();
    }

    const totalMs = performance.now() - start;
    const perOpMs = totalMs / (iterations * 4);
    expect(perOpMs).toBeLessThan(0.01);
  });
});

describe('Failure Mode: Silent quality degradation', () => {
  it('tracks skip rate increase as provider latency grows', async () => {
    const provider = new MockProvider({ latencyMs: 50, varianceMs: 0 });

    const steps = [
      createStep('retrieval', async (i: string) => {
        await provider.generate(i);
        return i;
      }, { minBudgetMs: 30 }),
      createStep('reranking', async (i: string) => {
        await sleep(30);
        return i;
      }, { minBudgetMs: 50, optional: true }),
      createStep('generation', async (i: string) => {
        await provider.generate(i);
        return 'result';
      }, { minBudgetMs: 30 }),
    ];

    const pipeline = new LatencyBudgetPipeline(steps, {
      totalBudgetMs: 200,
      reserveMs: 20,
    });

    // Phase 1: fast provider
    const { metrics: m1 } = await pipeline.execute('query');

    // Phase 2: provider gets slower
    provider.updateConfig({ latencyMs: 100 });
    const { metrics: m2 } = await pipeline.execute('query');

    expect(m2.skippedSteps).toBeGreaterThanOrEqual(m1.skippedSteps);
  });
});

describe('Failure Mode: Stale budget after retry', () => {
  it('remaining budget decreases after failed attempt time', async () => {
    const budget = new LatencyBudget(500);

    await sleep(200);
    const remainingAfterFailure = budget.remaining();
    expect(remainingAfterFailure).toBeLessThan(350);

    const retryBudget = budget.child(budget.remaining());
    expect(retryBudget.remaining()).toBeLessThan(350);
  });
});

// ── Integration Tests ───────────────────────────────────────────────

describe('Integration: Full RAG pipeline with mock provider', () => {
  it('runs a 4-step RAG pipeline end-to-end', async () => {
    const provider = new MockProvider({
      latencyMs: 100,
      varianceMs: 10,
      outputTokens: 200,
    });

    const retrieval = createStep('retrieval', async (query: string) => {
      await sleep(30);
      return { query, chunks: ['chunk1', 'chunk2'] };
    }, { minBudgetMs: 50 });

    const reranking = createStep('reranking', async (ctx: { query: string; chunks: string[] }) => {
      await sleep(20);
      return { ...ctx, chunks: ctx.chunks.reverse() };
    }, { minBudgetMs: 50, optional: true });

    const generation = createStep('generation', async (ctx: { query: string; chunks: string[] }) => {
      const prompt = `Answer "${ctx.query}" using: ${ctx.chunks.join(', ')}`;
      const resp = await provider.generate(prompt);
      return { text: resp.text, tokens: resp.outputTokens };
    }, { minBudgetMs: 100 });

    const validation = createStep('validation', async (ctx: { text: string; tokens: number }) => {
      await sleep(10);
      return { ...ctx, validated: true };
    }, { minBudgetMs: 20, optional: true });

    const pipeline = new LatencyBudgetPipeline(
      [retrieval, reranking, generation, validation],
      { totalBudgetMs: 3000, reserveMs: 100 },
    );

    let metricsReceived: PipelineMetrics | null = null;
    pipeline.onMetrics((m) => { metricsReceived = m; });

    const { results, metrics } = await pipeline.execute('What is latency budgeting?');

    expect(results).toHaveLength(4);
    expect(metrics.deadlineExceeded).toBe(false);
    expect(metrics.stepTimings).toHaveLength(4);
    expect(metrics.budgetUtilization).toBeLessThan(1);
    expect(metricsReceived).not.toBeNull();
    expect(metricsReceived!.stepTimings[0].name).toBe('retrieval');
  });

  it('handles abort strategy', async () => {
    const steps = [
      createStep('slow', async (i: string) => {
        await sleep(200);
        return i;
      }, { minBudgetMs: 50 }),
      createStep('after-slow', async (i: string) => {
        return `processed: ${i}`;
      }, { minBudgetMs: 100 }),
    ];

    const pipeline = new LatencyBudgetPipeline(steps, {
      totalBudgetMs: 250,
      reserveMs: 50,
      onBudgetExhausted: 'abort',
    });

    const { results } = await pipeline.execute('test');
    expect(results.length).toBe(2);
  });
});

describe('Integration: Concurrent pipeline executions', () => {
  it('each execution gets its own budget', async () => {
    const step = createStep('step', async (i: string) => {
      await sleep(20);
      return i;
    }, { minBudgetMs: 10 });

    const pipeline = new LatencyBudgetPipeline([step], { totalBudgetMs: 1000 });

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => pipeline.execute(`query-${i}`))
    );

    results.forEach(({ metrics }) => {
      expect(metrics.deadlineExceeded).toBe(false);
      expect(metrics.skippedSteps).toBe(0);
    });
  });
});

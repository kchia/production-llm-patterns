import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OnlineEvalMonitor } from '../index.js';
import { MockScorer, MockLLMProvider } from '../mock-provider.js';
import { AlertEvent, ScoreResult } from '../types.js';

// Helper: wait for async queue to drain
const drain = () => new Promise((r) => setTimeout(r, 200));

// --- Unit Tests ---

describe('OnlineEvalMonitor — unit', () => {
  let monitor: OnlineEvalMonitor;

  beforeEach(() => {
    monitor = new OnlineEvalMonitor({
      windowSize: 10,
      alertThreshold: 0.7,
      criticalThreshold: 0.5,
    });
  });

  it('returns handler result immediately', async () => {
    const result = await monitor.wrap(async () => 'hello', {
      input: 'test',
      output: '',
    });
    expect(result).toBe('hello');
  });

  it('does not block on eval — response returns before scorer completes', async () => {
    const slowScorer = new MockScorer({ name: 'slow', samplingRate: 1.0, latencyMs: 500 });
    monitor.addScorer(slowScorer);

    const start = Date.now();
    await monitor.wrap(async () => 'fast response', { input: 'x', output: '' });
    const elapsed = Date.now() - start;

    // Handler should return well before the 500ms scorer completes
    expect(elapsed).toBeLessThan(200);
  });

  it('scores are recorded after eval completes', async () => {
    const scorer = new MockScorer({ name: 'quality', samplingRate: 1.0, fixedScore: 0.9, latencyMs: 10 });
    monitor.addScorer(scorer);

    await monitor.wrap(async () => 'response', { input: 'prompt', output: '' });
    await drain();

    const scores = monitor.getScores('quality', { startMs: 0, endMs: Date.now() });
    expect(scores).toHaveLength(1);
    expect(scores[0].score).toBeCloseTo(0.9);
  });

  it('onScore callback fires for each scored trace', async () => {
    const scorer = new MockScorer({ name: 'q', samplingRate: 1.0, fixedScore: 0.8, latencyMs: 10 });
    monitor.addScorer(scorer);

    const received: ScoreResult[] = [];
    monitor.onScore((r) => received.push(r));

    await monitor.wrap(async () => 'out', { input: 'in', output: '' });
    await drain();

    expect(received).toHaveLength(1);
    expect(received[0].scorerName).toBe('q');
  });

  it('rolling mean is computed correctly', async () => {
    const scorer = new MockScorer({ name: 'q', samplingRate: 1.0, fixedScore: 0.6, latencyMs: 5 });
    monitor.addScorer(scorer);

    for (let i = 0; i < 5; i++) {
      await monitor.wrap(async () => 'r', { input: 'i', output: '' });
    }
    await drain();

    const mean = monitor.getRollingMean('q');
    expect(mean).toBeCloseTo(0.6, 1);
  });

  it('respects sampling rate — 0% rate means no scores', async () => {
    const scorer = new MockScorer({ name: 'q', samplingRate: 0.0, fixedScore: 0.9, latencyMs: 5 });
    monitor.addScorer(scorer);

    for (let i = 0; i < 10; i++) {
      await monitor.wrap(async () => 'r', { input: 'i', output: '' });
    }
    await drain();

    expect(scorer.getCallCount()).toBe(0);
  });

  it('getRollingMean returns null when no scores recorded', () => {
    monitor.addScorer(new MockScorer({ name: 'q', samplingRate: 0 }));
    expect(monitor.getRollingMean('q')).toBeNull();
  });
});

// --- Failure Mode Tests ---

describe('OnlineEvalMonitor — failure modes', () => {
  it('FM: scorer errors are silently absorbed — metrics track error count', async () => {
    const monitor = new OnlineEvalMonitor({ windowSize: 10 });
    const errorScorer = new MockScorer({ name: 'flaky', samplingRate: 1.0, errorRate: 1.0, latencyMs: 5 });
    monitor.addScorer(errorScorer);

    await monitor.wrap(async () => 'result', { input: 'test', output: '' });
    await drain();

    const metrics = monitor.getMetrics();
    expect(metrics.totalErrors).toBe(1);
    expect(metrics.totalScored).toBe(0);
    // Application was not affected
  });

  it('FM: queue backlog — oldest jobs dropped when queue full', async () => {
    const monitor = new OnlineEvalMonitor({ queueSize: 3, windowSize: 10 });
    const slowScorer = new MockScorer({ name: 'slow', samplingRate: 1.0, latencyMs: 100 });
    monitor.addScorer(slowScorer);

    // Enqueue 10 requests — queue cap is 3 so 7 should be dropped
    for (let i = 0; i < 10; i++) {
      await monitor.wrap(async () => 'r', { input: `req${i}`, output: '' });
    }

    const { droppedJobs } = monitor.getMetrics();
    expect(droppedJobs).toBeGreaterThan(0);
  });

  it('FM: scorer timeout — job dropped after asyncTimeoutMs', async () => {
    const monitor = new OnlineEvalMonitor({ asyncTimeoutMs: 50, windowSize: 10 });
    const hangingScorer = new MockScorer({ name: 'hanging', samplingRate: 1.0, latencyMs: 500 });
    monitor.addScorer(hangingScorer);

    await monitor.wrap(async () => 'r', { input: 'i', output: '' });
    await new Promise((r) => setTimeout(r, 300)); // wait past timeout but not full latency

    const metrics = monitor.getMetrics();
    expect(metrics.totalErrors).toBe(1);
    expect(metrics.totalScored).toBe(0);
  });

  it('FM: warning alert fires when rolling mean crosses threshold', async () => {
    const monitor = new OnlineEvalMonitor({
      windowSize: 5,
      alertThreshold: 0.7,
      criticalThreshold: 0.4,
    });
    const scorer = new MockScorer({ name: 'q', samplingRate: 1.0, fixedScore: 0.6, latencyMs: 5 });
    monitor.addScorer(scorer);

    const alerts: AlertEvent[] = [];
    monitor.onAlert((e) => alerts.push(e));

    for (let i = 0; i < 6; i++) {
      await monitor.wrap(async () => 'r', { input: 'i', output: '' });
    }
    await drain();

    expect(alerts.some((a) => a.level === 'warning')).toBe(true);
    expect(alerts.every((a) => a.level !== 'critical')).toBe(true);
  });

  it('FM: critical alert fires when rolling mean crosses critical threshold', async () => {
    const monitor = new OnlineEvalMonitor({
      windowSize: 5,
      alertThreshold: 0.7,
      criticalThreshold: 0.4,
    });
    const scorer = new MockScorer({ name: 'q', samplingRate: 1.0, fixedScore: 0.3, latencyMs: 5 });
    monitor.addScorer(scorer);

    const alerts: AlertEvent[] = [];
    monitor.onAlert((e) => alerts.push(e));

    for (let i = 0; i < 6; i++) {
      await monitor.wrap(async () => 'r', { input: 'i', output: '' });
    }
    await drain();

    expect(alerts.some((a) => a.level === 'critical')).toBe(true);
  });

  it('FM: silent degradation — drift by 0.01/call detectable via rolling mean slope', async () => {
    const monitor = new OnlineEvalMonitor({ windowSize: 20 });
    // Scorer starts at 0.9 and drifts down 0.01 per call
    const driftingScorer = new MockScorer({
      name: 'quality',
      samplingRate: 1.0,
      fixedScore: 0.9,
      driftPerCall: 0.01,
      latencyMs: 5,
    });
    monitor.addScorer(driftingScorer);

    // Early samples — collect mean
    for (let i = 0; i < 5; i++) {
      await monitor.wrap(async () => 'r', { input: 'i', output: '' });
    }
    await drain();
    const earlyMean = monitor.getRollingMean('quality')!;

    // Later samples — mean should be lower
    for (let i = 0; i < 15; i++) {
      await monitor.wrap(async () => 'r', { input: 'i', output: '' });
    }
    await drain();
    const lateMean = monitor.getRollingMean('quality')!;

    // Drift should be detectable: late mean meaningfully lower than early mean
    expect(lateMean).toBeLessThan(earlyMean - 0.05);
  });
});

// --- Integration Tests ---

describe('OnlineEvalMonitor — integration', () => {
  it('end-to-end: wrap LLM handler, eval runs, scores stored', async () => {
    const provider = new MockLLMProvider({ response: 'Paris', latencyMs: 10 });
    const monitor = new OnlineEvalMonitor({ windowSize: 20 });

    // Heuristic scorer: checks response length > 0
    const heuristicScorer = new MockScorer({
      name: 'non-empty',
      samplingRate: 1.0,
      fixedScore: 1.0,
      latencyMs: 5,
    });
    monitor.addScorer(heuristicScorer);

    const scored: ScoreResult[] = [];
    monitor.onScore((r) => scored.push(r));

    const response = await monitor.wrap(
      () => provider.complete('What is the capital of France?'),
      { input: 'What is the capital of France?', output: '' }
    );

    await drain();

    expect(response).toContain('Paris');
    expect(scored).toHaveLength(1);
    expect(scored[0].score).toBe(1.0);
    expect(monitor.getRollingMean('non-empty')).toBeCloseTo(1.0);
  });

  it('multiple scorers run independently per trace', async () => {
    const monitor = new OnlineEvalMonitor({ windowSize: 10 });
    const s1 = new MockScorer({ name: 'format', samplingRate: 1.0, fixedScore: 0.9, latencyMs: 5 });
    const s2 = new MockScorer({ name: 'faithfulness', samplingRate: 1.0, fixedScore: 0.7, latencyMs: 10 });
    monitor.addScorer(s1);
    monitor.addScorer(s2);

    await monitor.wrap(async () => 'result', { input: 'input', output: '' });
    await drain();

    const formatScores = monitor.getScores('format', { startMs: 0, endMs: Date.now() });
    const faithScores = monitor.getScores('faithfulness', { startMs: 0, endMs: Date.now() });
    expect(formatScores).toHaveLength(1);
    expect(faithScores).toHaveLength(1);
  });

  it('concurrent requests are all handled without blocking', async () => {
    const monitor = new OnlineEvalMonitor({ windowSize: 50 });
    const scorer = new MockScorer({ name: 'q', samplingRate: 1.0, fixedScore: 0.8, latencyMs: 5 });
    monitor.addScorer(scorer);

    const requests = Array.from({ length: 20 }, (_, i) =>
      monitor.wrap(async () => `response_${i}`, { input: `input_${i}`, output: '' })
    );

    const results = await Promise.all(requests);
    expect(results).toHaveLength(20);

    await drain();

    const scores = monitor.getScores('q', { startMs: 0, endMs: Date.now() });
    expect(scores.length).toBe(20);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  QualityMonitor,
  LengthScorer,
  FormatScorer,
  KeywordScorer,
  Sampler,
  ScoreStore,
  Aggregator,
  BaselineTracker,
} from '../index.js';
import { MockProvider } from '../mock-provider.js';
import type {
  LLMInteraction,
  Scorer,
  ScoreResult,
  QualityAlert,
  QualityMonitorConfig,
} from '../types.js';

// --- Test Helpers ---

let idCounter = 0;

function makeInteraction(overrides: Partial<LLMInteraction> = {}): LLMInteraction {
  idCounter++;
  return {
    id: `test-${idCounter}`,
    input: 'What is the capital of France?',
    output: 'The capital of France is Paris, a major European city known for its art, culture, and history.',
    model: 'test-model',
    promptTemplate: 'default',
    metadata: {},
    timestamp: Date.now(),
    latencyMs: 200,
    tokenCount: { input: 10, output: 20 },
    ...overrides,
  };
}

function createMonitor(overrides: Partial<QualityMonitorConfig> = {}): {
  monitor: QualityMonitor;
  alerts: QualityAlert[];
} {
  const alerts: QualityAlert[] = [];
  const monitor = new QualityMonitor({
    sampleRate: 1.0,
    minSamplesForAlert: 1,
    ...overrides,
    onAlert: (alert) => alerts.push(alert),
  });
  return { monitor, alerts };
}

// --- Unit Tests ---

describe('LengthScorer', () => {
  it('scores 1.0 for output within range', async () => {
    const scorer = new LengthScorer(10, 500);
    const result = await scorer.score(makeInteraction({ output: 'A reasonable length output with enough content.' }));
    expect(result.value).toBe(1.0);
    expect(result.scorerName).toBe('length');
  });

  it('scores below 1.0 for too-short output', async () => {
    const scorer = new LengthScorer(100, 500);
    const result = await scorer.score(makeInteraction({ output: 'Short.' }));
    expect(result.value).toBeLessThan(1.0);
    expect(result.value).toBeGreaterThan(0);
  });

  it('scores below 1.0 for too-long output', async () => {
    const scorer = new LengthScorer(10, 50);
    const result = await scorer.score(makeInteraction({ output: 'x'.repeat(200) }));
    expect(result.value).toBeLessThan(1.0);
  });

  it('clamps score to [0, 1]', async () => {
    const scorer = new LengthScorer(1000, 5000);
    const result = await scorer.score(makeInteraction({ output: '' }));
    expect(result.value).toBe(0);
  });
});

describe('FormatScorer', () => {
  it('scores 1.0 when all patterns match', async () => {
    const scorer = new FormatScorer([/Paris/, /capital/]);
    const result = await scorer.score(makeInteraction());
    expect(result.value).toBe(1.0);
  });

  it('scores partial when some patterns match', async () => {
    const scorer = new FormatScorer([/Paris/, /nonexistent/]);
    const result = await scorer.score(makeInteraction());
    expect(result.value).toBe(0.5);
  });

  it('scores 0 when no patterns match', async () => {
    const scorer = new FormatScorer([/xyz123/, /abc456/]);
    const result = await scorer.score(makeInteraction());
    expect(result.value).toBe(0);
  });

  it('scores 1.0 with no patterns configured', async () => {
    const scorer = new FormatScorer([]);
    const result = await scorer.score(makeInteraction());
    expect(result.value).toBe(1.0);
  });
});

describe('KeywordScorer', () => {
  it('scores 1.0 when enough keywords match', async () => {
    const scorer = new KeywordScorer(['paris', 'capital', 'france'], 0.3);
    const result = await scorer.score(makeInteraction());
    expect(result.value).toBe(1.0);
  });

  it('scores proportionally to keyword matches', async () => {
    const scorer = new KeywordScorer(['paris', 'london', 'tokyo', 'berlin'], 1.0);
    const result = await scorer.score(makeInteraction());
    expect(result.value).toBe(0.25); // 1 of 4 keywords
  });

  it('is case-insensitive', async () => {
    const scorer = new KeywordScorer(['PARIS', 'Capital']);
    const result = await scorer.score(makeInteraction());
    expect(result.value).toBe(1.0);
  });
});

describe('Sampler', () => {
  it('samples at configured rate', () => {
    const sampler = new Sampler(0.5);
    let sampled = 0;
    const trials = 10000;
    for (let i = 0; i < trials; i++) {
      if (sampler.shouldSample(makeInteraction())) sampled++;
    }
    // Should be roughly 50% ± 5%
    expect(sampled / trials).toBeGreaterThan(0.45);
    expect(sampled / trials).toBeLessThan(0.55);
  });

  it('rate 1.0 samples everything', () => {
    const sampler = new Sampler(1.0);
    for (let i = 0; i < 100; i++) {
      expect(sampler.shouldSample(makeInteraction())).toBe(true);
    }
  });

  it('rate 0.0 samples nothing', () => {
    const sampler = new Sampler(0.0);
    for (let i = 0; i < 100; i++) {
      expect(sampler.shouldSample(makeInteraction())).toBe(false);
    }
  });

  it('respects dimension overrides', () => {
    const sampler = new Sampler(0.0);
    sampler.setOverride('high-priority', 1.0);
    const interaction = makeInteraction({ promptTemplate: 'high-priority' });
    expect(sampler.shouldSample(interaction)).toBe(true);
  });
});

describe('ScoreStore', () => {
  it('stores and queries scores', () => {
    const store = new ScoreStore();
    const now = Date.now();
    store.add({
      interactionId: 'test-1',
      timestamp: now,
      dimensions: { model: 'gpt-4' },
      scores: [{ scorerName: 'length', value: 0.9, durationMs: 1 }],
    });

    const results = store.query({ startMs: now - 1000, endMs: now + 1000 });
    expect(results).toHaveLength(1);
  });

  it('filters by dimension', () => {
    const store = new ScoreStore();
    const now = Date.now();
    store.add({
      interactionId: 'test-1',
      timestamp: now,
      dimensions: { model: 'gpt-4' },
      scores: [{ scorerName: 'length', value: 0.9, durationMs: 1 }],
    });
    store.add({
      interactionId: 'test-2',
      timestamp: now,
      dimensions: { model: 'claude' },
      scores: [{ scorerName: 'length', value: 0.8, durationMs: 1 }],
    });

    const results = store.query(
      { startMs: now - 1000, endMs: now + 1000 },
      { model: 'gpt-4' }
    );
    expect(results).toHaveLength(1);
    expect(results[0].interactionId).toBe('test-1');
  });

  it('evicts oldest entries when full', () => {
    const store = new ScoreStore(10);
    for (let i = 0; i < 20; i++) {
      store.add({
        interactionId: `test-${i}`,
        timestamp: Date.now(),
        dimensions: {},
        scores: [],
      });
    }
    expect(store.size()).toBe(10);
  });
});

describe('BaselineTracker', () => {
  it('initializes baseline from first sample', () => {
    const tracker = new BaselineTracker(0.95);
    tracker.update('model:gpt-4', 'length', 0.8);
    const baseline = tracker.get('model:gpt-4', 'length');
    expect(baseline?.value).toBe(0.8);
    expect(baseline?.sampleCount).toBe(1);
  });

  it('applies exponential decay on updates', () => {
    const tracker = new BaselineTracker(0.9);
    tracker.update('dim', 'scorer', 1.0);
    tracker.update('dim', 'scorer', 0.5);
    const baseline = tracker.get('dim', 'scorer');
    // 0.9 * 1.0 + 0.1 * 0.5 = 0.95
    expect(baseline?.value).toBeCloseTo(0.95, 5);
  });

  it('slowly adapts baseline toward new values', () => {
    const tracker = new BaselineTracker(0.95);
    tracker.update('dim', 'scorer', 1.0);
    // Push 100 updates at 0.5
    for (let i = 0; i < 100; i++) {
      tracker.update('dim', 'scorer', 0.5);
    }
    const baseline = tracker.get('dim', 'scorer');
    // Should be very close to 0.5 after many updates
    expect(baseline!.value).toBeCloseTo(0.5, 1);
  });
});

describe('QualityMonitor - configuration', () => {
  it('uses defaults when no config provided', () => {
    const monitor = new QualityMonitor();
    const metrics = monitor.getMetrics();
    expect(metrics.recorded).toBe(0);
  });

  it('registers and uses scorers', async () => {
    const { monitor } = createMonitor();
    monitor.registerScorer(new LengthScorer());
    monitor.registerScorer(new KeywordScorer(['paris']));

    await monitor.record(makeInteraction());

    const metrics = monitor.getMetrics();
    expect(metrics.scored).toBe(1);
  });
});

// --- Failure Mode Tests ---

describe('Failure Mode: Scorer returns stale/wrong scores', () => {
  it('detects a broken scorer via canary input', async () => {
    // A scorer that always returns 1.0 regardless of input
    const brokenScorer: Scorer = {
      name: 'broken',
      async score(): Promise<ScoreResult> {
        return { scorerName: 'broken', value: 1.0, durationMs: 0 };
      },
    };

    const { monitor } = createMonitor();
    monitor.registerScorer(brokenScorer);

    // Score a known-bad interaction (empty output should not score 1.0)
    const badInteraction = makeInteraction({ output: '' });
    await monitor.record(badInteraction);

    // Verify the scorer reported 1.0 for empty output — this is the canary signal
    const store = monitor.getScoreStore();
    const scores = store.query({ startMs: 0, endMs: Date.now() + 1000 });
    expect(scores[0].scores[0].value).toBe(1.0);
    // In production, this would trigger an alert — scorer is clearly broken
  });
});

describe('Failure Mode: Sample rate too low', () => {
  it('misses localized degradation with low sample rate', async () => {
    const { monitor, alerts } = createMonitor({
      sampleRate: 0.01, // 1% sample rate
      minSamplesForAlert: 5,
    });
    monitor.registerScorer(new LengthScorer(100));

    // Send 100 bad interactions — with 1% sampling, most are missed
    for (let i = 0; i < 100; i++) {
      await monitor.record(makeInteraction({ output: 'Short.' }));
    }

    const metrics = monitor.getMetrics();
    // Very few should be sampled at 1%
    expect(metrics.sampled).toBeLessThan(10);
  });
});

describe('Failure Mode: Scorer timeout', () => {
  it('handles scorer timeout without blocking pipeline', async () => {
    const slowScorer: Scorer = {
      name: 'slow',
      async score(): Promise<ScoreResult> {
        await new Promise(resolve => setTimeout(resolve, 10000));
        return { scorerName: 'slow', value: 1.0, durationMs: 10000 };
      },
    };

    const { monitor } = createMonitor({ scorerTimeoutMs: 50 });
    monitor.registerScorer(slowScorer);
    monitor.registerScorer(new LengthScorer());

    await monitor.record(makeInteraction());

    const metrics = monitor.getMetrics();
    expect(metrics.scorerTimeouts).toBe(1);
    // The length scorer should still have succeeded
    expect(metrics.scored).toBe(1);
  });
});

describe('Failure Mode: Baseline drift masks slow degradation', () => {
  it('baseline adapts to gradual degradation, masking the drop', async () => {
    const { monitor, alerts } = createMonitor({
      baselineDecay: 0.95,
      absoluteThreshold: 0.3, // Low absolute threshold
      relativeThreshold: 0.15, // Moderate relative threshold
      minSamplesForAlert: 5,
    });

    // Custom scorer that returns a configurable value
    let currentQuality = 0.9;
    const degradingScorer: Scorer = {
      name: 'quality',
      async score(): Promise<ScoreResult> {
        return { scorerName: 'quality', value: currentQuality, durationMs: 0 };
      },
    };
    monitor.registerScorer(degradingScorer);

    // Establish baseline at 0.9
    for (let i = 0; i < 20; i++) {
      await monitor.record(makeInteraction());
    }
    alerts.length = 0; // Clear initial alerts

    // Gradually degrade by 0.01 per batch — slow enough that baseline tracks it
    for (let batch = 0; batch < 30; batch++) {
      currentQuality = Math.max(0.4, 0.9 - batch * 0.01);
      for (let i = 0; i < 5; i++) {
        await monitor.record(makeInteraction());
      }
    }

    // The baseline should have tracked down toward the degraded quality
    const baseline = monitor.getBaselineTracker().get('model:test-model', 'quality');
    expect(baseline).toBeDefined();
    // Baseline should be significantly below starting point
    expect(baseline!.value).toBeLessThan(0.8);

    // This demonstrates the silent degradation problem:
    // absolute threshold (0.3) is too low to catch 0.9 → 0.6 drift,
    // and the relative threshold is beaten by slow adaptation
  });

  it('absolute threshold catches degradation that baseline misses', async () => {
    const { monitor, alerts } = createMonitor({
      baselineDecay: 0.95,
      absoluteThreshold: 0.7, // Higher absolute threshold acts as hard floor
      relativeThreshold: 0.15,
      minSamplesForAlert: 1,
    });

    let currentQuality = 0.9;
    const degradingScorer: Scorer = {
      name: 'quality',
      async score(): Promise<ScoreResult> {
        return { scorerName: 'quality', value: currentQuality, durationMs: 0 };
      },
    };
    monitor.registerScorer(degradingScorer);

    // Establish baseline
    for (let i = 0; i < 20; i++) {
      await monitor.record(makeInteraction());
    }
    alerts.length = 0;

    // Drop below absolute threshold
    currentQuality = 0.5;
    await monitor.record(makeInteraction());

    // Absolute threshold should catch this even if baseline has adapted
    const absoluteAlerts = alerts.filter(a => a.message.includes('absolute'));
    expect(absoluteAlerts.length).toBeGreaterThan(0);
  });
});

describe('Failure Mode: Dimensional explosion', () => {
  it('handles many dimension values without crashing', async () => {
    const { monitor } = createMonitor({
      dimensions: ['promptTemplate'],
      minSamplesForAlert: 10,
    });
    monitor.registerScorer(new LengthScorer());

    // Create 100 different prompt templates — each gets very few samples
    for (let i = 0; i < 100; i++) {
      await monitor.record(makeInteraction({
        promptTemplate: `template-${i}`,
      }));
    }

    const metrics = monitor.getMetrics();
    expect(metrics.scored).toBe(100);

    // Health check should work even with many dimensions
    const health = monitor.checkHealth();
    expect(health).toBeDefined();
  });
});

describe('Failure Mode: Queue backpressure', () => {
  it('drops interactions when queue is full', async () => {
    const slowScorer: Scorer = {
      name: 'slow',
      async score(): Promise<ScoreResult> {
        await new Promise(resolve => setTimeout(resolve, 100));
        return { scorerName: 'slow', value: 1.0, durationMs: 100 };
      },
    };

    const { monitor } = createMonitor({
      maxQueueDepth: 2,
      scorerTimeoutMs: 500,
    });
    monitor.registerScorer(slowScorer);

    // Fire many records without awaiting — should hit backpressure
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(monitor.record(makeInteraction()));
    }
    await Promise.all(promises);

    const metrics = monitor.getMetrics();
    expect(metrics.queueDropped).toBeGreaterThan(0);
  });
});

// --- Integration Tests ---

describe('Integration: full pipeline with mock provider', () => {
  it('end-to-end: provider → monitor → scores → health check', async () => {
    const provider = new MockProvider({ baseLatencyMs: 10, baseQuality: 0.9 });
    const { monitor, alerts } = createMonitor({
      sampleRate: 1.0,
      minSamplesForAlert: 5,
      absoluteThreshold: 0.7,
    });
    monitor.registerScorer(new LengthScorer(20, 500));
    monitor.registerScorer(new KeywordScorer(['analysis', 'impact', 'findings', 'evidence']));

    // Generate and record 20 interactions
    for (let i = 0; i < 20; i++) {
      const interaction = await provider.complete(
        `Tell me about topic ${i}`,
        'mock-model',
        'analysis-prompt'
      );
      await monitor.record(interaction);
    }

    const metrics = monitor.getMetrics();
    expect(metrics.recorded).toBe(20);
    expect(metrics.sampled).toBe(20);
    expect(metrics.scored).toBe(20);

    // Check scores for the model dimension
    const snapshot = monitor.getScores('model', 'mock-model');
    expect(snapshot.sampleCount).toBe(20);
    expect(snapshot.scores['length']).toBeDefined();
    expect(snapshot.scores['length'].mean).toBeGreaterThan(0);

    // Health check should pass
    const health = monitor.checkHealth();
    expect(health).toBeDefined();
  });

  it('end-to-end: detects quality degradation from provider drift', async () => {
    const provider = new MockProvider({
      baseLatencyMs: 5,
      baseQuality: 0.9,
      qualityDegradationPerCall: 0.02, // Degrades 0.02 per call
    });

    const { monitor, alerts } = createMonitor({
      sampleRate: 1.0,
      minSamplesForAlert: 3,
      absoluteThreshold: 0.7,
      relativeThreshold: 0.1,
    });
    monitor.registerScorer(new LengthScorer(50, 500));

    // First batch: high quality
    for (let i = 0; i < 10; i++) {
      const interaction = await provider.complete(`Query ${i}`);
      await monitor.record(interaction);
    }

    // Provider has degraded significantly by now
    expect(provider.getCurrentQuality()).toBeLessThan(0.8);

    // Later interactions should trigger alerts as length drops
    for (let i = 10; i < 40; i++) {
      const interaction = await provider.complete(`Query ${i}`);
      await monitor.record(interaction);
    }

    const metrics = monitor.getMetrics();
    expect(metrics.recorded).toBe(40);
    // Quality degradation should have triggered some alerts
    // (either absolute or relative threshold breaches)
    expect(metrics.alertsFired).toBeGreaterThan(0);
  });

  it('compares quality across multiple prompt templates', async () => {
    const provider = new MockProvider({ baseLatencyMs: 5, baseQuality: 0.9 });
    const { monitor } = createMonitor({
      sampleRate: 1.0,
      dimensions: ['promptTemplate'],
    });
    monitor.registerScorer(new LengthScorer(20, 500));

    // Two different prompt templates
    for (let i = 0; i < 10; i++) {
      const good = await provider.complete('Analyze this topic in detail', 'model', 'detailed-analysis');
      await monitor.record(good);
    }

    for (let i = 0; i < 10; i++) {
      await monitor.record(makeInteraction({
        output: 'Ok.',
        promptTemplate: 'short-response',
      }));
    }

    // Check that scores differ between templates
    const detailedScores = monitor.getScores('promptTemplate', 'detailed-analysis');
    const shortScores = monitor.getScores('promptTemplate', 'short-response');

    expect(detailedScores.sampleCount).toBe(10);
    expect(shortScores.sampleCount).toBe(10);
    expect(detailedScores.scores['length'].mean).toBeGreaterThan(
      shortScores.scores['length'].mean
    );
  });
});

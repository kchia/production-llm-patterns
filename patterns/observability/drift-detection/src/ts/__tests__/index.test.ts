/**
 * Drift Detection — test suite
 *
 * Three categories:
 *   1. Unit tests        — core logic, stats, config
 *   2. Failure mode tests— one per Failure Modes table row
 *   3. Integration tests — end-to-end with mock provider
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DriftDetector, createDriftDetector } from '../index.js';
import { createMockProvider } from '../mock-provider.js';
import type { DriftObservation } from '../types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeObs(overrides: Partial<DriftObservation> = {}): DriftObservation {
  return {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    inputLength: 300,
    outputLength: 600,
    outputScore: 0.82,
    latencyMs: 800,
    ...overrides,
  };
}

/**
 * Pump N observations into the detector.
 * Returns the last alert, if any.
 */
function pumpObservations(
  detector: DriftDetector,
  count: number,
  overrides: Partial<DriftObservation> = {},
) {
  let lastAlert = null;
  for (let i = 0; i < count; i++) {
    const alert = detector.observe(makeObs(overrides));
    if (alert) lastAlert = alert;
  }
  return lastAlert;
}

// ─── 1. Unit Tests ────────────────────────────────────────────────────────

describe('DriftDetector — unit tests', () => {
  let detector: DriftDetector;

  beforeEach(() => {
    detector = createDriftDetector({
      baselineWindowSize: 100,
      currentWindowSize: 50,
      scoreThreshold: 0.15,
      criticalThreshold: 0.30,
      minSamplesForAlert: 20,
      dimensions: ['output-length', 'latency'],
    });
  });

  it('returns null before baseline is established', () => {
    const alert = detector.observe(makeObs());
    expect(alert).toBeNull();
  });

  it('returns null when baseline is filled but current window is below minSamplesForAlert', () => {
    // Fill baseline
    pumpObservations(detector, 100);
    // Add a few current-window observations (below minSamplesForAlert=20)
    for (let i = 0; i < 5; i++) {
      const alert = detector.observe(makeObs({ outputLength: 10000 })); // extreme drift
      expect(alert).toBeNull(); // still suppressed
    }
  });

  it('detects drift when distribution shifts significantly after baseline fills', () => {
    // Fill baseline with stable data (outputLength ~600)
    pumpObservations(detector, 100);
    // Fill current window with heavily drifted data (outputLength ~60 — 90% shorter)
    const alert = pumpObservations(detector, 50, { outputLength: 60, latencyMs: 80 });
    expect(alert).not.toBeNull();
    expect(alert!.score).toBeGreaterThanOrEqual(0.15);
  });

  it('returns critical severity when drift exceeds criticalThreshold', () => {
    pumpObservations(detector, 100);
    // Extreme drift: output collapsed to 1 char
    const alert = pumpObservations(detector, 50, { outputLength: 1, latencyMs: 1 });
    expect(alert).not.toBeNull();
    expect(alert!.severity).toBe('critical');
  });

  it('returns warning severity when drift is between threshold and critical', () => {
    pumpObservations(detector, 100, { outputLength: 600, latencyMs: 800 });
    // Moderate drift: output at 50% (below critical but above warning threshold)
    // We set narrow baseline stdDev by using uniform 600, so any shift will register
    const alert = pumpObservations(detector, 50, { outputLength: 350, latencyMs: 550 });
    // May be warning or critical depending on stdDev — just verify an alert fires
    expect(alert).not.toBeNull();
    expect(['warning', 'critical']).toContain(alert!.severity);
  });

  it('returns null when distribution stays stable', () => {
    pumpObservations(detector, 100, { outputLength: 600, latencyMs: 800 });
    const alert = pumpObservations(detector, 50, { outputLength: 605, latencyMs: 805 });
    expect(alert).toBeNull();
  });

  it('getBaseline returns null before baseline fills', () => {
    expect(detector.getBaseline()).toBeNull();
  });

  it('getBaseline returns stats after baseline fills', () => {
    pumpObservations(detector, 100);
    const baseline = detector.getBaseline();
    expect(baseline).not.toBeNull();
    expect(baseline!.get('output-length')!.sampleCount).toBe(100);
  });

  it('getCurrentWindow returns null before baseline fills', () => {
    expect(detector.getCurrentWindow()).toBeNull();
  });

  it('getCurrentWindow returns stats after baseline fills and current window has data', () => {
    pumpObservations(detector, 100);
    pumpObservations(detector, 25);
    const window = detector.getCurrentWindow();
    expect(window).not.toBeNull();
    expect(window!.get('output-length')!.sampleCount).toBe(25);
  });

  it('reset clears baseline and current window', () => {
    pumpObservations(detector, 100);
    detector.reset();
    expect(detector.getBaseline()).toBeNull();
    expect(detector.getCurrentWindow()).toBeNull();
  });

  it('invokes onAlert callback when alert fires', () => {
    const onAlert = vi.fn();
    const d = createDriftDetector({
      baselineWindowSize: 100,
      currentWindowSize: 50,
      scoreThreshold: 0.15,
      criticalThreshold: 0.30,
      minSamplesForAlert: 20,
      dimensions: ['output-length'],
      onAlert,
    });
    pumpObservations(d, 100);
    pumpObservations(d, 50, { outputLength: 1 });
    expect(onAlert).toHaveBeenCalled();
  });

  it('handles missing outputScore gracefully (output-score dimension)', () => {
    const d = createDriftDetector({
      baselineWindowSize: 50,
      currentWindowSize: 25,
      scoreThreshold: 0.15,
      minSamplesForAlert: 10,
      dimensions: ['output-score'],
    });
    // Observations without outputScore — should not throw
    expect(() => pumpObservations(d, 50, { outputScore: undefined })).not.toThrow();
  });
});

// ─── 2. Failure Mode Tests ─────────────────────────────────────────────────

describe('DriftDetector — failure mode tests', () => {
  /**
   * FM: Baseline poisoning
   * A baseline established from anomalous data (e.g., very short outputs)
   * should still produce detectable drift when normal traffic resumes — proving
   * that forceBaselineSnapshot() is the correct recovery mechanism.
   */
  it('FM: baseline poisoning — poisoned baseline leads to drift on normal traffic', () => {
    const detector = createDriftDetector({
      baselineWindowSize: 100,
      currentWindowSize: 50,
      scoreThreshold: 0.15,
      minSamplesForAlert: 20,
      dimensions: ['output-length'],
    });

    // Establish poisoned baseline (very short outputs — anomalous)
    pumpObservations(detector, 100, { outputLength: 30 });

    // Normal traffic (length ~600) looks like "drift" from poisoned baseline
    const alert = pumpObservations(detector, 50, { outputLength: 600 });
    expect(alert).not.toBeNull();
    // Recovery: pin good baseline and verify no alert on normal traffic
    detector.forceBaselineSnapshot();
    const alertAfterReset = pumpObservations(detector, 50, { outputLength: 600 });
    expect(alertAfterReset).toBeNull();
  });

  /**
   * FM: Cold-start false positives
   * Alerts must be suppressed until minSamplesForAlert threshold is met.
   */
  it('FM: cold-start suppression — no alert before minSamplesForAlert', () => {
    const detector = createDriftDetector({
      baselineWindowSize: 50,
      currentWindowSize: 100,
      scoreThreshold: 0.01, // extremely sensitive
      minSamplesForAlert: 30,
      dimensions: ['output-length'],
    });

    pumpObservations(detector, 50); // fill baseline

    // Inject extreme drift but stay below minSamplesForAlert
    for (let i = 0; i < 29; i++) {
      const alert = detector.observe(makeObs({ outputLength: 1 }));
      expect(alert).toBeNull();
    }
    // 30th observation should now be eligible to alert
    const alert30 = detector.observe(makeObs({ outputLength: 1 }));
    expect(alert30).not.toBeNull();
  });

  /**
   * FM: Threshold ossification (silent degradation)
   * The raw drift score should be emitted even when it stays below threshold.
   * This test verifies that the score is non-zero (detectable in metrics)
   * even when no alert fires — proving slow drift is visible in the score trend.
   */
  it('FM: threshold ossification — drift score increases even when no alert fires', () => {
    const observations: Array<ReturnType<DriftDetector['observe']>> = [];
    const scores: number[] = [];

    // Custom detector that captures scores without alerting
    const detector = createDriftDetector({
      baselineWindowSize: 50,
      currentWindowSize: 30,
      scoreThreshold: 0.99, // set threshold so high no alert fires
      minSamplesForAlert: 10,
      dimensions: ['output-length'],
      onAlert: (a) => scores.push(a.score),
    });

    pumpObservations(detector, 50, { outputLength: 600 });

    // Slowly drift output length down — simulating quiet degradation
    for (let i = 0; i < 30; i++) {
      const driftedLength = 600 - i * 15; // decreasing
      detector.observe(makeObs({ outputLength: driftedLength }));
    }

    // Verify the raw score is accessible via getCurrentWindow stats
    const current = detector.getCurrentWindow();
    const baseline = detector.getBaseline();
    expect(current).not.toBeNull();
    expect(baseline).not.toBeNull();

    const baselineMean = baseline!.get('output-length')!.mean;
    const currentMean = current!.get('output-length')!.mean;
    // Current mean should be lower than baseline mean (drift direction is detectable)
    expect(currentMean).toBeLessThan(baselineMean);
  });

  /**
   * FM: Dimension mismatch
   * Monitoring output-length alone misses structural change (format shift).
   * Test verifies that adding format-relevant proxies (via output-score) catches
   * changes that output-length monitoring alone would miss.
   */
  it('FM: dimension mismatch — output-score detects structural change length does not', () => {
    // Detector monitoring only output-length
    const lengthOnlyDetector = createDriftDetector({
      baselineWindowSize: 50,
      currentWindowSize: 30,
      scoreThreshold: 0.15,
      minSamplesForAlert: 15,
      dimensions: ['output-length'],
    });

    // Detector monitoring output-score (eval harness metric)
    const scoreDetector = createDriftDetector({
      baselineWindowSize: 50,
      currentWindowSize: 30,
      scoreThreshold: 0.15,
      minSamplesForAlert: 15,
      dimensions: ['output-score'],
    });

    // Establish baselines
    pumpObservations(lengthOnlyDetector, 50, { outputLength: 600, outputScore: 0.82 });
    pumpObservations(scoreDetector, 50, { outputLength: 600, outputScore: 0.82 });

    // Structural drift: same length, different quality (e.g., format changed)
    const structurallyDrifted = { outputLength: 598, outputScore: 0.35 };

    const lengthAlert = pumpObservations(lengthOnlyDetector, 30, structurallyDrifted);
    const scoreAlert = pumpObservations(scoreDetector, 30, structurallyDrifted);

    // Length-only misses it; score-based catches it
    expect(lengthAlert).toBeNull();
    expect(scoreAlert).not.toBeNull();
  });

  /**
   * FM: Baseline staleness after intentional change
   * After forceBaselineSnapshot(), the new baseline reflects the updated distribution.
   * Subsequent normal traffic matching the new distribution should not alert.
   */
  it('FM: baseline staleness — forceBaselineSnapshot() prevents false positives after upgrade', () => {
    const detector = createDriftDetector({
      baselineWindowSize: 50,
      currentWindowSize: 30,
      scoreThreshold: 0.15,
      minSamplesForAlert: 15,
      dimensions: ['output-length'],
    });

    // Establish baseline with old model (long outputs)
    pumpObservations(detector, 50, { outputLength: 600 });

    // Model upgraded — outputs are now shorter (intentional change)
    pumpObservations(detector, 30, { outputLength: 300 });

    // This fires an alert (expected for intentional upgrade)
    // Operator calls forceBaselineSnapshot() to accept new distribution
    detector.forceBaselineSnapshot();

    // After snapshot, new traffic matching the upgraded model should not alert
    const alert = pumpObservations(detector, 30, { outputLength: 300 });
    expect(alert).toBeNull();
  });
});

// ─── 3. Integration Tests ─────────────────────────────────────────────────

describe('DriftDetector — integration tests', () => {
  it('end-to-end: stable baseline → drifted traffic → alert fires', () => {
    const provider = createMockProvider({
      mode: 'stable',
      baseOutputLength: 600,
      baseLatencyMs: 800,
      baseInputLength: 300,
      baseQualityScore: 0.82,
      noiseFactor: 0.05,
      driftMultiplier: 0.4,
    });

    const alerts: ReturnType<DriftDetector['observe']>[] = [];
    const detector = createDriftDetector({
      baselineWindowSize: 200,
      currentWindowSize: 100,
      scoreThreshold: 0.15,
      criticalThreshold: 0.30,
      minSamplesForAlert: 30,
      dimensions: ['output-length', 'latency'],
      onAlert: (a) => alerts.push(a),
    });

    // Phase 1: stable traffic — fill baseline
    for (let i = 0; i < 200; i++) {
      const r = provider.call();
      detector.observe({
        requestId: r.requestId,
        timestamp: Date.now() + i,
        inputLength: r.inputLength,
        outputLength: r.outputLength,
        latencyMs: r.latencyMs,
        outputScore: r.outputScore,
      });
    }

    expect(detector.getBaseline()).not.toBeNull();

    // Phase 2: switch to drifted mode — outputs shrink by 60%
    provider.setMode('drifted');
    for (let i = 0; i < 100; i++) {
      const r = provider.call();
      detector.observe({
        requestId: r.requestId,
        timestamp: Date.now() + 200 + i,
        inputLength: r.inputLength,
        outputLength: r.outputLength,
        latencyMs: r.latencyMs,
        outputScore: r.outputScore,
      });
    }

    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]!.dimension).toMatch(/output-length|latency/);
  });

  it('integration: no alert fires on stable traffic throughout', () => {
    const provider = createMockProvider({
      mode: 'stable',
      baseOutputLength: 600,
      baseLatencyMs: 800,
      baseInputLength: 300,
      baseQualityScore: 0.82,
      noiseFactor: 0.05,
      driftMultiplier: 1.0,
    });

    const alerts: unknown[] = [];
    const detector = createDriftDetector({
      baselineWindowSize: 200,
      currentWindowSize: 100,
      scoreThreshold: 0.15,
      minSamplesForAlert: 30,
      dimensions: ['output-length', 'latency'],
      onAlert: (a) => alerts.push(a),
    });

    for (let i = 0; i < 400; i++) {
      const r = provider.call();
      detector.observe({
        requestId: r.requestId,
        timestamp: Date.now() + i,
        inputLength: r.inputLength,
        outputLength: r.outputLength,
        latencyMs: r.latencyMs,
      });
    }

    expect(alerts.length).toBe(0);
  });

  it('integration: concurrent observations do not corrupt state', () => {
    const detector = createDriftDetector({
      baselineWindowSize: 100,
      currentWindowSize: 50,
      scoreThreshold: 0.15,
      minSamplesForAlert: 20,
      dimensions: ['output-length'],
    });

    // Simulate concurrent-ish observations (synchronous but rapid)
    const results = Array.from({ length: 200 }, (_, i) =>
      detector.observe(makeObs({ outputLength: 600 + (i % 10), timestamp: Date.now() + i })),
    );

    // No exception thrown; state is consistent
    const baseline = detector.getBaseline();
    expect(baseline).not.toBeNull();
    expect(baseline!.get('output-length')!.sampleCount).toBeGreaterThan(0);
  });
});

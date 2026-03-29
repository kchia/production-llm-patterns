"""
Drift Detection — Python test suite

Three categories:
  1. Unit tests        — core logic, stats, config
  2. Failure mode tests— one per Failure Modes table row
  3. Integration tests — end-to-end with mock provider
"""

from __future__ import annotations

import time
from unittest.mock import MagicMock

import pytest

from .. import DriftDetector, DriftObservation
from ..mock_provider import MockProvider, MockProviderConfig
from ..types import DriftAlert, DriftDetectorConfig


# ─── Helpers ──────────────────────────────────────────────────────────────

def make_obs(**overrides) -> DriftObservation:
    defaults = dict(
        request_id="req",
        timestamp=time.time(),
        input_length=300,
        output_length=600,
        latency_ms=800.0,
        output_score=0.82,
    )
    defaults.update(overrides)
    return DriftObservation(**defaults)


def pump(detector: DriftDetector, count: int, **overrides) -> DriftAlert | None:
    last_alert = None
    for _ in range(count):
        alert = detector.observe(make_obs(**overrides))
        if alert:
            last_alert = alert
    return last_alert


def make_detector(**cfg_overrides) -> DriftDetector:
    defaults = dict(
        baseline_window_size=100,
        current_window_size=50,
        score_threshold=0.15,
        critical_threshold=0.30,
        min_samples_for_alert=20,
        dimensions=["output-length", "latency"],
    )
    defaults.update(cfg_overrides)
    return DriftDetector(DriftDetectorConfig(**defaults))


# ─── 1. Unit Tests ────────────────────────────────────────────────────────

class TestDriftDetectorUnit:

    def test_returns_none_before_baseline_fills(self):
        d = make_detector()
        assert d.observe(make_obs()) is None

    def test_returns_none_below_min_samples_after_baseline(self):
        d = make_detector()
        pump(d, 100)  # fill baseline
        # Add only 5 current-window observations (below min_samples_for_alert=20)
        for _ in range(5):
            alert = d.observe(make_obs(output_length=1, latency_ms=1.0))
            assert alert is None

    def test_detects_drift_after_baseline_fills(self):
        d = make_detector()
        pump(d, 100)
        alert = pump(d, 50, output_length=10, latency_ms=10.0)  # extreme drift
        assert alert is not None
        assert alert.score >= 0.15

    def test_critical_severity_on_extreme_drift(self):
        d = make_detector()
        pump(d, 100)
        alert = pump(d, 50, output_length=1, latency_ms=1.0)
        assert alert is not None
        assert alert.severity == "critical"

    def test_no_alert_on_stable_traffic(self):
        d = make_detector()
        pump(d, 100, output_length=600, latency_ms=800.0)
        alert = pump(d, 50, output_length=605, latency_ms=802.0)
        assert alert is None

    def test_get_baseline_returns_none_before_fill(self):
        d = make_detector()
        assert d.get_baseline() is None

    def test_get_baseline_returns_stats_after_fill(self):
        d = make_detector()
        pump(d, 100)
        baseline = d.get_baseline()
        assert baseline is not None
        assert baseline["output-length"].sample_count == 100

    def test_get_current_window_returns_none_before_fill(self):
        d = make_detector()
        assert d.get_current_window() is None

    def test_get_current_window_after_fill(self):
        d = make_detector()
        pump(d, 100)
        pump(d, 25)
        window = d.get_current_window()
        assert window is not None
        assert window["output-length"].sample_count == 25

    def test_reset_clears_state(self):
        d = make_detector()
        pump(d, 100)
        d.reset()
        assert d.get_baseline() is None
        assert d.get_current_window() is None

    def test_on_alert_callback_invoked(self):
        callback = MagicMock()
        d = make_detector(on_alert=callback)
        pump(d, 100)
        pump(d, 50, output_length=1, latency_ms=1.0)
        assert callback.called

    def test_missing_output_score_does_not_raise(self):
        d = make_detector(dimensions=["output-score"])
        # Observations without output_score should not throw
        for _ in range(150):
            d.observe(make_obs(output_score=None))


# ─── 2. Failure Mode Tests ─────────────────────────────────────────────────

class TestFailureModes:

    def test_fm_baseline_poisoning_then_snapshot_fixes_it(self):
        """FM: Baseline poisoning — force_baseline_snapshot() recovers."""
        d = make_detector()
        # Establish poisoned baseline (very short outputs)
        pump(d, 100, output_length=10, latency_ms=10.0)
        # Normal traffic looks like drift vs. poisoned baseline
        alert = pump(d, 50, output_length=600, latency_ms=800.0)
        assert alert is not None
        # Recovery: pin good baseline
        d.force_baseline_snapshot()
        alert_after = pump(d, 50, output_length=600, latency_ms=800.0)
        assert alert_after is None

    def test_fm_cold_start_suppression(self):
        """FM: No alert fires before min_samples_for_alert."""
        d = make_detector(score_threshold=0.01, min_samples_for_alert=30)
        pump(d, 100)  # fill baseline
        # Inject extreme drift but stay under min_samples_for_alert
        for i in range(29):
            alert = d.observe(make_obs(output_length=1, latency_ms=1.0))
            assert alert is None, f"Alert fired at sample {i + 1}, expected suppression"
        # 30th observation should be eligible
        alert_30 = d.observe(make_obs(output_length=1, latency_ms=1.0))
        assert alert_30 is not None

    def test_fm_threshold_ossification_score_still_measurable(self):
        """FM: Even when threshold is very high, drift score is non-zero and trending."""
        d = make_detector(score_threshold=0.999, min_samples_for_alert=10)
        pump(d, 100, output_length=600, latency_ms=800.0)
        # Slowly drift output down
        for i in range(50):
            d.observe(make_obs(output_length=600 - i * 10, latency_ms=800.0))
        current = d.get_current_window()
        baseline = d.get_baseline()
        assert current is not None and baseline is not None
        # Current mean should be lower than baseline (drift is detectable via stats)
        assert current["output-length"].mean < baseline["output-length"].mean

    def test_fm_dimension_mismatch_output_score_catches_structural_change(self):
        """FM: Length-only monitoring misses structural drift; score-based catches it."""
        length_only = make_detector(dimensions=["output-length"])
        score_only = make_detector(dimensions=["output-score"])

        pump(length_only, 100, output_length=600, output_score=0.82)
        pump(score_only, 100, output_length=600, output_score=0.82)

        # Structural drift: same length, degraded quality
        kwargs = dict(output_length=598, output_score=0.25)
        length_alert = pump(length_only, 50, **kwargs)
        score_alert = pump(score_only, 50, **kwargs)

        assert length_alert is None
        assert score_alert is not None

    def test_fm_baseline_staleness_force_snapshot_prevents_false_positives(self):
        """FM: After intentional model upgrade, force_baseline_snapshot() silences alerts."""
        d = make_detector()
        pump(d, 100, output_length=600, latency_ms=800.0)
        pump(d, 50, output_length=300, latency_ms=400.0)  # upgrade: shorter outputs
        # Intentional change — snapshot the new distribution
        d.force_baseline_snapshot()
        # Normal traffic matching upgraded model should not alert
        alert = pump(d, 50, output_length=300, latency_ms=400.0)
        assert alert is None


# ─── 3. Integration Tests ─────────────────────────────────────────────────

class TestIntegration:

    def test_stable_then_drifted_fires_alert(self):
        provider = MockProvider(MockProviderConfig(
            mode="stable",
            base_output_length=600,
            base_latency_ms=800,
            base_input_length=300,
            base_quality_score=0.82,
            noise_factor=0.05,
            drift_multiplier=0.4,
        ))

        alerts: list[DriftAlert] = []
        d = DriftDetector(DriftDetectorConfig(
            baseline_window_size=200,
            current_window_size=100,
            score_threshold=0.15,
            critical_threshold=0.30,
            min_samples_for_alert=30,
            dimensions=["output-length", "latency"],
            on_alert=alerts.append,
        ))

        # Phase 1: fill baseline with stable traffic
        for i in range(200):
            r = provider.call()
            d.observe(DriftObservation(
                request_id=r.request_id,
                timestamp=time.time() + i * 0.001,
                input_length=r.input_length,
                output_length=r.output_length,
                latency_ms=r.latency_ms,
                output_score=r.output_score,
            ))

        assert d.get_baseline() is not None

        # Phase 2: switch to drifted mode
        provider.set_mode("drifted")
        for i in range(100):
            r = provider.call()
            d.observe(DriftObservation(
                request_id=r.request_id,
                timestamp=time.time() + 200 * 0.001 + i * 0.001,
                input_length=r.input_length,
                output_length=r.output_length,
                latency_ms=r.latency_ms,
            ))

        assert len(alerts) > 0

    def test_no_alert_on_stable_traffic_throughout(self):
        provider = MockProvider(MockProviderConfig(
            mode="stable",
            noise_factor=0.05,
        ))

        alerts: list[DriftAlert] = []
        d = DriftDetector(DriftDetectorConfig(
            baseline_window_size=200,
            current_window_size=100,
            score_threshold=0.15,
            min_samples_for_alert=30,
            dimensions=["output-length", "latency"],
            on_alert=alerts.append,
        ))

        for i in range(400):
            r = provider.call()
            d.observe(DriftObservation(
                request_id=r.request_id,
                timestamp=time.time() + i * 0.001,
                input_length=r.input_length,
                output_length=r.output_length,
                latency_ms=r.latency_ms,
            ))

        assert len(alerts) == 0

    def test_many_rapid_observations_do_not_corrupt_state(self):
        d = make_detector()
        for i in range(200):
            d.observe(make_obs(output_length=600 + (i % 10), timestamp=time.time() + i * 0.0001))
        baseline = d.get_baseline()
        assert baseline is not None
        assert baseline["output-length"].sample_count > 0

"""
Drift Detection
===============

Detects statistical drift in LLM input/output distributions over time.
Compares a rolling current window against a pinned baseline snapshot
using a simplified Wasserstein-1 approximation (mean-shift normalized
by baseline standard deviation).

Core abstraction: DriftDetector
  .observe(observation) → DriftAlert | None
  .force_baseline_snapshot() → None
  .get_baseline() → dict[DriftDimension, DistributionStats] | None
  .get_current_window() → dict[DriftDimension, DistributionStats] | None
  .get_baseline_age_s() → float | None
  .reset() → None

Usage::

    from drift_detection import DriftDetector, DriftDetectorConfig, DriftObservation
    import time

    detector = DriftDetector(DriftDetectorConfig(
        baseline_window_size=1000,
        current_window_size=500,
        score_threshold=0.15,
        dimensions=["input-length", "output-length", "latency"],
    ))

    obs = DriftObservation(
        request_id="req-1",
        timestamp=time.time(),
        input_length=300,
        output_length=600,
        latency_ms=820.0,
    )
    alert = detector.observe(obs)
    if alert:
        print(f"Drift detected: {alert.dimension} score={alert.score:.3f}")
"""

from __future__ import annotations

import math
import time
from collections import deque
from typing import Deque

from .types import (
    DriftAlert,
    DriftDetectorConfig,
    DriftDimension,
    DriftObservation,
    DriftSeverity,
    DistributionStats,
)

__all__ = [
    "DriftDetector",
    "DriftDetectorConfig",
    "DriftObservation",
    "DriftAlert",
    "DistributionStats",
    "DriftDimension",
]

# ─── Internal helpers ──────────────────────────────────────────────────────


def _extract_value(obs: DriftObservation, dim: DriftDimension) -> float | None:
    if dim == "input-length":
        return float(obs.input_length)
    if dim == "output-length":
        return float(obs.output_length)
    if dim == "output-score":
        return obs.output_score
    if dim == "latency":
        return obs.latency_ms
    return None


def _compute_stats(values: list[float]) -> DistributionStats:
    if not values:
        return DistributionStats(mean=0, std_dev=0, p50=0, p95=0, min=0, max=0, sample_count=0)

    n = len(values)
    sorted_vals = sorted(values)
    mean = sum(sorted_vals) / n
    variance = sum((v - mean) ** 2 for v in sorted_vals) / n
    std_dev = math.sqrt(variance)

    def pct(p: float) -> float:
        idx = p / 100.0 * (n - 1)
        lo = int(idx)
        hi = math.ceil(idx)
        if lo == hi:
            return sorted_vals[lo]
        return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (idx - lo)

    return DistributionStats(
        mean=mean,
        std_dev=std_dev,
        p50=pct(50),
        p95=pct(95),
        min=sorted_vals[0],
        max=sorted_vals[-1],
        sample_count=n,
    )


def _drift_score(baseline: DistributionStats, current: DistributionStats) -> float:
    """
    Simplified Wasserstein-1 proxy: mean-shift normalized by baseline std_dev.

    Returns 0 if baseline std_dev is 0 (constant baseline — no drift detectable).
    Capped at 1.0.
    """
    if baseline.std_dev == 0:
        return 0.0
    mean_shift = abs(current.mean - baseline.mean)
    return min(mean_shift / (baseline.std_dev * 3), 1.0)


# ─── DriftDetector ─────────────────────────────────────────────────────────


class DriftDetector:
    """
    Detects statistical drift by comparing a rolling current window
    against a pinned baseline snapshot.

    Thread-safety: not thread-safe. Wrap in a lock if sharing across threads.
    """

    def __init__(self, config: DriftDetectorConfig | None = None) -> None:
        self._cfg = config or DriftDetectorConfig()

        # Use deque for O(1) append/popleft; maxlen enforces window size
        self._baseline_bufs: dict[DriftDimension, deque[float]] = {
            dim: deque() for dim in self._cfg.dimensions
        }
        self._current_bufs: dict[DriftDimension, deque[float]] = {
            dim: deque(maxlen=self._cfg.current_window_size)
            for dim in self._cfg.dimensions
        }
        self._baseline_stats: dict[DriftDimension, DistributionStats] = {}
        self._baseline_locked = False
        self._baseline_timestamp: float | None = None
        self._window_start: float = 0.0
        self._window_end: float = 0.0

    def observe(self, obs: DriftObservation) -> DriftAlert | None:
        """
        Ingest one observation.

        Returns a DriftAlert if any monitored dimension exceeds the score
        threshold and the current window has enough samples, else None.
        """
        if self._window_start == 0.0:
            self._window_start = obs.timestamp
        self._window_end = obs.timestamp

        for dim in self._cfg.dimensions:
            value = _extract_value(obs, dim)
            if value is None or math.isnan(value):
                continue

            if not self._baseline_locked:
                self._baseline_bufs[dim].append(value)
                # Lock once any dimension has filled its quota — mirrors TS behavior
                if len(self._baseline_bufs[dim]) >= self._cfg.baseline_window_size:
                    self._lock_baseline()
                continue

            self._current_bufs[dim].append(value)

        if not self._baseline_locked:
            return None

        # Check min samples
        min_current = min(
            len(self._current_bufs[d]) for d in self._cfg.dimensions
        )
        if min_current < self._cfg.min_samples_for_alert:
            return None

        return self._check_for_alert(obs)

    def _lock_baseline(self) -> None:
        self._baseline_locked = True
        self._baseline_timestamp = time.time()
        for dim in self._cfg.dimensions:
            self._baseline_stats[dim] = _compute_stats(list(self._baseline_bufs[dim]))

    def _check_for_alert(self, obs: DriftObservation) -> DriftAlert | None:
        for dim in self._cfg.dimensions:
            baseline = self._baseline_stats.get(dim)
            if baseline is None or baseline.sample_count == 0:
                continue

            current_values = list(self._current_bufs[dim])
            if not current_values:
                continue

            current = _compute_stats(current_values)
            score = _drift_score(baseline, current)

            if score >= self._cfg.score_threshold:
                severity: DriftSeverity = (
                    "critical" if score >= self._cfg.critical_threshold else "warning"
                )
                alert = DriftAlert(
                    dimension=dim,
                    score=score,
                    severity=severity,
                    window_start=self._window_start,
                    window_end=obs.timestamp,
                    baseline_stats=baseline,
                    current_stats=current,
                )
                if self._cfg.on_alert:
                    self._cfg.on_alert(alert)
                return alert

        return None

    def force_baseline_snapshot(self) -> None:
        """
        Pin the current window as the new baseline.

        Call after intentional changes (model upgrade, prompt update)
        to prevent stale-baseline false positives.
        """
        for dim in self._cfg.dimensions:
            current_values = list(self._current_bufs[dim])
            if not current_values:
                continue
            new_buf: deque[float] = deque(current_values, maxlen=self._cfg.baseline_window_size)
            self._baseline_bufs[dim] = new_buf
            self._baseline_stats[dim] = _compute_stats(current_values)

        self._baseline_timestamp = time.time()
        self._baseline_locked = True

        # Reset current window for fresh comparison
        self._current_bufs = {
            dim: deque(maxlen=self._cfg.current_window_size)
            for dim in self._cfg.dimensions
        }
        self._window_start = 0.0
        self._window_end = 0.0

    def get_baseline(self) -> dict[DriftDimension, DistributionStats] | None:
        if not self._baseline_locked:
            return None
        return dict(self._baseline_stats)

    def get_current_window(self) -> dict[DriftDimension, DistributionStats] | None:
        if not self._baseline_locked:
            return None
        return {
            dim: _compute_stats(list(self._current_bufs[dim]))
            for dim in self._cfg.dimensions
        }

    def get_baseline_age_s(self) -> float | None:
        """Age of the current baseline in seconds."""
        if self._baseline_timestamp is None:
            return None
        return time.time() - self._baseline_timestamp

    def reset(self) -> None:
        """Reset to factory state — clears baseline and current window."""
        self._baseline_locked = False
        self._baseline_timestamp = None
        self._window_start = 0.0
        self._window_end = 0.0
        self._baseline_stats.clear()
        self._baseline_bufs = {dim: deque() for dim in self._cfg.dimensions}
        self._current_bufs = {
            dim: deque(maxlen=self._cfg.current_window_size)
            for dim in self._cfg.dimensions
        }

"""
latency-tracker — Core Implementation

Four exports:
  1. Stopwatch              — precise elapsed-time measurement (time.perf_counter())
  2. compute_stats          — percentile computation from a list of samples
  3. LatencyAccumulator     — grouped latency samples by label (per-feature, per-user)
  4. SlidingWindowRecorder  — fixed-size rolling window for per-provider health tracking

Usage pattern:
  sw = Stopwatch()
  response = await provider.complete(request)
  latency_ms = sw.stop()
  accumulator.record(latency_ms, label="provider-a")
  stats = accumulator.stats("provider-a")
  # stats.p99_ms, stats.mean_ms, ...
"""

from __future__ import annotations

import time
from collections import deque
from typing import Optional

from .types import LatencyAccumulatorSnapshot, LatencyRecord, LatencyStats

__all__ = [
    "Stopwatch",
    "compute_stats",
    "LatencyAccumulator",
    "SlidingWindowRecorder",
    "LatencyRecord",
    "LatencyStats",
    "LatencyAccumulatorSnapshot",
]

# ─── Stopwatch ────────────────────────────────────────────────────────────────


class Stopwatch:
    """
    Wraps time.perf_counter() for precise, monotonic elapsed-time measurement.

    time.perf_counter() is preferred over time.time() for latency measurement:
    it uses the OS high-resolution timer and is unaffected by clock adjustments.
    Values are only meaningful relative to each other (not absolute timestamps).
    """

    def __init__(self) -> None:
        self._start: float = time.perf_counter()
        self._end: Optional[float] = None

    @classmethod
    def start(cls) -> "Stopwatch":
        """Convenience factory — equivalent to Stopwatch()."""
        return cls()

    def elapsed(self) -> float:
        """
        Milliseconds elapsed since construction.
        If stop() was called, returns the frozen elapsed value.
        """
        if self._end is not None:
            return (self._end - self._start) * 1000.0
        return (time.perf_counter() - self._start) * 1000.0

    def stop(self) -> float:
        """
        Stop the timer and return elapsed milliseconds.
        Subsequent calls to elapsed() return the same frozen value.
        """
        if self._end is None:
            self._end = time.perf_counter()
        return (self._end - self._start) * 1000.0


# ─── Statistics ───────────────────────────────────────────────────────────────


def compute_stats(samples: list[float]) -> LatencyStats:
    """
    Compute descriptive statistics from a list of latency samples (in ms).

    Uses linear interpolation for percentiles (same method as NumPy's default).
    Returns all-zero stats for an empty list — check count before trusting percentiles.

    Args:
        samples: Raw latency values in milliseconds.
    """
    if not samples:
        return LatencyStats(
            count=0, min_ms=0.0, max_ms=0.0, mean_ms=0.0,
            p50_ms=0.0, p95_ms=0.0, p99_ms=0.0,
        )

    sorted_samples = sorted(samples)
    count = len(sorted_samples)
    total = sum(sorted_samples)

    return LatencyStats(
        count=count,
        min_ms=sorted_samples[0],
        max_ms=sorted_samples[-1],
        mean_ms=total / count,
        p50_ms=_interpolated_percentile(sorted_samples, 0.50),
        p95_ms=_interpolated_percentile(sorted_samples, 0.95),
        p99_ms=_interpolated_percentile(sorted_samples, 0.99),
    )


def _interpolated_percentile(sorted_samples: list[float], p: float) -> float:
    """
    Linear interpolation between the two nearest ranked values.
    Matches NumPy's default 'linear' method.
    """
    n = len(sorted_samples)
    if n == 1:
        return sorted_samples[0]

    idx = p * (n - 1)
    lo = int(idx)
    hi = lo + 1

    if hi >= n:
        return sorted_samples[-1]

    frac = idx - lo
    return sorted_samples[lo] * (1 - frac) + sorted_samples[hi] * frac


# ─── LatencyAccumulator ───────────────────────────────────────────────────────


class LatencyAccumulator:
    """
    Accumulates latency samples grouped by label, computing percentile stats on demand.

    Analogous to SpendAccumulator in cost-tracker — groups records by an arbitrary
    string label (provider name, step name, user ID, feature flag, etc.).

    All samples are retained in memory — suitable for request-lifecycle aggregation
    or short-lived analysis windows. For long-running processes, prefer
    SlidingWindowRecorder or call reset() between reporting intervals.
    """

    def __init__(self) -> None:
        self._samples: dict[str, list[float]] = {}

    def record(self, latency_ms: float, label: Optional[str] = None) -> LatencyRecord:
        """
        Record a latency observation and return it as a LatencyRecord.

        Args:
            latency_ms: Observed latency in milliseconds.
            label:      Optional grouping key. Unlabeled samples go under 'unlabeled'.
        """
        key = label or "unlabeled"
        if key not in self._samples:
            self._samples[key] = []
        self._samples[key].append(latency_ms)

        return LatencyRecord(
            latency_ms=latency_ms,
            timestamp=time.time(),
            label=label,
        )

    def stats(self, label: Optional[str] = None) -> LatencyStats:
        """
        Compute statistics for a specific label.
        Returns all-zero stats if the label has no samples.
        """
        key = label or "unlabeled"
        return compute_stats(self._samples.get(key, []))

    def all_stats(self) -> list[LatencyAccumulatorSnapshot]:
        """Returns per-label stats snapshots for all recorded labels."""
        return [
            LatencyAccumulatorSnapshot(label=label, stats=compute_stats(samples))
            for label, samples in self._samples.items()
        ]

    def total_count(self) -> int:
        """Total number of samples across all labels."""
        return sum(len(s) for s in self._samples.values())

    def reset(self) -> None:
        """Resets all accumulated state. Useful between reporting intervals or test runs."""
        self._samples.clear()


# ─── SlidingWindowRecorder ───────────────────────────────────────────────────


class SlidingWindowRecorder:
    """
    Fixed-size rolling window of recent latency samples.

    The oldest sample is evicted when the window is full. Useful for per-provider
    health tracking where stale data should age out — e.g., "what's my p99 over
    the last N requests?" rather than "what's my p99 since startup?".

    This mirrors the HealthWindow in multi-provider-failover — a canonical
    implementation to import instead of reimplementing in each pattern.
    """

    def __init__(self, max_size: int = 100) -> None:
        """
        Args:
            max_size: Maximum number of samples to retain. Defaults to 100.
        """
        if max_size < 1:
            raise ValueError("max_size must be >= 1")
        # deque with maxlen auto-evicts from the left when full — O(1) both ends
        self._samples: deque[float] = deque(maxlen=max_size)
        self._max_size = max_size

    def record(self, latency_ms: float) -> None:
        """Add a latency sample, evicting the oldest if the window is full."""
        self._samples.append(latency_ms)

    def stats(self) -> LatencyStats:
        """Compute statistics for all samples currently in the window."""
        return compute_stats(list(self._samples))

    @property
    def count(self) -> int:
        """Number of samples currently in the window."""
        return len(self._samples)

    def reset(self) -> None:
        """Clear all samples."""
        self._samples.clear()

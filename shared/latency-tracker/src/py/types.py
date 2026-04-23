"""
latency-tracker — Type Definitions

Shared types for measuring and accumulating LLM request latencies.
Framework-agnostic. No external dependencies.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class LatencyRecord:
    """A single latency observation produced by LatencyAccumulator.record()."""

    latency_ms: float
    """Observed latency in milliseconds."""

    timestamp: float
    """Unix timestamp (seconds) of when this measurement was taken."""

    label: Optional[str] = None
    """Arbitrary attribution label — provider name, step name, feature, etc."""


@dataclass
class LatencyStats:
    """
    Descriptive statistics computed from a set of latency samples.

    All values in milliseconds. count=0 produces all-zero stats — callers
    should check count before trusting min/max/percentiles.
    """

    count: int
    min_ms: float
    max_ms: float
    mean_ms: float
    p50_ms: float
    """Median (50th percentile)."""
    p95_ms: float
    """95th percentile — typical SLA threshold."""
    p99_ms: float
    """99th percentile — tail latency sentinel."""


@dataclass
class LatencyAccumulatorSnapshot:
    """Per-label snapshot returned by LatencyAccumulator.all_stats()."""

    label: str
    stats: LatencyStats

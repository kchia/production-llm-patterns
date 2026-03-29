"""
Drift Detection — type definitions (Python)

Dataclasses for observations, distribution stats, alerts, and config.
Uses Python 3.10+ type hints throughout.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Literal

DriftDimension = Literal["input-length", "output-length", "output-score", "latency"]
DriftSeverity = Literal["warning", "critical"]


@dataclass
class DriftObservation:
    """One observation per LLM request/response cycle."""

    request_id: str
    timestamp: float  # Unix seconds (float for sub-second precision)
    input_length: int  # prompt character length
    output_length: int  # response character length
    latency_ms: float
    output_score: float | None = None  # normalized 0–1, from eval harness
    metadata: dict | None = None


@dataclass
class DistributionStats:
    """Descriptive statistics for a window of scalar observations."""

    mean: float
    std_dev: float
    p50: float
    p95: float
    min: float
    max: float
    sample_count: int


@dataclass
class DriftAlert:
    """Fired when a dimension's drift score exceeds the configured threshold."""

    dimension: DriftDimension
    score: float  # normalized 0–1
    severity: DriftSeverity
    window_start: float  # Unix seconds of oldest sample in current window
    window_end: float  # Unix seconds of newest sample
    baseline_stats: DistributionStats
    current_stats: DistributionStats


@dataclass
class DriftDetectorConfig:
    """
    Configuration for DriftDetector.

    Defaults calibrated for moderate-traffic production systems.
    See README Configurability table for tuning guidance.
    """

    baseline_window_size: int = 1000
    current_window_size: int = 500
    score_threshold: float = 0.15
    critical_threshold: float = 0.30
    min_samples_for_alert: int = 100
    dimensions: list[DriftDimension] = field(
        default_factory=lambda: ["input-length", "output-length", "latency"]
    )
    on_alert: Callable[[DriftAlert], None] | None = None

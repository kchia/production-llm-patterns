"""Type definitions for Online Eval Monitoring."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Optional


@dataclass
class EvalContext:
    input: str
    output: str
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class Trace:
    id: str
    timestamp: float  # Unix epoch seconds (time.time())
    context: EvalContext


@dataclass
class ScoreResult:
    trace_id: str
    scorer_name: str
    score: float  # 0.0 – 1.0
    timestamp: float  # Unix epoch seconds
    duration_ms: float


@dataclass
class TimeWindow:
    start_s: float  # Unix epoch seconds
    end_s: float


AlertLevel = Literal["warning", "critical"]


@dataclass
class AlertEvent:
    level: AlertLevel
    scorer_name: str
    score: float
    rolling_mean: float
    trace_id: str


@dataclass
class OnlineEvalConfig:
    """Configuration for OnlineEvalMonitor. All fields optional; defaults applied in __post_init__."""

    queue_size: int = 1000
    """Max pending eval jobs before oldest are dropped."""

    async_timeout_s: float = 30.0
    """Max seconds to wait for a scorer before dropping the job."""

    alert_threshold: float = 0.7
    """Score below this emits a 'warning' alert event."""

    critical_threshold: float = 0.5
    """Score below this emits a 'critical' alert event."""

    window_size: int = 100
    """Number of recent scores to hold per scorer for rolling stats."""


# Callback type aliases
ScoreCallback = Callable[[ScoreResult], None]
AlertCallback = Callable[[AlertEvent], None]

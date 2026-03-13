"""Type definitions for the Output Quality Monitoring pattern.

Uses dataclasses and Protocol for idiomatic Python typing.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Protocol, runtime_checkable


@dataclass
class LLMInteraction:
    """A single LLM request/response pair to be scored."""

    id: str
    input: str
    output: str
    model: str
    prompt_template: str = "default"
    metadata: dict[str, Any] = field(default_factory=dict)
    timestamp: float = field(default_factory=lambda: time.time() * 1000)
    latency_ms: float = 0.0
    token_count: dict[str, int] = field(
        default_factory=lambda: {"input": 0, "output": 0}
    )


@dataclass
class ScoreResult:
    """Result from a single scorer evaluation."""

    scorer_name: str
    value: float
    duration_ms: float = 0.0
    error: str | None = None


@runtime_checkable
class Scorer(Protocol):
    """Protocol for scorer implementations."""

    @property
    def name(self) -> str: ...

    async def score(self, interaction: LLMInteraction) -> ScoreResult: ...


@dataclass
class TimeWindow:
    start_ms: float
    end_ms: float


@dataclass
class QualitySnapshot:
    """Aggregated quality scores for a time window."""

    window: TimeWindow
    scorer_name: str
    dimension_key: str
    dimension_value: str
    mean: float
    p50: float
    p95: float
    sample_count: int


@dataclass
class StoredScore:
    """A score entry persisted in the store."""

    interaction_id: str
    timestamp: float
    dimensions: dict[str, str]
    scores: list[ScoreResult]


@dataclass
class BaselineEntry:
    """Exponential moving average baseline for a scorer+dimension."""

    value: float
    sample_count: int
    last_updated: float


class AlertSeverity(Enum):
    WARNING = "warning"
    CRITICAL = "critical"


@dataclass
class QualityAlert:
    """Alert triggered by quality degradation."""

    severity: AlertSeverity
    scorer_name: str
    dimension_key: str
    dimension_value: str
    current_value: float
    baseline_value: float
    threshold: float
    message: str
    timestamp: float = field(default_factory=lambda: time.time() * 1000)


AlertHandler = Callable[[QualityAlert], None]


@dataclass
class HealthStatus:
    """Overall system health report."""

    healthy: bool
    active_alerts: list[QualityAlert]
    scorer_count: int
    total_scored: int
    total_sampled: int
    queue_depth: int
    queue_dropped: int


@dataclass
class QualityMonitorConfig:
    """Configuration for the QualityMonitor."""

    sample_rate: float = 0.1
    window_size_ms: float = 3_600_000  # 1 hour
    baseline_decay: float = 0.95
    absolute_threshold: float = 0.7
    relative_threshold: float = 0.1
    min_samples_for_alert: int = 30
    dimensions: list[str] = field(default_factory=lambda: ["prompt_template", "model"])
    scorer_timeout_ms: float = 5000
    max_queue_depth: int = 10_000


# Sentinel for default config
DEFAULT_CONFIG = QualityMonitorConfig()


class ScorerTimeoutError(Exception):
    """Raised when a scorer exceeds its timeout."""

    def __init__(self, scorer_name: str, timeout_ms: float):
        self.scorer_name = scorer_name
        self.timeout_ms = timeout_ms
        super().__init__(f"Scorer '{scorer_name}' timed out after {timeout_ms}ms")


class QueueOverflowError(Exception):
    """Raised when the scoring queue is full."""

    def __init__(self, queue_depth: int, max_depth: int):
        self.queue_depth = queue_depth
        self.max_depth = max_depth
        super().__init__(f"Queue full: {queue_depth}/{max_depth}")

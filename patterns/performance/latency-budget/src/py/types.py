"""Latency Budget Pattern — Type Definitions."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class BudgetExhaustedStrategy(str, Enum):
    """Strategy when budget pressure is detected."""

    SKIP_OPTIONAL = "skip-optional"
    ABORT = "abort"
    BEST_EFFORT = "best-effort"


@dataclass(frozen=True)
class StepResult:
    """Result of a pipeline step execution."""

    output: Any
    skipped: bool
    elapsed_ms: float
    remaining_ms: float


@dataclass
class StepConfig:
    """Per-step configuration."""

    name: str
    min_budget_ms: float = 100.0
    optional: bool = False
    timeout_ms: float | None = None


@dataclass
class LatencyBudgetConfig:
    """Pipeline configuration."""

    total_budget_ms: float = 3000.0
    reserve_ms: float = 200.0
    on_budget_exhausted: BudgetExhaustedStrategy = BudgetExhaustedStrategy.SKIP_OPTIONAL


@dataclass(frozen=True)
class StepTiming:
    """Per-step timing entry for metrics."""

    name: str
    elapsed_ms: float
    skipped: bool
    remaining_budget_ms: float


@dataclass(frozen=True)
class PipelineMetrics:
    """Metrics emitted per pipeline execution."""

    total_elapsed_ms: float
    budget_utilization: float
    skipped_steps: int
    step_timings: list[StepTiming]
    deadline_exceeded: bool


@dataclass
class MockProviderConfig:
    """Mock provider configuration for testing."""

    latency_ms: float = 500.0
    variance_ms: float = 100.0
    output_tokens: int = 150
    error_rate: float = 0.0
    deterministic_latencies: list[float] = field(default_factory=list)


@dataclass(frozen=True)
class MockProviderResponse:
    """Response from the mock LLM provider."""

    text: str
    input_tokens: int
    output_tokens: int
    latency_ms: float
    model: str

"""Type definitions for Model Routing pattern."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol


class ModelTier(str, Enum):
    STRONG = "strong"
    MID = "mid"
    WEAK = "weak"


@dataclass(frozen=True)
class ModelConfig:
    id: str
    tier: ModelTier
    input_cost_per_1m_tokens: float
    output_cost_per_1m_tokens: float


@dataclass
class RouterConfig:
    weak_threshold: float = 0.3
    strong_threshold: float = 0.7
    models: dict[ModelTier, ModelConfig] = field(default_factory=dict)
    fallback_tier: ModelTier = ModelTier.STRONG
    enable_logging: bool = True
    quality_threshold: float = 0.8

    def __post_init__(self) -> None:
        if not self.models:
            self.models = {
                ModelTier.STRONG: ModelConfig(
                    id="gpt-4o",
                    tier=ModelTier.STRONG,
                    input_cost_per_1m_tokens=2.5,
                    output_cost_per_1m_tokens=10.0,
                ),
                ModelTier.MID: ModelConfig(
                    id="claude-sonnet",
                    tier=ModelTier.MID,
                    input_cost_per_1m_tokens=3.0,
                    output_cost_per_1m_tokens=15.0,
                ),
                ModelTier.WEAK: ModelConfig(
                    id="gpt-4o-mini",
                    tier=ModelTier.WEAK,
                    input_cost_per_1m_tokens=0.15,
                    output_cost_per_1m_tokens=0.6,
                ),
            }


@dataclass
class RouteRequest:
    prompt: str
    task_type: str | None = None
    metadata: dict[str, Any] | None = None
    quality_threshold: float | None = None


@dataclass(frozen=True)
class CompletionResult:
    response: str
    input_tokens: int
    output_tokens: int


@dataclass(frozen=True)
class RouteResponse:
    response: str
    model: str
    tier: ModelTier
    complexity_score: float
    latency_ms: float
    input_tokens: int
    output_tokens: int


@dataclass
class RouteDecision:
    timestamp: float
    complexity_score: float
    tier: ModelTier
    model: str
    task_type: str | None
    latency_ms: float
    input_tokens: int
    output_tokens: int


@dataclass
class RouterStats:
    total_requests: int
    routes_by_tier: dict[ModelTier, int]
    average_complexity_score: float
    classification_errors: int
    recent_decisions: list[RouteDecision]


class LLMProvider(Protocol):
    """Protocol for LLM providers — what the router calls to get completions."""

    async def complete(self, model_id: str, prompt: str) -> CompletionResult: ...


class ComplexityClassifier(Protocol):
    """Protocol for complexity classifiers — swappable."""

    def classify(self, prompt: str, task_type: str | None = None) -> float: ...

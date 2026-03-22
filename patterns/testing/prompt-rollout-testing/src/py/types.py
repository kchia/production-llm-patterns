"""
Type definitions for Prompt Rollout Testing pattern.
Supports A/B splits, canary deploys, and shadow mode.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Awaitable, Callable, NamedTuple


class RolloutMode(str, Enum):
    AB = "ab"
    CANARY = "canary"
    SHADOW = "shadow"


class RolloutDecisionAction(str, Enum):
    HOLD = "hold"
    PROMOTE = "promote"
    ROLLBACK = "rollback"


@dataclass
class PromptVariant:
    id: str
    label: str          # e.g. "current", "candidate-v2"
    prompt: str
    weight: float       # 0.0–1.0; all weights must sum to 1.0


@dataclass
class RolloutConfig:
    variants: list[PromptVariant]
    mode: RolloutMode
    min_sample_size: int
    significance_level: float
    quality_metric: Callable[[str, str], Awaitable[float]]
    auto_rollback: bool
    rollback_threshold: float
    evaluation_interval: int = 50


@dataclass
class LLMRequest:
    input: str


@dataclass
class LLMResponse:
    output: str
    variant_id: str
    latency_ms: float
    input_tokens: int
    output_tokens: int


@dataclass
class VariantStats:
    variant_id: str
    label: str
    request_count: int = 0
    quality_scores: list[float] = field(default_factory=list)
    latencies_ms: list[float] = field(default_factory=list)
    total_input_tokens: int = 0
    total_output_tokens: int = 0


@dataclass
class RolloutDecision:
    action: RolloutDecisionAction
    confidence: float       # 1 - p_value
    p_value: float
    variant_stats: dict[str, VariantStats]
    reasoning: str

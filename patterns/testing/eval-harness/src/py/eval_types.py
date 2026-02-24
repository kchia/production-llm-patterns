"""Eval Harness — Type Definitions

Dataclasses and protocols for the evaluation pipeline:
cases, scorers, results, and comparison.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable, Optional, Protocol


# --- Eval Dataset ---


@dataclass(frozen=True)
class EvalCase:
    id: str
    input: str
    expected: Optional[str] = None
    tags: tuple[str, ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)


# --- Scorer ---


@dataclass
class ScorerResult:
    score: float  # 0.0 – 1.0
    passed: bool
    reason: Optional[str] = None


class Scorer(Protocol):
    name: str

    async def score(
        self, input: str, output: str, expected: Optional[str] = None
    ) -> ScorerResult: ...


# --- Provider ---


@dataclass
class ProviderResponse:
    output: str
    latency_ms: float
    token_usage: TokenUsage


@dataclass
class TokenUsage:
    input: int
    output: int


# Provider is an async callable: str -> ProviderResponse
Provider = Callable[[str], Awaitable[ProviderResponse]]


# --- Eval Results ---


@dataclass
class EvalCaseResult:
    case_id: str
    input: str
    output: str
    expected: Optional[str]
    tags: tuple[str, ...]
    scores: dict[str, ScorerResult]
    latency_ms: float
    token_usage: TokenUsage


@dataclass
class AggregateScores:
    overall: dict[str, float]  # scorer name -> mean score
    by_tag: dict[str, dict[str, float]]  # tag -> scorer -> mean score
    pass_rate: float  # fraction of cases where all scorers passed


@dataclass
class EvalRunResult:
    run_id: str
    timestamp: str
    results: list[EvalCaseResult]
    aggregate: AggregateScores
    duration_ms: float


# --- Comparison ---


@dataclass
class ScoreDelta:
    scorer: str
    tag: Optional[str]  # None = overall
    baseline_score: float
    current_score: float
    delta: float


@dataclass
class ComparisonResult:
    baseline_run_id: str
    current_run_id: str
    regressions: list[ScoreDelta]
    improvements: list[ScoreDelta]
    overall_delta: dict[str, float]  # scorer -> delta
    by_tag_delta: dict[str, dict[str, float]]  # tag -> scorer -> delta
    passed: bool


# --- Config Defaults ---

DEFAULT_CONCURRENCY = 5
DEFAULT_THRESHOLD = 0.7
DEFAULT_REGRESSION_TOLERANCE = 0.05
DEFAULT_TIMEOUT_MS = 30_000

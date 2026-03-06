"""
Regression Testing — Type Definitions

Dataclass-based types for baseline management, version-aware comparison,
and CI gate logic. Uses Python idioms: dataclasses, TypedDict, Protocol.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import (
    Any,
    Awaitable,
    Callable,
    Optional,
    Protocol,
)


# --- Provider & Scorer ---


@dataclass(frozen=True)
class ProviderResponse:
    output: str
    latency_ms: float
    token_usage: TokenUsage


@dataclass(frozen=True)
class TokenUsage:
    input: int
    output: int


# Provider is an async callable: str -> ProviderResponse
LLMProvider = Callable[[str], Awaitable[ProviderResponse]]


@dataclass(frozen=True)
class ScorerResult:
    score: float  # 0.0–1.0
    passed: bool
    reason: Optional[str] = None


class Scorer(Protocol):
    @property
    def name(self) -> str: ...

    async def score(
        self, input: str, output: str, expected: Optional[str] = None
    ) -> ScorerResult: ...


# --- Test Suite ---


@dataclass(frozen=True)
class TestCase:
    id: str
    input: str
    tags: list[str]
    expected: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None


@dataclass(frozen=True)
class TestSuite:
    id: str
    version: str
    cases: list[TestCase]


# --- Eval Results ---


@dataclass
class CaseResult:
    case_id: str
    input: str
    output: str
    tags: list[str]
    scores: dict[str, ScorerResult]
    latency_ms: float
    token_usage: TokenUsage
    expected: Optional[str] = None


@dataclass
class AggregateScores:
    overall: dict[str, float]  # scorer name → mean score
    by_tag: dict[str, dict[str, float]]  # tag → scorer → mean
    pass_rate: float


@dataclass
class RunResult:
    run_id: str
    suite_id: str
    suite_version: str
    timestamp: str
    results: list[CaseResult]
    aggregate: AggregateScores
    duration_ms: float


# --- Baseline Store ---


class BaselineStore(Protocol):
    async def load(self, suite_id: str) -> Optional[RunResult]: ...
    async def save(self, suite_id: str, result: RunResult) -> None: ...
    async def history(self, suite_id: str, limit: int) -> list[RunResult]: ...
    async def load_genesis(self, suite_id: str) -> Optional[RunResult]: ...
    async def save_genesis(self, suite_id: str, result: RunResult) -> None: ...


# --- Regression Detection ---


@dataclass(frozen=True)
class TagRegression:
    scorer: str
    baseline_score: float
    current_score: float
    delta: float
    tag: Optional[str] = None


@dataclass(frozen=True)
class TagImprovement:
    scorer: str
    baseline_score: float
    current_score: float
    delta: float
    tag: Optional[str] = None


# --- Report ---


@dataclass
class RegressionReport:
    passed: bool
    overall_score: float
    baseline_score: Optional[float]
    genesis_score: Optional[float]
    genesis_delta: Optional[float]
    regressions: list[TagRegression]
    improvements: list[TagImprovement]
    per_tag_scores: dict[str, dict[str, float]]
    summary: str
    run_result: RunResult


# --- Config ---


@dataclass
class RegressionConfig:
    suite: TestSuite
    provider: LLMProvider
    scorers: list[Any]  # list[Scorer] — Any to avoid Protocol runtime issues
    baseline_store: BaselineStore
    regression_threshold: float = 0.05
    min_pass_score: float = 0.7
    fail_on_regression: bool = True
    concurrency: int = 5
    timeout_ms: float = 30_000
    genesis_gap_threshold: float = 0.10

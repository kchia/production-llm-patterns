"""Type definitions for the Adversarial Inputs testing pattern."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal, Protocol, runtime_checkable

AttackCategory = Literal[
    "prompt-injection",
    "unicode-smuggling",
    "input-overflow",
    "encoding-bypass",
    "multilingual",
    "output-manipulation",
]

ALL_CATEGORIES: list[AttackCategory] = [
    "prompt-injection",
    "unicode-smuggling",
    "input-overflow",
    "encoding-bypass",
    "multilingual",
    "output-manipulation",
]

Severity = Literal["critical", "high", "medium", "low", "info"]
TestVerdict = Literal["pass", "fail"]

# The target function under test — takes user input, returns the LLM response.
# Can be a raw model call, a full RAG pipeline, or an agent with tool access.
TargetFunction = Callable[[str], Awaitable[str]]

SEVERITY_ORDER: dict[Severity, int] = {
    "critical": 4,
    "high": 3,
    "medium": 2,
    "low": 1,
    "info": 0,
}


def severity_at_least(severity: Severity, threshold: Severity) -> bool:
    """Check if a severity level meets or exceeds a threshold."""
    return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[threshold]


@dataclass
class TestCase:
    """A single adversarial test case."""

    id: str
    category: AttackCategory
    name: str
    input: str
    expected_vulnerable_pattern: str | None = None
    metadata: dict[str, Any] | None = None


@dataclass
class JudgeResult:
    """Output from a response judge evaluation."""

    verdict: TestVerdict
    severity: Severity
    reason: str


@dataclass
class TestResult:
    """Result of running a single test case."""

    test_case: TestCase
    response: str
    verdict: TestVerdict
    severity: Severity
    reason: str
    duration_ms: float
    error: str | None = None


@dataclass
class CategoryResult:
    """Aggregated results for one attack category."""

    category: AttackCategory
    total: int
    passed: int
    failed: int
    attack_success_rate: float
    results: list[TestResult]
    duration_ms: float


@dataclass
class ReportSummary:
    """High-level summary across all categories."""

    total_tests: int
    total_passed: int
    total_failed: int
    overall_asr: float
    critical_failures: int
    high_failures: int
    should_fail: bool
    regressions: list[RegressionDiff]


@dataclass
class RegressionDiff:
    """A test that changed verdict between baseline and current run."""

    test_case_id: str
    category: AttackCategory
    previous_verdict: TestVerdict
    current_verdict: TestVerdict
    description: str


@dataclass
class TestReport:
    """Complete test report from a harness run."""

    timestamp: str
    categories: list[CategoryResult]
    summary: ReportSummary
    config: RunConfig


@dataclass
class RunConfig:
    """Configuration for a test run."""

    categories: list[AttackCategory] = field(default_factory=lambda: list(ALL_CATEGORIES))
    cases_per_category: int = 50
    max_concurrency: int = 10
    timeout_ms: float = 30_000
    severity_threshold: Severity = "low"
    fail_on_severity: Severity = "high"
    include_passing_cases: bool = False
    baseline_results: TestReport | None = None


DEFAULT_CONFIG = RunConfig()


@runtime_checkable
class InputGenerator(Protocol):
    """Protocol for generating adversarial test cases."""

    @property
    def category(self) -> AttackCategory: ...

    def generate(self, count: int) -> list[TestCase]: ...


@runtime_checkable
class ResponseJudge(Protocol):
    """Protocol for judging target responses."""

    def judge(self, test_case: TestCase, response: str) -> JudgeResult: ...

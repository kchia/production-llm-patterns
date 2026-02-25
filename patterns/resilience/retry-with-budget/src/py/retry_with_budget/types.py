"""
Retry with Budget — Type Definitions

Core types for the retry-with-budget pattern.
Framework-agnostic, no external dependencies beyond stdlib.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Literal


@dataclass
class LLMRequest:
    """A request to an LLM provider."""

    prompt: str
    max_tokens: int | None = None
    temperature: float | None = None
    metadata: dict[str, object] | None = None


@dataclass
class LLMResponse:
    """A response from an LLM provider."""

    content: str
    tokens_used: int | None = None
    model: str | None = None
    finish_reason: str | None = None


class ProviderError(Exception):
    """An error from an LLM provider with HTTP status semantics."""

    def __init__(
        self,
        message: str,
        status_code: int,
        *,
        retry_after_ms: int | None = None,
        is_retryable: bool | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.retry_after_ms = retry_after_ms
        self.is_retryable = (
            is_retryable
            if is_retryable is not None
            else status_code in (429, 500, 502, 503)
        )


@dataclass
class AttemptRecord:
    """Record of a single attempt within the retry loop."""

    attempt: int
    error: Exception
    latency_ms: float
    delay_ms: float


class RetriesExhaustedError(Exception):
    """Raised when all retry attempts are exhausted."""

    def __init__(
        self,
        attempts: list[AttemptRecord],
        total_latency_ms: float,
        budget_exhausted: bool,
    ) -> None:
        reason = "budget exhausted" if budget_exhausted else "max attempts reached"
        summary = "; ".join(
            f"attempt {a.attempt}: {a.error} ({a.latency_ms:.1f}ms)"
            for a in attempts
        )
        super().__init__(f"All retries exhausted ({reason}): {summary}")
        self.attempts = attempts
        self.total_latency_ms = total_latency_ms
        self.budget_exhausted = budget_exhausted


@dataclass
class TokenBucketConfig:
    """Configuration for the token bucket that controls retry budget."""

    max_tokens: int = 100
    token_ratio: float = 0.1
    refill_interval_ms: int = 1000
    refill_amount: int = 1


JitterMode = Literal["full", "equal", "none"]


@dataclass
class RetryEvent:
    """Information about a single retry attempt."""

    attempt: int
    max_attempts: int
    error: Exception
    delay_ms: float
    budget_remaining: float


@dataclass
class BudgetExhaustedEvent:
    """Fired when a retry is skipped because the budget is exhausted."""

    attempt: int
    max_attempts: int
    error: Exception
    budget_remaining: float
    budget_max: int


@dataclass
class RetryResult:
    """The result of executing a request through the retry handler."""

    response: LLMResponse
    attempts: int
    total_latency_ms: float
    retries_used: int
    budget_remaining: float


@dataclass
class RetryWithBudgetConfig:
    """Full configuration for RetryWithBudget."""

    max_attempts: int = 3
    initial_delay_ms: float = 200
    max_delay_ms: float = 30_000
    backoff_multiplier: float = 2
    jitter_mode: JitterMode = "full"
    budget_config: TokenBucketConfig | None = None
    retryable_statuses: list[int] = field(
        default_factory=lambda: [429, 500, 502, 503]
    )
    on_retry: Callable[[RetryEvent], None] | None = None
    on_budget_exhausted: Callable[[BudgetExhaustedEvent], None] | None = None

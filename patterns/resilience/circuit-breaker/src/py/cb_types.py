"""Circuit Breaker types for LLM provider protection."""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Any, Callable, Optional


# --- LLM Request/Response ---


@dataclass
class LLMRequest:
    prompt: str
    model: Optional[str] = None
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None


@dataclass
class LLMResponse:
    content: str
    token_usage: TokenUsage
    latency_ms: float
    model: str


@dataclass
class TokenUsage:
    input: int
    output: int
    total: int


# --- Circuit Breaker states ---


class CircuitState(enum.Enum):
    CLOSED = "CLOSED"
    OPEN = "OPEN"
    HALF_OPEN = "HALF_OPEN"


# --- Events ---


@dataclass
class StateChangeEvent:
    from_state: CircuitState
    to_state: CircuitState
    failure_rate: float
    timestamp: float


@dataclass
class RequestEvent:
    state: CircuitState
    latency_ms: float
    timestamp: float
    error: Optional[Any] = None


# --- Sliding Window ---


@dataclass
class WindowEntry:
    success: bool
    timestamp: float


@dataclass
class WindowStats:
    total: int
    failures: int
    successes: int
    failure_rate: float


# --- Configuration ---


@dataclass
class CircuitBreakerConfig:
    """Circuit breaker configuration with sensible defaults."""

    failure_threshold: float = 50.0
    """Failure rate percentage (0-100) that trips the circuit."""

    reset_timeout_ms: float = 30_000.0
    """How long the circuit stays open before probing (ms)."""

    half_open_max_attempts: int = 3
    """Number of successful probes required to close the circuit."""

    minimum_requests: int = 10
    """Minimum requests in window before evaluating failure rate."""

    window_size: int = 100
    """Sliding window size (number of requests tracked)."""

    window_duration_ms: float = 60_000.0
    """Time-based window duration — requests older than this are evicted (ms)."""

    is_failure: Optional[Callable[[BaseException], bool]] = None
    """Custom function to classify which errors count as failures."""

    on_state_change: Optional[Callable[[StateChangeEvent], None]] = None
    """Callback fired on every state transition."""

    on_success: Optional[Callable[[RequestEvent], None]] = None
    """Callback fired when a request succeeds."""

    on_failure: Optional[Callable[[RequestEvent], None]] = None
    """Callback fired when a request fails."""


# --- Errors ---


class CircuitOpenError(Exception):
    """Raised when a request is rejected because the circuit is open."""

    def __init__(
        self,
        *,
        reset_timeout_ms: float,
        failure_rate: float,
        remaining_ms: float,
    ) -> None:
        super().__init__(
            f"Circuit is OPEN (failure rate: {failure_rate:.1f}%, "
            f"resets in {remaining_ms:.0f}ms)"
        )
        self.state = CircuitState.OPEN
        self.reset_timeout_ms = reset_timeout_ms
        self.failure_rate = failure_rate
        self.remaining_ms = remaining_ms


class ProviderError(Exception):
    """Raised by LLM providers to indicate an error with a status code."""

    def __init__(
        self,
        message: str,
        status_code: int,
        retry_after_ms: Optional[float] = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.retry_after_ms = retry_after_ms

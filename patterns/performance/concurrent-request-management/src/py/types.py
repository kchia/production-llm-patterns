"""
Types for the Concurrent Request Management pattern.

Key design: separate RPM and TPM controls because they exhaust at different
rates and reset on different schedules. A semaphore alone with no token bucket
will happily blow through your TPM limit with large-context requests.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional


@dataclass
class ConcurrencyManagerConfig:
    """Configuration for the ConcurrencyManager."""

    # Max in-flight requests at any moment.
    max_concurrent: int = 10
    # Max requests per minute. Set to ~80% of provider limit.
    max_requests_per_minute: int = 500
    # Max input+output tokens per minute. Set to ~80% of provider limit.
    max_tokens_per_minute: int = 80_000
    # Max retry attempts on 429 or transient errors.
    max_retries: int = 4
    # Base delay for exponential backoff in seconds.
    base_retry_delay_s: float = 1.0
    # Maximum delay cap in seconds.
    max_retry_delay_s: float = 60.0
    # Jitter factor: actual delay = calculated ± (calculated × factor).
    # 0.25 = ±25%, desynchronizes retry waves across instances.
    jitter_factor: float = 0.25


@dataclass
class LLMUsage:
    input_tokens: int
    output_tokens: int


@dataclass
class LLMResponse:
    content: str
    usage: Optional[LLMUsage] = None


@dataclass
class LLMRequest:
    """A managed LLM request."""

    # Estimated input token count for pre-admission TPM check.
    estimated_input_tokens: int
    # Callable that performs the actual LLM API call.
    execute: Callable[[], Awaitable[LLMResponse]] = field(repr=False)
    # Estimated output tokens (optional; used with input for TPM accounting).
    estimated_output_tokens: int = 0
    # Optional identifier for logging and metrics.
    request_id: Optional[str] = None


@dataclass
class ConcurrencyMetrics:
    in_flight: int
    tokens_used_this_window: int
    requests_used_this_window: int
    total_completed: int
    total_failed: int
    total_rate_limit_hits: int
    total_retries_succeeded: int


class MaxRetriesExceededError(Exception):
    """Raised when a request exhausts all retry attempts."""

    def __init__(self, request_id: str, attempts: int, last_error: Exception) -> None:
        super().__init__(
            f"Request {request_id} failed after {attempts} attempt(s): {last_error}"
        )
        self.request_id = request_id
        self.attempts = attempts
        self.last_error = last_error


class TokenBudgetExceededError(Exception):
    """Raised when a single request estimates more tokens than the per-minute limit."""

    def __init__(
        self, request_id: str, estimated_tokens: int, limit_tokens: int
    ) -> None:
        super().__init__(
            f"Request {request_id} estimates {estimated_tokens} tokens, "
            f"exceeding per-minute limit of {limit_tokens}"
        )
        self.request_id = request_id
        self.estimated_tokens = estimated_tokens
        self.limit_tokens = limit_tokens

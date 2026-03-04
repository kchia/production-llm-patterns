"""
Multi-Provider Failover — Type Definitions

Core types for the failover router pattern.
Framework-agnostic, no external dependencies.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal


@dataclass
class LLMRequest:
    """Provider-agnostic LLM request."""

    prompt: str
    max_tokens: int | None = None
    temperature: float | None = None
    metadata: dict[str, Any] | None = None


@dataclass
class LLMResponse:
    """Provider-agnostic LLM response. Each provider handler normalizes to this shape."""

    content: str
    tokens_used: int
    model: str
    finish_reason: Literal["stop", "length", "error"]
    latency_ms: float


ProviderHandler = Callable[[LLMRequest], Awaitable[LLMResponse]]

ErrorCategory = Literal["retryable", "failover", "fatal"]

ProviderStatus = Literal["healthy", "cooldown", "unknown"]


class ProviderError(Exception):
    """An error thrown by a provider, with enough context for classification."""

    def __init__(
        self,
        message: str,
        status_code: int,
        provider: str,
        is_timeout: bool = False,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.provider = provider
        self.is_timeout = is_timeout


@dataclass
class ProviderAttempt:
    """Record of a single attempt during failover."""

    provider: str
    status: Literal["success", "failover", "retryable", "fatal"]
    latency_ms: float
    error: Exception | None = None
    error_category: ErrorCategory | None = None


@dataclass
class ProviderHealth:
    """Snapshot of a single provider's health."""

    name: str
    status: ProviderStatus
    success_rate: float
    avg_latency_ms: float
    total_requests: int
    cooldown_until: float | None
    consecutive_failures: int


@dataclass
class FailoverResult:
    """Result returned to the caller after the failover router finishes."""

    response: LLMResponse
    provider: str
    attempts: list[ProviderAttempt] = field(default_factory=list)
    failover_occurred: bool = False
    total_latency_ms: float = 0.0


@dataclass
class ProviderConfig:
    """Configuration for a single provider in the ring."""

    name: str
    handler: ProviderHandler
    priority: int | None = None  # lower = higher priority
    timeout: float | None = None  # per-provider timeout override in seconds


class AllProvidersExhaustedError(Exception):
    """Raised when every provider has been tried without a successful response."""

    def __init__(
        self, attempts: list[ProviderAttempt], request: LLMRequest
    ) -> None:
        self.attempts = attempts
        self.request = request
        summary = ", ".join(
            f"{a.provider}: {a.error}" for a in attempts
        )
        super().__init__(f"All providers exhausted: {summary}")

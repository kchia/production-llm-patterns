"""
Graceful Degradation — Type Definitions

Core types for the degradation chain pattern.
Framework-agnostic, no external dependencies.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal


@dataclass
class LLMRequest:
    """A request to an LLM provider."""

    prompt: str
    max_tokens: int | None = None
    temperature: float | None = None
    metadata: dict[str, Any] | None = None


@dataclass
class LLMResponse:
    """A response from an LLM provider."""

    content: str
    tokens_used: int | None = None
    model: str | None = None
    finish_reason: str | None = None


TierStatus = Literal[
    "success", "failure", "timeout", "skipped_unhealthy", "skipped_quality"
]


@dataclass
class TierAttempt:
    """Record of a single tier attempt."""

    tier: str
    status: TierStatus
    latency_ms: float
    error: str | None = None


@dataclass
class DegradationResult:
    """The result of walking the degradation chain."""

    response: LLMResponse
    tier: str
    quality: float
    latency_ms: float
    degraded: bool
    attempted_tiers: list[TierAttempt] = field(default_factory=list)


@dataclass
class DegradationTier:
    """A single degradation tier in the chain.

    Each tier wraps a handler callable that attempts to produce a response.
    Tiers are tried in order — first success wins.
    """

    name: str
    handler: Callable[[LLMRequest], Awaitable[LLMResponse]]
    quality_score: float
    timeout_ms: float
    is_healthy: Callable[[], bool] | None = None


class AllTiersExhaustedError(Exception):
    """Error raised when every tier in the chain fails."""

    def __init__(self, attempts: list[TierAttempt]) -> None:
        self.attempts = attempts
        summary = ", ".join(
            f"{a.tier}: {a.status}" + (f" ({a.error})" if a.error else "")
            for a in attempts
        )
        super().__init__(f"All degradation tiers exhausted: {summary}")

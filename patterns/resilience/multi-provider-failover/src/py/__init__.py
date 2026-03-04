"""
Multi-Provider Failover — FailoverRouter

Routes LLM requests across multiple providers with automatic failover,
error classification, and per-provider health tracking.

Framework-agnostic. No external dependencies.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Callable

from .types import (
    AllProvidersExhaustedError,
    ErrorCategory,
    FailoverResult,
    LLMRequest,
    ProviderAttempt,
    ProviderConfig,
    ProviderError,
    ProviderHealth,
    ProviderStatus,
)


class _HealthWindow:
    """Sliding window of recent request outcomes for a single provider.

    Uses a bounded deque-style list to avoid unbounded memory growth.
    """

    def __init__(self, max_size: int) -> None:
        self._max_size = max_size
        self._entries: list[tuple[bool, float]] = []  # (success, latency_ms)

    def record(self, success: bool, latency_ms: float) -> None:
        self._entries.append((success, latency_ms))
        if len(self._entries) > self._max_size:
            self._entries.pop(0)

    @property
    def failure_rate(self) -> float:
        if not self._entries:
            return 0.0
        failures = sum(1 for ok, _ in self._entries if not ok)
        return failures / len(self._entries)

    @property
    def avg_latency_ms(self) -> float:
        if not self._entries:
            return 0.0
        return sum(lat for _, lat in self._entries) / len(self._entries)

    @property
    def total_requests(self) -> int:
        return len(self._entries)

    def clear(self) -> None:
        self._entries.clear()


@dataclass
class _ProviderState:
    """Internal mutable state for a single provider."""

    config: ProviderConfig
    health: _HealthWindow
    cooldown_until: float | None = None
    consecutive_failures: int = 0


class FailoverRouter:
    """Routes LLM requests across multiple providers with automatic failover.

    Providers are tried in priority order. Failed providers enter a cooldown
    period during which they're skipped. Errors are classified to determine
    whether to retry, failover, or stop immediately.
    """

    def __init__(
        self,
        providers: list[ProviderConfig],
        *,
        timeout: float = 30.0,
        cooldown_s: float = 60.0,
        failure_threshold: float = 0.5,
        window_size: int = 10,
        max_failovers: int | None = None,
        on_failover: Callable[[str, str, Exception], None] | None = None,
        on_provider_cooldown: Callable[[str, bool], None] | None = None,
    ) -> None:
        if not providers:
            raise ValueError("At least one provider is required")

        self._timeout = timeout
        self._cooldown_s = cooldown_s
        self._failure_threshold = failure_threshold
        self._max_failovers = max_failovers if max_failovers is not None else len(providers)
        self._on_failover = on_failover
        self._on_provider_cooldown = on_provider_cooldown

        # Sort by priority (lower = higher priority), stable sort preserves insertion order
        sorted_providers = sorted(
            providers,
            key=lambda p: p.priority if p.priority is not None else float("inf"),
        )
        self._providers = [
            _ProviderState(
                config=p,
                health=_HealthWindow(window_size),
            )
            for p in sorted_providers
        ]

    async def complete(self, request: LLMRequest) -> FailoverResult:
        """Execute an LLM request with automatic failover across providers."""
        attempts: list[ProviderAttempt] = []
        overall_start = time.perf_counter()
        failover_count = 0

        for state in self._providers:
            if failover_count >= self._max_failovers:
                break

            if self._is_in_cooldown(state):
                continue

            provider_timeout = state.config.timeout if state.config.timeout is not None else self._timeout
            attempt_start = time.perf_counter()

            try:
                response = await asyncio.wait_for(
                    state.config.handler(request),
                    timeout=provider_timeout,
                )
                latency_ms = (time.perf_counter() - attempt_start) * 1000

                state.health.record(True, latency_ms)
                state.consecutive_failures = 0

                attempts.append(ProviderAttempt(
                    provider=state.config.name,
                    status="success",
                    latency_ms=latency_ms,
                ))

                return FailoverResult(
                    response=response,
                    provider=state.config.name,
                    attempts=attempts,
                    failover_occurred=len(attempts) > 1,
                    total_latency_ms=(time.perf_counter() - overall_start) * 1000,
                )

            except asyncio.TimeoutError:
                latency_ms = (time.perf_counter() - attempt_start) * 1000
                error = ProviderError(
                    f"{state.config.name} timed out after {provider_timeout}s",
                    status_code=0,
                    provider=state.config.name,
                    is_timeout=True,
                )
                category = classify_error(error)

                state.health.record(False, latency_ms)
                state.consecutive_failures += 1

                attempts.append(ProviderAttempt(
                    provider=state.config.name,
                    status=category,
                    latency_ms=latency_ms,
                    error=error,
                    error_category=category,
                ))

                self._maybe_enter_cooldown(state)
                failover_count += 1

                next_provider = self._find_next_available(state)
                if next_provider and self._on_failover:
                    self._on_failover(state.config.name, next_provider.config.name, error)

            except Exception as exc:
                latency_ms = (time.perf_counter() - attempt_start) * 1000
                category = classify_error(exc)

                state.health.record(False, latency_ms)
                state.consecutive_failures += 1

                attempts.append(ProviderAttempt(
                    provider=state.config.name,
                    status=category,
                    latency_ms=latency_ms,
                    error=exc,
                    error_category=category,
                ))

                self._maybe_enter_cooldown(state)

                if category == "fatal":
                    raise AllProvidersExhaustedError(attempts, request) from exc

                failover_count += 1

                next_provider = self._find_next_available(state)
                if next_provider and self._on_failover:
                    self._on_failover(state.config.name, next_provider.config.name, exc)

        raise AllProvidersExhaustedError(attempts, request)

    def get_provider_health(self) -> dict[str, ProviderHealth]:
        """Get a health snapshot for all providers."""
        result: dict[str, ProviderHealth] = {}
        for state in self._providers:
            result[state.config.name] = ProviderHealth(
                name=state.config.name,
                status=self._get_status(state),
                success_rate=1 - state.health.failure_rate,
                avg_latency_ms=state.health.avg_latency_ms,
                total_requests=state.health.total_requests,
                cooldown_until=state.cooldown_until,
                consecutive_failures=state.consecutive_failures,
            )
        return result

    def reset_provider(self, name: str) -> None:
        """Manually reset a provider's health state and remove cooldown."""
        for state in self._providers:
            if state.config.name == name:
                state.health.clear()
                state.cooldown_until = None
                state.consecutive_failures = 0
                if self._on_provider_cooldown:
                    self._on_provider_cooldown(name, False)
                return
        raise ValueError(f"Unknown provider: {name}")

    def _is_in_cooldown(self, state: _ProviderState) -> bool:
        if state.cooldown_until is None:
            return False
        if time.monotonic() >= state.cooldown_until:
            state.cooldown_until = None
            if self._on_provider_cooldown:
                self._on_provider_cooldown(state.config.name, False)
            return False
        return True

    def _maybe_enter_cooldown(self, state: _ProviderState) -> None:
        if (
            state.health.total_requests >= 3
            and state.health.failure_rate >= self._failure_threshold
        ):
            state.cooldown_until = time.monotonic() + self._cooldown_s
            if self._on_provider_cooldown:
                self._on_provider_cooldown(state.config.name, True)

    def _find_next_available(self, current: _ProviderState) -> _ProviderState | None:
        idx = self._providers.index(current)
        for i in range(idx + 1, len(self._providers)):
            if not self._is_in_cooldown(self._providers[i]):
                return self._providers[i]
        return None

    def _get_status(self, state: _ProviderState) -> ProviderStatus:
        if self._is_in_cooldown(state):
            return "cooldown"
        if state.health.total_requests == 0:
            return "unknown"
        return "healthy"


def classify_error(error: Exception) -> ErrorCategory:
    """Classify an error into routing categories.

    Determines whether to retry the same provider, try the next, or give up.
    """
    if isinstance(error, ProviderError):
        if error.is_timeout:
            return "failover"

        code = error.status_code

        # Rate limits — retryable on the same provider with backoff
        if code in (429, 529):
            return "retryable"

        # Client errors — the request itself is broken
        if 400 <= code < 500:
            return "fatal"

        # Server errors — try another provider
        if code >= 500:
            return "failover"

    msg = str(error)
    # Timeouts and network errors → failover
    if any(keyword in msg for keyword in ("timeout", "ECONNREFUSED", "ENOTFOUND")):
        return "failover"

    # Unknown errors default to failover — safer than fatal
    return "failover"

"""
Circuit Breaker for LLM providers.

Monitors failure rates in a sliding window and transitions between
CLOSED -> OPEN -> HALF_OPEN -> CLOSED to protect against cascading failures.
"""

from __future__ import annotations

import asyncio
import time
from typing import Awaitable, Callable, Optional, TypeVar

from .cb_types import (
    CircuitBreakerConfig,
    CircuitOpenError,
    CircuitState,
    LLMRequest,
    LLMResponse,
    ProviderError,
    RequestEvent,
    StateChangeEvent,
    TokenUsage,
    WindowEntry,
    WindowStats,
)

# Re-exports
from .mock_provider import MockProvider, MockProviderConfig

__all__ = [
    "CircuitBreaker",
    "CircuitBreakerConfig",
    "CircuitOpenError",
    "CircuitState",
    "LLMRequest",
    "LLMResponse",
    "MockProvider",
    "MockProviderConfig",
    "ProviderError",
    "RequestEvent",
    "SlidingWindow",
    "StateChangeEvent",
    "TokenUsage",
    "WindowStats",
]

T = TypeVar("T", bound=LLMResponse)


class SlidingWindow:
    """Count-based + time-based sliding window for tracking request outcomes."""

    def __init__(self, max_size: int, max_age_ms: float) -> None:
        self._entries: list[WindowEntry] = []
        self._max_size = max_size
        self._max_age_ms = max_age_ms

    def record(self, success: bool) -> None:
        now = time.time() * 1000.0  # ms since epoch
        self._entries.append(WindowEntry(success=success, timestamp=now))
        self._evict(now)

    def get_stats(self) -> WindowStats:
        now = time.time() * 1000.0
        self._evict(now)
        total = len(self._entries)
        failures = sum(1 for e in self._entries if not e.success)
        successes = total - failures
        failure_rate = (failures / total * 100.0) if total > 0 else 0.0
        return WindowStats(
            total=total,
            failures=failures,
            successes=successes,
            failure_rate=failure_rate,
        )

    def reset(self) -> None:
        self._entries.clear()

    def _evict(self, now: float) -> None:
        cutoff = now - self._max_age_ms
        self._entries = [e for e in self._entries if e.timestamp >= cutoff]
        if len(self._entries) > self._max_size:
            self._entries = self._entries[-self._max_size :]


class CircuitBreaker:
    """
    Three-state circuit breaker protecting LLM provider calls.

    Uses a sliding window to track failure rates and transitions between
    CLOSED, OPEN, and HALF_OPEN states.
    """

    def __init__(self, config: Optional[CircuitBreakerConfig] = None, **kwargs: object) -> None:
        if config is not None:
            self._config = config
        else:
            self._config = CircuitBreakerConfig(**kwargs)  # type: ignore[arg-type]

        self._state = CircuitState.CLOSED
        self._window = SlidingWindow(self._config.window_size, self._config.window_duration_ms)

        self._opened_at: float = 0.0
        self._last_failure_rate: float = 0.0
        self._half_open_successes: int = 0

        # asyncio timer handle for reset timeout (OPEN -> HALF_OPEN)
        self._reset_handle: Optional[asyncio.TimerHandle] = None

    async def execute(
        self,
        request: LLMRequest,
        fn: Callable[[LLMRequest], Awaitable[T]],
    ) -> T:
        """Execute a request through the circuit breaker.

        Raises CircuitOpenError if the circuit is open.
        """
        # Fast-fail if circuit is open
        if self._state == CircuitState.OPEN:
            now = time.time() * 1000.0
            elapsed = now - self._opened_at
            remaining = max(0.0, self._config.reset_timeout_ms - elapsed)

            if elapsed >= self._config.reset_timeout_ms:
                self._transition_to(CircuitState.HALF_OPEN)
            else:
                raise CircuitOpenError(
                    reset_timeout_ms=self._config.reset_timeout_ms,
                    failure_rate=self._last_failure_rate,
                    remaining_ms=remaining,
                )

        start = time.perf_counter()

        try:
            result = await fn(request)
            self._on_success((time.perf_counter() - start) * 1000.0)
            return result
        except BaseException as error:
            latency_ms = (time.perf_counter() - start) * 1000.0

            if self._config.is_failure is not None:
                is_failure = self._config.is_failure(error)
            else:
                is_failure = self._default_is_failure(error)

            if is_failure:
                self._on_failure(latency_ms, error)
            else:
                # Non-failure errors (e.g., 400) count as success for circuit purposes
                self._on_success(latency_ms)

            raise

    @property
    def state(self) -> CircuitState:
        """Current circuit state, checking for expired reset timeout."""
        if (
            self._state == CircuitState.OPEN
            and (time.time() * 1000.0) - self._opened_at >= self._config.reset_timeout_ms
        ):
            self._transition_to(CircuitState.HALF_OPEN)
        return self._state

    def get_state(self) -> CircuitState:
        """Current circuit state (method form for compatibility)."""
        return self.state

    def get_stats(self) -> WindowStats:
        return self._window.get_stats()

    def destroy(self) -> None:
        """Cancel pending timers."""
        if self._reset_handle is not None:
            self._reset_handle.cancel()
            self._reset_handle = None

    def _on_success(self, latency_ms: float) -> None:
        if self._config.on_success is not None:
            self._config.on_success(
                RequestEvent(
                    state=self._state,
                    latency_ms=latency_ms,
                    timestamp=time.time() * 1000.0,
                )
            )

        if self._state == CircuitState.HALF_OPEN:
            self._half_open_successes += 1
            if self._half_open_successes >= self._config.half_open_max_attempts:
                self._transition_to(CircuitState.CLOSED)
        else:
            self._window.record(True)

    def _on_failure(self, latency_ms: float, error: BaseException) -> None:
        if self._config.on_failure is not None:
            self._config.on_failure(
                RequestEvent(
                    state=self._state,
                    latency_ms=latency_ms,
                    timestamp=time.time() * 1000.0,
                    error=error,
                )
            )

        if self._state == CircuitState.HALF_OPEN:
            # Any failure during half-open immediately reopens
            self._transition_to(CircuitState.OPEN)
            return

        self._window.record(False)
        self._evaluate_threshold()

    def _evaluate_threshold(self) -> None:
        if self._state != CircuitState.CLOSED:
            return

        stats = self._window.get_stats()
        if (
            stats.total >= self._config.minimum_requests
            and stats.failure_rate >= self._config.failure_threshold
        ):
            self._last_failure_rate = stats.failure_rate
            self._transition_to(CircuitState.OPEN)

    def _transition_to(self, new_state: CircuitState) -> None:
        from_state = self._state
        if from_state == new_state:
            return

        self._state = new_state

        if new_state == CircuitState.OPEN:
            self._opened_at = time.time() * 1000.0
            self._schedule_reset_timeout()
        elif new_state == CircuitState.HALF_OPEN:
            self._half_open_successes = 0
            self._clear_reset_timer()
        elif new_state == CircuitState.CLOSED:
            self._window.reset()
            self._half_open_successes = 0
            self._clear_reset_timer()

        stats = self._window.get_stats()
        if self._config.on_state_change is not None:
            self._config.on_state_change(
                StateChangeEvent(
                    from_state=from_state,
                    to_state=new_state,
                    failure_rate=(
                        self._last_failure_rate
                        if new_state == CircuitState.OPEN
                        else stats.failure_rate
                    ),
                    timestamp=time.time() * 1000.0,
                )
            )

    def _schedule_reset_timeout(self) -> None:
        self._clear_reset_timer()
        try:
            loop = asyncio.get_running_loop()
            self._reset_handle = loop.call_later(
                self._config.reset_timeout_ms / 1000.0,
                self._on_reset_timeout,
            )
        except RuntimeError:
            # No running event loop — the timeout check in execute/get_state handles this
            pass

    def _on_reset_timeout(self) -> None:
        if self._state == CircuitState.OPEN:
            self._transition_to(CircuitState.HALF_OPEN)

    def _clear_reset_timer(self) -> None:
        if self._reset_handle is not None:
            self._reset_handle.cancel()
            self._reset_handle = None

    @staticmethod
    def _default_is_failure(error: BaseException) -> bool:
        """Default: 5xx = failure, 4xx = non-failure (provider is healthy)."""
        if hasattr(error, "status_code"):
            return error.status_code >= 500  # type: ignore[union-attr]
        # Network errors, timeouts — treat as failures
        return True

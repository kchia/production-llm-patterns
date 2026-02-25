"""
Retry with Budget — RetryWithBudget

Wraps LLM provider calls with exponential backoff, jitter, and a
shared token bucket that caps aggregate retry volume. Prevents retry
storms from amplifying outages while still recovering from transient
failures.

Framework-agnostic. No external dependencies.
"""

from __future__ import annotations

import asyncio
import random
import time
from typing import Awaitable, Callable

from .types import (
    AttemptRecord,
    BudgetExhaustedEvent,
    JitterMode,
    LLMRequest,
    LLMResponse,
    ProviderError,
    RetriesExhaustedError,
    RetryEvent,
    RetryResult,
    RetryWithBudgetConfig,
    TokenBucketConfig,
)

__all__ = [
    "TokenBucket",
    "RetryWithBudget",
    "calculate_backoff",
    "is_retryable_error",
    "ProviderError",
    "RetriesExhaustedError",
]


# ── Token Bucket ──────────────────────────────────────────────────────


class TokenBucket:
    """Token bucket that controls aggregate retry volume.

    Successes add tokens; retries consume tokens. When the bucket drops
    below half capacity, retries are paused. A passive refill task adds
    tokens over time to recover from sustained failures.
    """

    def __init__(self, config: TokenBucketConfig | None = None) -> None:
        cfg = config or TokenBucketConfig()
        self._max_tokens = cfg.max_tokens
        self._token_ratio = cfg.token_ratio
        self._refill_interval_ms = cfg.refill_interval_ms
        self._refill_amount = cfg.refill_amount
        self._tokens: float = self._max_tokens
        # TS uses setInterval + unref() so the timer doesn't keep the process
        # alive. Python's equivalent is an asyncio.Task that we cancel in
        # destroy(). The refill task is opt-in (call start_refill) because
        # asyncio.ensure_future requires a running loop, unlike setInterval.
        self._refill_task: asyncio.Task[None] | None = None
        self._stopped = False

    def start_refill(self, loop: asyncio.AbstractEventLoop | None = None) -> None:
        """Start the passive refill background task."""
        if (
            self._refill_interval_ms <= 0
            or self._refill_amount <= 0
            or self._stopped
        ):
            return
        if self._refill_task is not None:
            return
        self._refill_task = asyncio.ensure_future(self._refill_loop())

    async def _refill_loop(self) -> None:
        interval = self._refill_interval_ms / 1000
        try:
            while not self._stopped:
                await asyncio.sleep(interval)
                self._tokens = min(
                    self._max_tokens, self._tokens + self._refill_amount
                )
        except asyncio.CancelledError:
            pass

    def try_consume(self) -> bool:
        """Try to consume a token for a retry. Returns False if budget is exhausted."""
        # Pause retries when below 50% capacity
        if self._tokens < self._max_tokens * 0.5:
            return False
        if self._tokens < 1:
            return False
        self._tokens -= 1
        return True

    def record_success(self) -> None:
        """Record a successful request, adding tokens back to the bucket."""
        self._tokens = min(self._max_tokens, self._tokens + self._token_ratio)

    # TS exposes remaining() and max() as methods. Python idiom is
    # properties for simple attribute access with no computation.
    @property
    def remaining(self) -> float:
        """Current number of tokens available."""
        return self._tokens

    @property
    def max(self) -> int:
        """Maximum bucket capacity."""
        return self._max_tokens

    def destroy(self) -> None:
        """Cancel the refill task. Call this when done with the bucket."""
        self._stopped = True
        if self._refill_task is not None:
            self._refill_task.cancel()
            self._refill_task = None

    def reset(self) -> None:
        """Reset bucket to full capacity."""
        self._tokens = float(self._max_tokens)


# ── Backoff Calculator ────────────────────────────────────────────────


def calculate_backoff(
    attempt: int,
    initial_delay_ms: float,
    max_delay_ms: float,
    multiplier: float,
    jitter_mode: JitterMode,
) -> float:
    """Calculate backoff delay for a given attempt number."""
    exponential_delay = initial_delay_ms * (multiplier**attempt)
    capped_delay = min(exponential_delay, max_delay_ms)

    if jitter_mode == "full":
        # Uniform random between 0 and the calculated delay.
        # Widest spread — best for preventing correlated retries.
        return random.random() * capped_delay
    elif jitter_mode == "equal":
        # Half fixed + half random. Guarantees a minimum delay.
        return capped_delay / 2 + random.random() * capped_delay / 2
    else:  # "none"
        return capped_delay


# ── Error Classification ──────────────────────────────────────────────


# TS checks error.message with individual .includes() calls. A frozenset
# with `any()` is more Pythonic and avoids repeated string scans.
_NETWORK_ERROR_MARKERS = frozenset(
    {"econnreset", "econnrefused", "etimedout", "socket hang up", "network"}
)


def is_retryable_error(error: Exception, retryable_statuses: list[int]) -> bool:
    """Determine if an error is retryable based on status code."""
    if isinstance(error, ProviderError):
        return error.status_code in retryable_statuses
    # Network-level errors (no status code) are generally retryable
    msg = str(error).lower()
    return any(marker in msg for marker in _NETWORK_ERROR_MARKERS)


def _get_retry_after_ms(error: Exception) -> int | None:
    """Extract Retry-After delay from a ProviderError, if present."""
    if isinstance(error, ProviderError) and error.retry_after_ms:
        return error.retry_after_ms
    return None


# ── Retry Handler ─────────────────────────────────────────────────────


class RetryWithBudget:
    """Execute LLM provider calls with retry logic and budget enforcement."""

    def __init__(self, config: RetryWithBudgetConfig | None = None) -> None:
        cfg = config or RetryWithBudgetConfig()
        self._max_attempts = cfg.max_attempts
        self._initial_delay_ms = cfg.initial_delay_ms
        self._max_delay_ms = cfg.max_delay_ms
        self._backoff_multiplier = cfg.backoff_multiplier
        self._jitter_mode = cfg.jitter_mode
        self._retryable_statuses = list(cfg.retryable_statuses)
        self._on_retry = cfg.on_retry
        self._on_budget_exhausted = cfg.on_budget_exhausted

        bucket_cfg = cfg.budget_config or TokenBucketConfig()
        self._budget = TokenBucket(bucket_cfg)

    async def execute(
        self,
        request: LLMRequest,
        fn: Callable[[LLMRequest], Awaitable[LLMResponse]],
    ) -> RetryResult:
        """Execute a provider call with retry logic and budget enforcement.

        ``fn`` is the actual provider call — it receives the request and
        returns a response. This keeps the retry handler decoupled from
        any specific provider.
        """
        # TS uses performance.now() (ms). Python's perf_counter() returns
        # seconds, so we multiply by 1000 at each measurement point.
        start = time.perf_counter()
        attempts: list[AttemptRecord] = []
        budget_exhausted = False

        for attempt in range(self._max_attempts):
            attempt_start = time.perf_counter()

            try:
                response = await fn(request)
                self._budget.record_success()

                elapsed = (time.perf_counter() - start) * 1000
                return RetryResult(
                    response=response,
                    attempts=attempt + 1,
                    total_latency_ms=elapsed,
                    retries_used=attempt,
                    budget_remaining=self._budget.remaining,
                )
            except Exception as err:
                attempt_latency = (time.perf_counter() - attempt_start) * 1000

                if not is_retryable_error(err, self._retryable_statuses):
                    raise

                # Compute backoff delay, honoring Retry-After if present
                computed_delay = calculate_backoff(
                    attempt,
                    self._initial_delay_ms,
                    self._max_delay_ms,
                    self._backoff_multiplier,
                    self._jitter_mode,
                )
                retry_after = _get_retry_after_ms(err)
                # Honor Retry-After but cap at 2x max_delay_ms
                delay = (
                    min(retry_after, self._max_delay_ms * 2)
                    if retry_after
                    else computed_delay
                )

                attempts.append(
                    AttemptRecord(
                        attempt=attempt,
                        error=err,
                        latency_ms=attempt_latency,
                        delay_ms=delay,
                    )
                )

                # No more attempts available
                if attempt + 1 >= self._max_attempts:
                    break

                # Check retry budget before waiting
                if not self._budget.try_consume():
                    budget_exhausted = True
                    if self._on_budget_exhausted:
                        self._on_budget_exhausted(
                            BudgetExhaustedEvent(
                                attempt=attempt + 1,
                                max_attempts=self._max_attempts,
                                error=err,
                                budget_remaining=self._budget.remaining,
                                budget_max=self._budget.max,
                            )
                        )
                    break

                # Emit retry event
                if self._on_retry:
                    self._on_retry(
                        RetryEvent(
                            attempt=attempt + 1,
                            max_attempts=self._max_attempts,
                            error=err,
                            delay_ms=delay,
                            budget_remaining=self._budget.remaining,
                        )
                    )

                # TS: await sleep(delay) where sleep takes ms.
                # asyncio.sleep takes seconds, so we divide by 1000.
                await asyncio.sleep(delay / 1000)

        elapsed = (time.perf_counter() - start) * 1000
        raise RetriesExhaustedError(attempts, elapsed, budget_exhausted)

    @property
    def budget(self) -> TokenBucket:
        """Access the underlying token bucket for monitoring."""
        return self._budget

    def destroy(self) -> None:
        """Clean up resources (stops the refill task)."""
        self._budget.destroy()

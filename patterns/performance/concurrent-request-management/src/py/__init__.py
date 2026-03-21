"""
Concurrent Request Management — core implementation.

Two independent controls layered:
  1. asyncio.Semaphore — caps in-flight count, preventing connection saturation.
  2. Dual token bucket (RPM + TPM) — prevents provider rate limit exhaustion.

Retries use exponential backoff with ±jitter to desynchronize retry waves
across application instances, preventing thundering-herd re-saturation.
"""

from __future__ import annotations

import asyncio
import random
import time
import uuid
from typing import Any

from .mock_provider import RateLimitError, TransientServerError
from .types import (
    ConcurrencyManagerConfig,
    ConcurrencyMetrics,
    LLMRequest,
    LLMResponse,
    MaxRetriesExceededError,
    TokenBudgetExceededError,
)

__all__ = ["ConcurrencyManager", "DEFAULT_CONFIG"]

DEFAULT_CONFIG = ConcurrencyManagerConfig()


class ConcurrencyManager:
    """
    Manages concurrent LLM requests with semaphore + dual token bucket + jittered retries.
    """

    def __init__(self, config: ConcurrencyManagerConfig | None = None) -> None:
        self._config = config or DEFAULT_CONFIG

        # Semaphore: caps in-flight requests
        self._semaphore = asyncio.Semaphore(self._config.max_concurrent)

        # Rolling window state for RPM + TPM (sliding 60-second window)
        # Each entry is a timestamp (float seconds) of when consumption was recorded.
        self._request_timestamps: list[float] = []
        self._token_timestamps: list[tuple[float, int]] = []  # (ts, tokens)
        self._window_lock = asyncio.Lock()

        # Metrics
        self._total_completed = 0
        self._total_failed = 0
        self._total_rate_limit_hits = 0
        self._total_retries_succeeded = 0

    async def run(self, request: LLMRequest) -> LLMResponse:
        """
        Execute a managed LLM request with concurrency control, rate limiting, and retries.
        Raises MaxRetriesExceededError if all retry attempts fail.
        """
        request_id = request.request_id or f"req-{uuid.uuid4().hex[:8]}"
        estimated_tokens = (
            request.estimated_input_tokens + request.estimated_output_tokens
        )

        # Guard: a single request that exceeds the per-minute token limit can never succeed.
        if estimated_tokens > self._config.max_tokens_per_minute:
            raise TokenBudgetExceededError(
                request_id, estimated_tokens, self._config.max_tokens_per_minute
            )

        last_error: Exception = Exception("Unknown error")

        for attempt in range(1, self._config.max_retries + 1):
            try:
                # Step 1: Acquire semaphore slot (blocks until a slot is free)
                async with self._semaphore:
                    # Step 2: Wait for token bucket capacity (RPM + TPM)
                    await self._wait_for_capacity(estimated_tokens)

                    # Record consumption before the call — prevents over-admission
                    # during the time the call is in flight.
                    await self._record_consumption(estimated_tokens)

                    # Execute the underlying LLM call
                    response = await request.execute()

                    # Adjust token accounting with actual usage if available
                    if response.usage:
                        actual_tokens = (
                            response.usage.input_tokens + response.usage.output_tokens
                        )
                        delta = actual_tokens - estimated_tokens
                        if delta > 0:
                            await self._record_consumption(delta)

                if attempt > 1:
                    self._total_retries_succeeded += 1
                self._total_completed += 1
                return response

            except (TokenBudgetExceededError,) as e:
                # Not retryable — the request itself is too large.
                self._total_failed += 1
                raise

            except Exception as e:
                last_error = e
                is_rate_limit = _is_rate_limit_error(e)
                is_transient = _is_transient_error(e)

                if not is_rate_limit and not is_transient:
                    # Non-retryable (4xx other than 429, auth errors, etc.)
                    self._total_failed += 1
                    raise

                if is_rate_limit:
                    self._total_rate_limit_hits += 1

                if attempt < self._config.max_retries:
                    delay = self._calculate_backoff(attempt, is_rate_limit)
                    await asyncio.sleep(delay)

        self._total_failed += 1
        raise MaxRetriesExceededError(
            request_id, self._config.max_retries, last_error
        )

    async def run_all(self, requests: list[LLMRequest]) -> list[LLMResponse]:
        """Run multiple requests concurrently. Raises on first failure."""
        return list(await asyncio.gather(*[self.run(r) for r in requests]))

    async def run_all_settled(
        self, requests: list[LLMRequest]
    ) -> list[tuple[str, Any]]:
        """
        Run multiple requests concurrently, collecting both successes and failures.
        Returns a list of ('fulfilled', response) or ('rejected', exception) tuples.
        Useful for batch jobs where partial success is acceptable.
        """
        results = await asyncio.gather(
            *[self.run(r) for r in requests], return_exceptions=True
        )
        return [
            ("rejected", r) if isinstance(r, Exception) else ("fulfilled", r)
            for r in results
        ]

    def get_metrics(self) -> ConcurrencyMetrics:
        self._prune_windows()
        tokens_used = sum(t for _, t in self._token_timestamps)
        return ConcurrencyMetrics(
            in_flight=self._config.max_concurrent
            - self._semaphore._value,  # type: ignore[attr-defined]
            tokens_used_this_window=tokens_used,
            requests_used_this_window=len(self._request_timestamps),
            total_completed=self._total_completed,
            total_failed=self._total_failed,
            total_rate_limit_hits=self._total_rate_limit_hits,
            total_retries_succeeded=self._total_retries_succeeded,
        )

    # ─── Token Bucket (sliding window) ───────────────────────────────────────

    async def _wait_for_capacity(self, estimated_tokens: int) -> None:
        """
        Poll until both RPM and TPM capacity is available.

        Polling interval: 100ms. A precise scheduler would require a priority queue;
        polling is simpler and adequate for typical LLM call patterns.
        """
        poll_interval_s = 0.1
        max_wait_s = 70.0  # slightly more than 1 full window
        waited_s = 0.0

        while True:
            async with self._window_lock:
                self._prune_windows()
                requests_ok = (
                    len(self._request_timestamps)
                    < self._config.max_requests_per_minute
                )
                current_tokens = sum(t for _, t in self._token_timestamps)
                tokens_ok = (
                    current_tokens + estimated_tokens
                    <= self._config.max_tokens_per_minute
                )

            if requests_ok and tokens_ok:
                return

            if waited_s >= max_wait_s:
                raise TimeoutError(
                    f"Timed out waiting for rate limit capacity after {waited_s:.1f}s"
                )

            await asyncio.sleep(poll_interval_s)
            waited_s += poll_interval_s

    async def _record_consumption(self, tokens: int) -> None:
        now = time.monotonic()
        async with self._window_lock:
            self._request_timestamps.append(now)
            self._token_timestamps.append((now, tokens))

    def _prune_windows(self) -> None:
        """Remove entries older than the sliding 60-second window."""
        cutoff = time.monotonic() - 60.0
        self._request_timestamps = [
            ts for ts in self._request_timestamps if ts > cutoff
        ]
        self._token_timestamps = [
            (ts, t) for ts, t in self._token_timestamps if ts > cutoff
        ]

    # ─── Retry / Backoff ─────────────────────────────────────────────────────

    def _calculate_backoff(self, attempt: int, is_rate_limit: bool) -> float:
        """
        Exponential backoff with ±jitter.

        Rate limit errors use a 2× multiplier because 429s typically mean
        the quota won't reset for a full minute — recovering faster than the
        quota reset just causes another 429.
        """
        multiplier = 2.0 if is_rate_limit else 1.0
        exponential = (
            self._config.base_retry_delay_s * (2 ** (attempt - 1)) * multiplier
        )
        capped = min(exponential, self._config.max_retry_delay_s)
        jitter = capped * self._config.jitter_factor * random.uniform(-1.0, 1.0)
        return max(0.0, capped + jitter)


# ─── Error Classification ─────────────────────────────────────────────────────


def _is_rate_limit_error(error: Exception) -> bool:
    if isinstance(error, RateLimitError):
        return True
    msg = str(error).lower()
    return "429" in msg or "rate limit" in msg or "too many requests" in msg


def _is_transient_error(error: Exception) -> bool:
    if isinstance(error, TransientServerError):
        return True
    msg = str(error).lower()
    return (
        "503" in msg
        or "500" in msg
        or "service unavailable" in msg
        or "internal server error" in msg
    )

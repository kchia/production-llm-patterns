"""
Retry with Budget — Test Suite

Three categories: unit tests, failure mode tests, integration tests.
All tests use mock provider — no real API calls.
"""

from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest

from retry_with_budget import (
    RetryWithBudget,
    TokenBucket,
    calculate_backoff,
    is_retryable_error,
    ProviderError,
    RetriesExhaustedError,
)
from retry_with_budget.mock_provider import MockProvider, MockProviderConfig
from retry_with_budget.types import (
    BudgetExhaustedEvent,
    LLMRequest,
    RetryEvent,
    RetryWithBudgetConfig,
    TokenBucketConfig,
)


# ── Unit Tests ────────────────────────────────────────────────────────


class TestTokenBucket:
    def test_starts_at_max_capacity(self) -> None:
        bucket = TokenBucket(TokenBucketConfig(max_tokens=50))
        assert bucket.remaining == 50

    def test_consumes_tokens(self) -> None:
        bucket = TokenBucket(TokenBucketConfig(max_tokens=10))
        assert bucket.try_consume() is True
        assert bucket.remaining == 9

    def test_rejects_below_50_percent_threshold(self) -> None:
        bucket = TokenBucket(TokenBucketConfig(max_tokens=10))
        # Drain to exactly 5 (50%)
        for _ in range(5):
            bucket.try_consume()
        assert bucket.remaining == 5
        # At 50%, next consume is allowed (5 >= 10 * 0.5)
        assert bucket.try_consume() is True
        # Now at 4, below 50% — reject
        assert bucket.remaining == 4
        assert bucket.try_consume() is False

    def test_adds_tokens_on_success(self) -> None:
        bucket = TokenBucket(TokenBucketConfig(max_tokens=10, token_ratio=1))
        bucket.try_consume()  # 9
        bucket.record_success()  # 9 + 1 = 10
        assert bucket.remaining == 10

    def test_does_not_exceed_max_on_success(self) -> None:
        bucket = TokenBucket(TokenBucketConfig(max_tokens=10, token_ratio=5))
        bucket.record_success()
        assert bucket.remaining == 10

    def test_reset_restores_capacity(self) -> None:
        bucket = TokenBucket(TokenBucketConfig(max_tokens=10))
        bucket.try_consume()
        bucket.try_consume()
        bucket.reset()
        assert bucket.remaining == 10


class TestCalculateBackoff:
    def test_full_jitter_bounded(self) -> None:
        delay = calculate_backoff(0, 200, 30_000, 2, "full")
        assert 0 <= delay < 200

    def test_respects_max_delay_cap(self) -> None:
        delay = calculate_backoff(20, 200, 1000, 2, "none")
        assert delay == 1000

    def test_exact_exponential_no_jitter(self) -> None:
        assert calculate_backoff(0, 100, 30_000, 2, "none") == 100
        assert calculate_backoff(1, 100, 30_000, 2, "none") == 200
        assert calculate_backoff(2, 100, 30_000, 2, "none") == 400
        assert calculate_backoff(3, 100, 30_000, 2, "none") == 800

    def test_equal_jitter_minimum_half_delay(self) -> None:
        with patch("retry_with_budget.random") as mock_mod:
            mock_mod.random.return_value = 0.0
            delay = calculate_backoff(0, 200, 30_000, 2, "equal")
        assert delay == 100  # 200/2 + 0*200/2


class TestIsRetryableError:
    def test_429_is_retryable(self) -> None:
        err = ProviderError("rate limited", 429)
        assert is_retryable_error(err, [429, 500, 503]) is True

    def test_400_is_not_retryable(self) -> None:
        err = ProviderError("bad request", 400)
        assert is_retryable_error(err, [429, 500, 503]) is False

    def test_401_is_not_retryable(self) -> None:
        err = ProviderError("unauthorized", 401)
        assert is_retryable_error(err, [429, 500, 503]) is False

    def test_network_errors_are_retryable(self) -> None:
        err = Exception("ECONNRESET")
        assert is_retryable_error(err, [429, 500, 503]) is True

    def test_unknown_errors_are_not_retryable(self) -> None:
        err = Exception("something unexpected")
        assert is_retryable_error(err, [429, 500, 503]) is False


# ── Failure Mode Tests ────────────────────────────────────────────────


class TestBudgetExhaustionDuringPartialOutage:
    @pytest.mark.asyncio
    async def test_stops_retrying_when_budget_drained(self) -> None:
        exhausted_events: list[BudgetExhaustedEvent] = []

        handler = RetryWithBudget(
            RetryWithBudgetConfig(
                max_attempts=5,
                initial_delay_ms=1,
                max_delay_ms=5,
                jitter_mode="none",
                budget_config=TokenBucketConfig(
                    max_tokens=4,
                    token_ratio=0.1,
                    refill_interval_ms=0,
                    refill_amount=0,
                ),
                on_budget_exhausted=lambda e: exhausted_events.append(e),
            )
        )

        provider = MockProvider(
            MockProviderConfig(
                latency_ms=0,
                failure_rate=1.0,
                failure_status_code=503,
            )
        )

        with pytest.raises(RetriesExhaustedError):
            await handler.execute(
                LLMRequest(prompt="test"), provider.call
            )

        assert len(exhausted_events) > 0
        assert exhausted_events[0].budget_remaining < 4 * 0.5
        handler.destroy()


class TestRetryAfterHeaderConflict:
    @pytest.mark.asyncio
    async def test_honors_retry_after_over_computed_backoff(self) -> None:
        retry_events: list[RetryEvent] = []

        handler = RetryWithBudget(
            RetryWithBudgetConfig(
                max_attempts=3,
                initial_delay_ms=10,
                max_delay_ms=100,
                jitter_mode="none",
                budget_config=TokenBucketConfig(
                    max_tokens=100, refill_interval_ms=0, refill_amount=0
                ),
                on_retry=lambda e: retry_events.append(e),
            )
        )

        provider = MockProvider(
            MockProviderConfig(
                latency_ms=0,
                error_sequence=[429, "success"],
                retry_after_ms=50,
            )
        )

        result = await handler.execute(
            LLMRequest(prompt="test"), provider.call
        )

        assert result.attempts == 2
        # Delay should be Retry-After value (50ms), not computed backoff (10ms)
        assert retry_events[0].delay_ms == 50
        handler.destroy()

    @pytest.mark.asyncio
    async def test_caps_retry_after_at_2x_max_delay(self) -> None:
        retry_events: list[RetryEvent] = []

        handler = RetryWithBudget(
            RetryWithBudgetConfig(
                max_attempts=3,
                initial_delay_ms=10,
                max_delay_ms=100,
                jitter_mode="none",
                budget_config=TokenBucketConfig(
                    max_tokens=100, refill_interval_ms=0, refill_amount=0
                ),
                on_retry=lambda e: retry_events.append(e),
            )
        )

        provider = MockProvider(
            MockProviderConfig(
                latency_ms=0,
                error_sequence=[429, "success"],
                retry_after_ms=500,
            )
        )

        result = await handler.execute(
            LLMRequest(prompt="test"), provider.call
        )

        assert result.attempts == 2
        assert retry_events[0].delay_ms == 200  # 2 * max_delay_ms
        handler.destroy()


class TestSilentBudgetDrift:
    @pytest.mark.asyncio
    async def test_budget_drains_with_elevated_error_rate(self) -> None:
        handler = RetryWithBudget(
            RetryWithBudgetConfig(
                max_attempts=3,
                initial_delay_ms=1,
                max_delay_ms=5,
                jitter_mode="none",
                budget_config=TokenBucketConfig(
                    max_tokens=20,
                    token_ratio=0.1,
                    refill_interval_ms=0,
                    refill_amount=0,
                ),
            )
        )

        provider = MockProvider(
            MockProviderConfig(
                latency_ms=0,
                failure_rate=0.3,
                failure_status_code=503,
            )
        )

        budget_snapshots: list[float] = []
        for i in range(50):
            try:
                await handler.execute(
                    LLMRequest(prompt=f"test {i}"), provider.call
                )
            except (RetriesExhaustedError, ProviderError):
                pass
            budget_snapshots.append(handler.budget.remaining)

        first_quarter = budget_snapshots[:12]
        last_quarter = budget_snapshots[38:]
        avg_first = sum(first_quarter) / len(first_quarter)
        avg_last = sum(last_quarter) / len(last_quarter)

        assert avg_last <= avg_first
        handler.destroy()


class TestNonRetryableError:
    @pytest.mark.asyncio
    async def test_does_not_retry_400(self) -> None:
        handler = RetryWithBudget(
            RetryWithBudgetConfig(max_attempts=3, initial_delay_ms=1)
        )

        provider = MockProvider(
            MockProviderConfig(latency_ms=0, error_sequence=[400])
        )

        with pytest.raises(ProviderError):
            await handler.execute(
                LLMRequest(prompt="test"), provider.call
            )

        assert provider.call_count == 1
        handler.destroy()

    @pytest.mark.asyncio
    async def test_does_not_retry_401(self) -> None:
        handler = RetryWithBudget(
            RetryWithBudgetConfig(max_attempts=3, initial_delay_ms=1)
        )

        provider = MockProvider(
            MockProviderConfig(latency_ms=0, error_sequence=[401])
        )

        with pytest.raises(ProviderError):
            await handler.execute(
                LLMRequest(prompt="test"), provider.call
            )

        assert provider.call_count == 1
        handler.destroy()


class TestBackoffDelayBounded:
    @pytest.mark.asyncio
    async def test_total_latency_bounded(self) -> None:
        handler = RetryWithBudget(
            RetryWithBudgetConfig(
                max_attempts=3,
                initial_delay_ms=10,
                max_delay_ms=50,
                jitter_mode="none",
                budget_config=TokenBucketConfig(
                    max_tokens=100, refill_interval_ms=0, refill_amount=0
                ),
            )
        )

        provider = MockProvider(
            MockProviderConfig(
                latency_ms=0,
                failure_rate=1.0,
                failure_status_code=503,
            )
        )

        import time

        start = time.perf_counter()
        with pytest.raises(RetriesExhaustedError):
            await handler.execute(
                LLMRequest(prompt="test"), provider.call
            )
        elapsed_ms = (time.perf_counter() - start) * 1000

        # Upper bound: maxAttempts * maxDelayMs + overhead
        assert elapsed_ms < 500
        handler.destroy()


# ── Integration Tests ─────────────────────────────────────────────────


class TestFullRetryFlow:
    @pytest.mark.asyncio
    async def test_retries_503_and_succeeds(self) -> None:
        handler = RetryWithBudget(
            RetryWithBudgetConfig(
                max_attempts=3,
                initial_delay_ms=1,
                max_delay_ms=10,
                budget_config=TokenBucketConfig(
                    max_tokens=100, refill_interval_ms=0, refill_amount=0
                ),
            )
        )

        provider = MockProvider(
            MockProviderConfig(
                latency_ms=0, error_sequence=[503, "success"]
            )
        )

        result = await handler.execute(
            LLMRequest(prompt="Hello world"), provider.call
        )

        assert result.attempts == 2
        assert result.retries_used == 1
        assert "Mock response" in result.response.content
        handler.destroy()

    @pytest.mark.asyncio
    async def test_retries_429_then_503_then_succeeds(self) -> None:
        handler = RetryWithBudget(
            RetryWithBudgetConfig(
                max_attempts=4,
                initial_delay_ms=1,
                max_delay_ms=10,
                budget_config=TokenBucketConfig(
                    max_tokens=100, refill_interval_ms=0, refill_amount=0
                ),
            )
        )

        provider = MockProvider(
            MockProviderConfig(
                latency_ms=0, error_sequence=[429, 503, "success"]
            )
        )

        result = await handler.execute(
            LLMRequest(prompt="test"), provider.call
        )

        assert result.attempts == 3
        assert result.retries_used == 2
        handler.destroy()

    @pytest.mark.asyncio
    async def test_exhausts_all_attempts(self) -> None:
        handler = RetryWithBudget(
            RetryWithBudgetConfig(
                max_attempts=3,
                initial_delay_ms=1,
                max_delay_ms=5,
                jitter_mode="none",
                budget_config=TokenBucketConfig(
                    max_tokens=100, refill_interval_ms=0, refill_amount=0
                ),
            )
        )

        provider = MockProvider(
            MockProviderConfig(
                latency_ms=0,
                failure_rate=1.0,
                failure_status_code=500,
            )
        )

        with pytest.raises(RetriesExhaustedError) as exc_info:
            await handler.execute(
                LLMRequest(prompt="test"), provider.call
            )

        err = exc_info.value
        assert len(err.attempts) > 0
        assert err.total_latency_ms > 0
        handler.destroy()

    @pytest.mark.asyncio
    async def test_fires_on_retry_callback(self) -> None:
        events: list[RetryEvent] = []

        handler = RetryWithBudget(
            RetryWithBudgetConfig(
                max_attempts=3,
                initial_delay_ms=1,
                max_delay_ms=5,
                budget_config=TokenBucketConfig(
                    max_tokens=100, refill_interval_ms=0, refill_amount=0
                ),
                on_retry=lambda e: events.append(e),
            )
        )

        provider = MockProvider(
            MockProviderConfig(
                latency_ms=0, error_sequence=[503, "success"]
            )
        )

        await handler.execute(
            LLMRequest(prompt="test"), provider.call
        )

        assert len(events) == 1
        assert events[0].attempt == 1
        assert events[0].delay_ms >= 0
        handler.destroy()

    @pytest.mark.asyncio
    async def test_budget_recovers_after_drain(self) -> None:
        handler = RetryWithBudget(
            RetryWithBudgetConfig(
                max_attempts=5,
                initial_delay_ms=1,
                max_delay_ms=5,
                jitter_mode="none",
                budget_config=TokenBucketConfig(
                    max_tokens=100,
                    token_ratio=2,  # Aggressive refill for testing
                    refill_interval_ms=0,
                    refill_amount=0,
                ),
            )
        )

        # Drain budget with failures
        fail_provider = MockProvider(
            MockProviderConfig(
                latency_ms=0,
                failure_rate=1.0,
                failure_status_code=503,
            )
        )

        for i in range(10):
            try:
                await handler.execute(
                    LLMRequest(prompt=f"fail {i}"), fail_provider.call
                )
            except RetriesExhaustedError:
                pass

        budget_after_drain = handler.budget.remaining
        assert budget_after_drain < 100

        # Recover with successful requests
        success_provider = MockProvider(MockProviderConfig(latency_ms=0))
        for i in range(30):
            await handler.execute(
                LLMRequest(prompt=f"test {i}"), success_provider.call
            )

        budget_after_recovery = handler.budget.remaining
        assert budget_after_recovery > budget_after_drain
        handler.destroy()

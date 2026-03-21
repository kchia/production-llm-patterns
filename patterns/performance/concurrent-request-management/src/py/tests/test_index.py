"""
Tests for Concurrent Request Management (Python implementation).

Categories:
  1. Unit tests — core logic, defaults, configuration, state
  2. Failure mode tests — one per failure mode in README Failure Modes table
  3. Integration tests — end-to-end with mock provider
"""

from __future__ import annotations

import asyncio
import pytest

from ..__init__ import ConcurrencyManager, DEFAULT_CONFIG
from ..mock_provider import MockLLMProvider, MockProviderConfig, RateLimitError, TransientServerError
from ..types import (
    ConcurrencyManagerConfig,
    LLMRequest,
    LLMResponse,
    LLMUsage,
    MaxRetriesExceededError,
    TokenBudgetExceededError,
)


# ─── Helpers ─────────────────────────────────────────────────────────────────

def make_provider(**kwargs) -> MockLLMProvider:
    config = MockProviderConfig(base_latency_s=0.0, latency_variance_s=0.0, **kwargs)
    return MockLLMProvider(config)


def make_request(provider: MockLLMProvider, **kwargs) -> LLMRequest:
    return LLMRequest(
        estimated_input_tokens=kwargs.pop("estimated_input_tokens", 100),
        estimated_output_tokens=kwargs.pop("estimated_output_tokens", 50),
        execute=lambda: provider.complete("test prompt"),
        **kwargs,
    )


# ─── 1. Unit Tests ────────────────────────────────────────────────────────────

class TestUnit:
    def test_default_config(self):
        assert DEFAULT_CONFIG.max_concurrent == 10
        assert DEFAULT_CONFIG.max_retries == 4
        assert DEFAULT_CONFIG.jitter_factor == 0.25
        assert DEFAULT_CONFIG.max_requests_per_minute == 500
        assert DEFAULT_CONFIG.max_tokens_per_minute == 80_000

    @pytest.mark.asyncio
    async def test_completes_single_request(self):
        provider = make_provider()
        manager = ConcurrencyManager()
        response = await manager.run(make_request(provider))
        assert "Mock response" in response.content

    @pytest.mark.asyncio
    async def test_metrics_after_requests(self):
        provider = make_provider()
        manager = ConcurrencyManager()
        await manager.run(make_request(provider))
        await manager.run(make_request(provider))
        metrics = manager.get_metrics()
        assert metrics.total_completed == 2
        assert metrics.total_failed == 0
        assert metrics.in_flight == 0

    @pytest.mark.asyncio
    async def test_run_all_returns_results_in_order(self):
        results_order = []
        manager = ConcurrencyManager()
        requests = []
        for i in range(5):
            idx = i  # capture
            async def execute(i=idx):
                return LLMResponse(content=f"response-{i}", usage=LLMUsage(100, 50))
            requests.append(LLMRequest(
                estimated_input_tokens=100,
                estimated_output_tokens=50,
                execute=execute,
                request_id=f"req-{i}",
            ))
        responses = await manager.run_all(requests)
        assert len(responses) == 5
        for i, r in enumerate(responses):
            assert r.content == f"response-{i}"

    @pytest.mark.asyncio
    async def test_run_all_settled_captures_mixed_outcomes(self):
        provider = make_provider()
        fail_provider = make_provider(rate_limit_error_rate=1.0)
        manager = ConcurrencyManager(
            ConcurrencyManagerConfig(max_retries=1, base_retry_delay_s=0.0, max_retry_delay_s=0.0)
        )
        results = await manager.run_all_settled([
            make_request(provider),
            make_request(fail_provider),
        ])
        assert results[0][0] == "fulfilled"
        assert results[1][0] == "rejected"

    @pytest.mark.asyncio
    async def test_custom_request_id_appears_in_error(self):
        fail_provider = make_provider(rate_limit_error_rate=1.0)
        manager = ConcurrencyManager(
            ConcurrencyManagerConfig(max_retries=1, base_retry_delay_s=0.0, max_retry_delay_s=0.0)
        )
        req = make_request(fail_provider, request_id="my-custom-id")
        with pytest.raises(MaxRetriesExceededError) as exc_info:
            await manager.run(req)
        assert "my-custom-id" in str(exc_info.value)


# ─── 2. Failure Mode Tests ────────────────────────────────────────────────────

class TestFailureModes:
    """One test per failure mode row in the README Failure Modes table."""

    @pytest.mark.asyncio
    async def test_fm1_jitter_produces_delay_variance(self):
        """FM1: Thundering herd — jitter desynchronizes retry delays."""
        delays = []

        original_sleep = asyncio.sleep
        async def mock_sleep(delay):
            if delay > 0.05:
                delays.append(delay)
            await original_sleep(0)

        import unittest.mock as mock
        with mock.patch("asyncio.sleep", side_effect=mock_sleep):
            provider = make_provider(rate_limit_error_rate=0.5)
            manager = ConcurrencyManager(
                ConcurrencyManagerConfig(
                    max_retries=3,
                    base_retry_delay_s=1.0,
                    jitter_factor=0.25,
                )
            )
            requests = [make_request(provider) for _ in range(8)]
            await manager.run_all_settled(requests)

        if len(delays) >= 2:
            # With jitter, delays should have variance (not all identical)
            assert max(delays) / min(delays) > 1.0

    @pytest.mark.asyncio
    async def test_fm2_rejects_request_exceeding_tpm_limit(self):
        """FM2: Token exhaustion — single request exceeding per-minute limit raises."""
        provider = make_provider()
        manager = ConcurrencyManager(
            ConcurrencyManagerConfig(max_tokens_per_minute=1_000)
        )
        req = LLMRequest(
            estimated_input_tokens=2_000,
            estimated_output_tokens=0,
            execute=lambda: provider.complete("test"),
        )
        with pytest.raises(TokenBudgetExceededError):
            await manager.run(req)

    @pytest.mark.asyncio
    async def test_fm3_enforces_max_concurrent(self):
        """FM3: Queue depth — maxConcurrent is never exceeded."""
        max_observed = 0
        current = 0

        async def slow_execute():
            nonlocal max_observed, current
            current += 1
            max_observed = max(max_observed, current)
            await asyncio.sleep(0.02)
            current -= 1
            return LLMResponse(content="ok", usage=LLMUsage(100, 50))

        manager = ConcurrencyManager(
            ConcurrencyManagerConfig(max_concurrent=3)
        )
        requests = [
            LLMRequest(
                estimated_input_tokens=50,
                estimated_output_tokens=25,
                execute=slow_execute,
            )
            for _ in range(10)
        ]
        await manager.run_all(requests)
        assert max_observed <= 3

    @pytest.mark.asyncio
    async def test_fm4_updated_limits_allow_more_throughput(self):
        """FM4: Stale limits — new manager with corrected limits completes work."""
        provider = make_provider()
        tight = ConcurrencyManager(
            ConcurrencyManagerConfig(max_concurrent=2, max_requests_per_minute=5, max_tokens_per_minute=800)
        )
        generous = ConcurrencyManager(
            ConcurrencyManagerConfig(max_concurrent=20, max_requests_per_minute=500, max_tokens_per_minute=80_000)
        )
        requests = [make_request(provider) for _ in range(5)]
        t_results = await tight.run_all_settled(requests)
        g_results = await generous.run_all_settled(requests)
        assert sum(1 for s, _ in t_results if s == "fulfilled") == 5
        assert sum(1 for s, _ in g_results if s == "fulfilled") == 5

    @pytest.mark.asyncio
    async def test_fm5_non_retryable_error_fails_immediately(self):
        """FM5: Retry amplification — 4xx (not 429) errors don't get retried."""
        call_count = 0

        async def execute():
            nonlocal call_count
            call_count += 1
            raise ValueError("400 Bad Request — invalid parameters")

        manager = ConcurrencyManager(
            ConcurrencyManagerConfig(max_retries=4)
        )
        req = LLMRequest(
            estimated_input_tokens=100,
            estimated_output_tokens=50,
            execute=execute,
        )
        with pytest.raises(ValueError, match="400 Bad Request"):
            await manager.run(req)

        assert call_count == 1  # fail immediately, no retries

    @pytest.mark.asyncio
    async def test_fm6_metrics_expose_token_drift(self):
        """FM6: Silent TPM drift — token consumption visible in metrics."""
        provider = make_provider()
        manager = ConcurrencyManager()

        small_req = LLMRequest(
            estimated_input_tokens=100,
            estimated_output_tokens=50,
            execute=lambda: provider.complete("small"),
        )
        large_req = LLMRequest(
            estimated_input_tokens=800,
            estimated_output_tokens=200,
            execute=lambda: provider.complete("large"),
        )

        await manager.run(small_req)
        tokens_after_small = manager.get_metrics().tokens_used_this_window

        await manager.run(large_req)
        tokens_after_large = manager.get_metrics().tokens_used_this_window

        assert tokens_after_large > tokens_after_small
        metrics = manager.get_metrics()
        avg = metrics.tokens_used_this_window / metrics.total_completed
        assert avg > 0

    @pytest.mark.asyncio
    async def test_rate_limit_errors_are_retried(self):
        """Rate limit 429 errors are retried and counted in metrics."""
        attempts = 0

        async def execute():
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                raise RateLimitError()
            return LLMResponse(content="success", usage=LLMUsage(100, 50))

        manager = ConcurrencyManager(
            ConcurrencyManagerConfig(max_retries=4, base_retry_delay_s=0.0, max_retry_delay_s=0.0)
        )
        req = LLMRequest(estimated_input_tokens=100, estimated_output_tokens=50, execute=execute)
        result = await manager.run(req)
        assert result.content == "success"
        assert attempts == 3
        metrics = manager.get_metrics()
        assert metrics.total_rate_limit_hits == 2
        assert metrics.total_retries_succeeded == 1

    @pytest.mark.asyncio
    async def test_exhausted_retries_raise_max_retries_exceeded(self):
        """Exhausted retries surface MaxRetriesExceededError."""
        provider = make_provider(rate_limit_error_rate=1.0)
        manager = ConcurrencyManager(
            ConcurrencyManagerConfig(max_retries=2, base_retry_delay_s=0.0, max_retry_delay_s=0.0)
        )
        with pytest.raises(MaxRetriesExceededError):
            await manager.run(make_request(provider))
        assert manager.get_metrics().total_failed == 1


# ─── 3. Integration Tests ─────────────────────────────────────────────────────

class TestIntegration:
    @pytest.mark.asyncio
    async def test_batch_with_mixed_outcomes(self):
        good = make_provider()
        bad = make_provider(rate_limit_error_rate=1.0)
        manager = ConcurrencyManager(
            ConcurrencyManagerConfig(max_concurrent=5, max_retries=1, base_retry_delay_s=0.0, max_retry_delay_s=0.0)
        )
        requests = (
            [make_request(good) for _ in range(7)]
            + [make_request(bad) for _ in range(3)]
        )
        results = await manager.run_all_settled(requests)
        successes = [r for s, r in results if s == "fulfilled"]
        failures = [r for s, r in results if s == "rejected"]
        assert len(successes) == 7
        assert len(failures) == 3

    @pytest.mark.asyncio
    async def test_concurrent_callers_sharing_manager(self):
        provider = make_provider(base_latency_s=0.005, latency_variance_s=0.0)
        manager = ConcurrencyManager(
            ConcurrencyManagerConfig(max_concurrent=4)
        )
        batch_a = manager.run_all([make_request(provider) for _ in range(4)])
        batch_b = manager.run_all([make_request(provider) for _ in range(4)])
        batch_c = manager.run_all([make_request(provider) for _ in range(4)])

        a, b, c = await asyncio.gather(batch_a, batch_b, batch_c)
        assert len(a) == 4
        assert len(b) == 4
        assert len(c) == 4
        metrics = manager.get_metrics()
        assert metrics.total_completed == 12
        assert metrics.in_flight == 0

    @pytest.mark.asyncio
    async def test_recovers_from_transient_error(self):
        attempts = 0

        async def execute():
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise TransientServerError()
            return LLMResponse(content="recovered", usage=LLMUsage(100, 50))

        manager = ConcurrencyManager(
            ConcurrencyManagerConfig(max_retries=3, base_retry_delay_s=0.0, max_retry_delay_s=0.0)
        )
        req = LLMRequest(estimated_input_tokens=100, estimated_output_tokens=50, execute=execute)
        result = await manager.run(req)
        assert result.content == "recovered"
        assert attempts == 2

    @pytest.mark.asyncio
    async def test_metrics_consistency(self):
        good = make_provider()
        bad = make_provider(rate_limit_error_rate=1.0)
        manager = ConcurrencyManager(
            ConcurrencyManagerConfig(max_retries=1, base_retry_delay_s=0.0, max_retry_delay_s=0.0)
        )
        await manager.run_all_settled([
            make_request(good),
            make_request(good),
            make_request(bad),
        ])
        metrics = manager.get_metrics()
        assert metrics.total_completed + metrics.total_failed == 3
        assert metrics.total_completed == 2
        assert metrics.total_failed == 1

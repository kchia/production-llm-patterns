"""
Multi-Provider Failover — Test Suite

Three test categories: unit tests, failure mode tests, integration tests.
Mirrors the TypeScript test suite's behavior, using Python idioms.
"""

from __future__ import annotations

import asyncio

import pytest

from .. import FailoverRouter, classify_error
from ..mock_provider import MockProvider, create_failing_provider
from ..types import (
    AllProvidersExhaustedError,
    LLMRequest,
    ProviderConfig,
    ProviderError,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

REQ = LLMRequest(prompt="test prompt")


def make_provider(
    name: str,
    *,
    latency_ms: float = 5,
    failure_rate: float = 0.0,
    failure_status_code: int = 503,
) -> MockProvider:
    return MockProvider(
        name,
        latency_ms=latency_ms,
        failure_rate=failure_rate,
        failure_status_code=failure_status_code,
    )


def cfg(provider: MockProvider, **kwargs: object) -> ProviderConfig:
    """Shorthand to build a ProviderConfig from a MockProvider."""
    return ProviderConfig(name=provider.name, handler=provider.handle, **kwargs)


# ---------------------------------------------------------------------------
# Unit tests — core logic
# ---------------------------------------------------------------------------


class TestFailoverRouterUnit:
    async def test_routes_to_primary_on_success(self):
        primary = make_provider("primary")
        backup = make_provider("backup")

        router = FailoverRouter([cfg(primary), cfg(backup)], timeout=5.0)

        result = await router.complete(REQ)
        assert result.provider == "primary"
        assert result.failover_occurred is False
        assert len(result.attempts) == 1
        assert "primary" in result.response.content

    async def test_fails_over_on_503(self):
        primary = make_provider("primary", failure_rate=1.0, failure_status_code=503)
        backup = make_provider("backup")

        router = FailoverRouter([cfg(primary), cfg(backup)], timeout=5.0)

        result = await router.complete(REQ)
        assert result.provider == "backup"
        assert result.failover_occurred is True
        assert len(result.attempts) == 2
        assert result.attempts[0].status == "failover"
        assert result.attempts[1].status == "success"

    async def test_respects_priority_ordering(self):
        low = make_provider("low-priority")
        high = make_provider("high-priority")

        router = FailoverRouter(
            [cfg(low, priority=10), cfg(high, priority=1)],
            timeout=5.0,
        )

        result = await router.complete(REQ)
        assert result.provider == "high-priority"

    async def test_raises_all_providers_exhausted(self):
        p1 = make_provider("p1", failure_rate=1.0, failure_status_code=500)
        p2 = make_provider("p2", failure_rate=1.0, failure_status_code=502)

        router = FailoverRouter([cfg(p1), cfg(p2)], timeout=5.0)

        with pytest.raises(AllProvidersExhaustedError):
            await router.complete(REQ)

    async def test_stops_immediately_on_fatal_error(self):
        primary = create_failing_provider("primary", 400)
        backup = make_provider("backup")

        router = FailoverRouter([cfg(primary), cfg(backup)], timeout=5.0)

        with pytest.raises(AllProvidersExhaustedError) as exc_info:
            await router.complete(REQ)

        err = exc_info.value
        assert len(err.attempts) == 1
        assert err.attempts[0].provider == "primary"
        assert err.attempts[0].error_category == "fatal"

    async def test_respects_max_failovers(self):
        p1 = make_provider("p1", failure_rate=1.0, failure_status_code=503)
        p2 = make_provider("p2", failure_rate=1.0, failure_status_code=503)
        p3 = make_provider("p3")

        router = FailoverRouter(
            [cfg(p1), cfg(p2), cfg(p3)],
            timeout=5.0,
            max_failovers=1,
        )

        with pytest.raises(AllProvidersExhaustedError):
            await router.complete(REQ)

    async def test_total_latency_tracked(self):
        primary = make_provider("primary", failure_rate=1.0, failure_status_code=503, latency_ms=20)
        backup = make_provider("backup", latency_ms=20)

        router = FailoverRouter([cfg(primary), cfg(backup)], timeout=5.0)

        result = await router.complete(REQ)
        assert result.total_latency_ms > 0
        assert len(result.attempts) == 2

    async def test_requires_at_least_one_provider(self):
        with pytest.raises(ValueError, match="At least one provider"):
            FailoverRouter([])

    async def test_reports_health_correctly(self):
        primary = make_provider("primary")
        router = FailoverRouter([cfg(primary)], timeout=5.0)

        health = router.get_provider_health()
        assert health["primary"].status == "unknown"

        await router.complete(REQ)

        health = router.get_provider_health()
        assert health["primary"].status == "healthy"
        assert health["primary"].success_rate == 1.0

    async def test_resets_provider_health(self):
        primary = make_provider("primary", failure_rate=1.0, failure_status_code=503)
        backup = make_provider("backup")

        router = FailoverRouter(
            [cfg(primary), cfg(backup)],
            timeout=5.0,
            window_size=3,
            failure_threshold=0.5,
        )

        for _ in range(4):
            await router.complete(REQ)

        assert router.get_provider_health()["primary"].status == "cooldown"

        router.reset_provider("primary")

        health = router.get_provider_health()
        assert health["primary"].status == "unknown"
        assert health["primary"].consecutive_failures == 0


# ---------------------------------------------------------------------------
# Error classification tests
# ---------------------------------------------------------------------------


class TestClassifyError:
    def test_429_is_retryable(self):
        assert classify_error(ProviderError("rate limit", 429, "openai")) == "retryable"

    def test_529_is_retryable(self):
        assert classify_error(ProviderError("overloaded", 529, "anthropic")) == "retryable"

    def test_503_is_failover(self):
        assert classify_error(ProviderError("unavailable", 503, "openai")) == "failover"

    def test_500_is_failover(self):
        assert classify_error(ProviderError("internal", 500, "openai")) == "failover"

    def test_timeout_is_failover(self):
        assert classify_error(ProviderError("timeout", 0, "openai", is_timeout=True)) == "failover"

    def test_400_is_fatal(self):
        assert classify_error(ProviderError("bad request", 400, "openai")) == "fatal"

    def test_401_is_fatal(self):
        assert classify_error(ProviderError("unauthorized", 401, "openai")) == "fatal"

    def test_403_is_fatal(self):
        assert classify_error(ProviderError("forbidden", 403, "openai")) == "fatal"

    def test_unknown_error_is_failover(self):
        assert classify_error(RuntimeError("something unexpected")) == "failover"

    def test_network_error_is_failover(self):
        assert classify_error(OSError("ECONNREFUSED")) == "failover"


# ---------------------------------------------------------------------------
# Failure mode tests — one per failure mode from the README
# ---------------------------------------------------------------------------


class TestFailureModeCascadingStorm:
    async def test_limits_failover_attempts(self):
        providers = [
            make_provider(f"p{i}", failure_rate=1.0, failure_status_code=503)
            for i in range(5)
        ]

        router = FailoverRouter(
            [cfg(p) for p in providers],
            timeout=5.0,
            max_failovers=2,
        )

        with pytest.raises(AllProvidersExhaustedError) as exc_info:
            await router.complete(REQ)
        # initial + 2 failovers = 3 attempts max
        assert len(exc_info.value.attempts) <= 3


class TestFailureModeCooldownOscillation:
    async def test_enters_cooldown_after_sustained_failures(self):
        primary = make_provider("primary", failure_rate=1.0, failure_status_code=503)
        backup = make_provider("backup")

        cooldown_events: list[tuple[str, bool]] = []

        router = FailoverRouter(
            [cfg(primary), cfg(backup)],
            timeout=5.0,
            window_size=3,
            failure_threshold=0.5,
            on_provider_cooldown=lambda p, entering: cooldown_events.append((p, entering)),
        )

        for _ in range(4):
            await router.complete(REQ)

        assert any(p == "primary" and entering for p, entering in cooldown_events)
        assert router.get_provider_health()["primary"].status == "cooldown"


class TestFailureModeErrorMisclassification:
    async def test_no_failover_on_400(self):
        primary = create_failing_provider("primary", 400)
        backup = make_provider("backup")

        failover_events: list[str] = []

        router = FailoverRouter(
            [cfg(primary), cfg(backup)],
            timeout=5.0,
            on_failover=lambda f, t, e: failover_events.append(f"{f}->{t}"),
        )

        with pytest.raises(AllProvidersExhaustedError):
            await router.complete(REQ)
        assert len(failover_events) == 0
        assert backup.request_count == 0


class TestFailureModeSilentQualityDegradation:
    async def test_reports_serving_provider(self):
        primary = make_provider("primary", failure_rate=1.0, failure_status_code=503)
        backup = make_provider("backup")

        router = FailoverRouter([cfg(primary), cfg(backup)], timeout=5.0)

        result = await router.complete(REQ)
        assert result.provider == "backup"
        assert result.failover_occurred is True


class TestFailureModeTimeoutAmplification:
    async def test_per_provider_timeout_caps_total_latency(self):
        slow1 = MockProvider("slow1", latency_ms=10_000)
        slow2 = MockProvider("slow2", latency_ms=10_000)
        fast = make_provider("fast")

        router = FailoverRouter(
            [cfg(slow1, timeout=0.05), cfg(slow2, timeout=0.05), cfg(fast)],
            timeout=5.0,
        )

        import time
        start = time.perf_counter()
        result = await router.complete(REQ)
        elapsed = (time.perf_counter() - start) * 1000

        assert result.provider == "fast"
        assert elapsed < 1000  # 2 × 50ms timeout + fast response, not 20s


class TestFailureModeStaleHealthState:
    async def test_retries_provider_after_cooldown_expires(self):
        primary = make_provider("primary", failure_rate=1.0, failure_status_code=503)
        backup = make_provider("backup")

        router = FailoverRouter(
            [cfg(primary), cfg(backup)],
            timeout=5.0,
            cooldown_s=0.05,  # 50ms cooldown
            window_size=3,
            failure_threshold=0.5,
        )

        # Trigger cooldown
        for _ in range(4):
            await router.complete(REQ)
        assert router.get_provider_health()["primary"].status == "cooldown"

        # Wait for cooldown to expire
        await asyncio.sleep(0.06)

        # Primary recovers
        primary.update_config(failure_rate=0)

        result = await router.complete(REQ)
        assert result.provider == "primary"


# ---------------------------------------------------------------------------
# Integration tests — full flow
# ---------------------------------------------------------------------------


class TestIntegrationFullFlow:
    async def test_primary_failure_cooldown_recovery(self):
        primary = MockProvider("primary", latency_ms=5, failure_rate=0)
        backup = MockProvider("backup", latency_ms=5, failure_rate=0)

        failover_log: list[str] = []

        router = FailoverRouter(
            [cfg(primary), cfg(backup)],
            timeout=5.0,
            cooldown_s=0.05,
            window_size=3,
            failure_threshold=0.5,
            on_failover=lambda f, t, e: failover_log.append(f"{f}->{t}"),
        )

        # Phase 1: Normal — primary handles everything
        r1 = await router.complete(REQ)
        assert r1.provider == "primary"
        assert r1.failover_occurred is False

        # Phase 2: Primary starts failing
        primary.update_config(failure_rate=1.0, failure_status_code=503)

        for _ in range(4):
            result = await router.complete(REQ)
            assert result.provider == "backup"

        assert router.get_provider_health()["primary"].status == "cooldown"
        assert len(failover_log) > 0

        # Phase 3: During cooldown, requests go straight to backup
        r3 = await router.complete(REQ)
        assert r3.provider == "backup"
        assert len(r3.attempts) == 1

        # Phase 4: Primary recovers, cooldown expires
        primary.update_config(failure_rate=0)
        await asyncio.sleep(0.06)

        r4 = await router.complete(REQ)
        assert r4.provider == "primary"
        assert r4.failover_occurred is False

    async def test_concurrent_requests_during_failover(self):
        primary = MockProvider("primary", latency_ms=5, failure_rate=1.0, failure_status_code=503)
        backup = MockProvider("backup", latency_ms=5)

        router = FailoverRouter([cfg(primary), cfg(backup)], timeout=5.0)

        results = await asyncio.gather(
            *(router.complete(REQ) for _ in range(10))
        )

        for result in results:
            assert result.provider == "backup"
            assert result.failover_occurred is True

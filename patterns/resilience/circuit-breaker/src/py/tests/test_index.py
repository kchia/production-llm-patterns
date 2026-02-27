"""Circuit Breaker tests — unit, failure mode, and integration."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from .. import (
    CircuitBreaker,
    CircuitBreakerConfig,
    CircuitOpenError,
    CircuitState,
    LLMRequest,
    MockProvider,
    MockProviderConfig,
    ProviderError,
    SlidingWindow,
)

REQ = LLMRequest(prompt="test")


# --- Helpers ---


async def send_successes(breaker: CircuitBreaker, provider: MockProvider, count: int) -> None:
    for _ in range(count):
        await breaker.execute(REQ, provider.call)


async def send_failures(breaker: CircuitBreaker, provider: MockProvider, count: int) -> int:
    sent = 0
    for _ in range(count):
        try:
            await breaker.execute(REQ, provider.call)
        except Exception:
            pass
        sent += 1
    return sent


async def trip_circuit(
    breaker: CircuitBreaker, provider: MockProvider, max_attempts: int = 50
) -> int:
    """Trip the circuit by sending failures until it opens. Returns provider call count delta."""
    start_count = provider.call_count
    for _ in range(max_attempts):
        if breaker.get_state() == CircuitState.OPEN:
            break
        try:
            await breaker.execute(REQ, provider.call)
        except Exception:
            pass
    return provider.call_count - start_count


# =====================================================
# 1. UNIT TESTS
# =====================================================


class TestSlidingWindow:
    def test_computes_failure_rate(self) -> None:
        win = SlidingWindow(100, 60_000)
        win.record(True)
        win.record(True)
        win.record(False)
        stats = win.get_stats()
        assert stats.total == 3
        assert stats.failures == 1
        assert abs(stats.failure_rate - 33.33) < 0.1

    @pytest.mark.asyncio
    async def test_evicts_old_entries(self) -> None:
        win = SlidingWindow(100, 50)  # 50ms window
        win.record(False)
        await asyncio.sleep(0.08)
        win.record(True)
        stats = win.get_stats()
        assert stats.total == 1
        assert stats.failures == 0

    def test_trims_to_max_size(self) -> None:
        win = SlidingWindow(3, 60_000)
        win.record(False)  # will be evicted
        win.record(True)
        win.record(True)
        win.record(True)
        stats = win.get_stats()
        assert stats.total == 3
        assert stats.failures == 0  # oldest (failure) was trimmed

    def test_zero_failure_rate_empty(self) -> None:
        win = SlidingWindow(100, 60_000)
        assert win.get_stats().failure_rate == 0

    def test_reset(self) -> None:
        win = SlidingWindow(100, 60_000)
        win.record(False)
        win.record(False)
        win.reset()
        assert win.get_stats().total == 0


class TestCircuitBreakerUnit:
    @pytest.fixture(autouse=True)
    def _cleanup(self) -> Any:
        self.breakers: list[CircuitBreaker] = []
        yield
        for b in self.breakers:
            b.destroy()

    def _make(self, **kwargs: Any) -> CircuitBreaker:
        b = CircuitBreaker(CircuitBreakerConfig(**kwargs))
        self.breakers.append(b)
        return b

    def test_starts_closed(self) -> None:
        breaker = self._make()
        assert breaker.get_state() == CircuitState.CLOSED

    @pytest.mark.asyncio
    async def test_passes_successful_requests(self) -> None:
        breaker = self._make()
        provider = MockProvider(MockProviderConfig(latency_ms=0))
        await send_successes(breaker, provider, 20)
        assert breaker.get_state() == CircuitState.CLOSED
        assert provider.call_count == 20

    @pytest.mark.asyncio
    async def test_default_configuration(self) -> None:
        breaker = self._make()
        stats = breaker.get_stats()
        assert stats.total == 0
        assert breaker.get_state() == CircuitState.CLOSED

    @pytest.mark.asyncio
    async def test_respects_custom_config(self) -> None:
        breaker = self._make(failure_threshold=30, minimum_requests=5, reset_timeout_ms=1000)
        provider = MockProvider(
            MockProviderConfig(
                latency_ms=0,
                error_sequence=[503, 503, "success", "success", "success", "success", "success"],
            )
        )

        # 2 failures + 5 successes = 7 requests, ~28.6% < 30%
        await send_failures(breaker, provider, 2)
        await send_successes(breaker, provider, 5)
        assert breaker.get_state() == CircuitState.CLOSED

    @pytest.mark.asyncio
    async def test_4xx_non_failure(self) -> None:
        breaker = self._make(minimum_requests=3)
        provider = MockProvider(
            MockProviderConfig(
                latency_ms=0,
                error_sequence=[400, 400, 400, 400, 400, 400, 400, 400, 400, 400],
            )
        )

        await send_failures(breaker, provider, 10)
        assert breaker.get_state() == CircuitState.CLOSED

    @pytest.mark.asyncio
    async def test_custom_is_failure(self) -> None:
        def only_503(err: BaseException) -> bool:
            return hasattr(err, "status_code") and err.status_code == 503  # type: ignore[union-attr]

        breaker = self._make(minimum_requests=3, failure_threshold=50, is_failure=only_503)
        provider = MockProvider(
            MockProviderConfig(
                latency_ms=0,
                error_sequence=[429, 429, 429, 429, 429, 429, 429, 429, 429, 429],
            )
        )

        await send_failures(breaker, provider, 10)
        assert breaker.get_state() == CircuitState.CLOSED

    @pytest.mark.asyncio
    async def test_callbacks(self) -> None:
        successes: list[Any] = []
        failures: list[Any] = []

        breaker = self._make(
            on_success=lambda e: successes.append(e),
            on_failure=lambda e: failures.append(e),
        )
        provider = MockProvider(
            MockProviderConfig(latency_ms=0, error_sequence=["success", 503])
        )

        await breaker.execute(REQ, provider.call)
        with pytest.raises(ProviderError):
            await breaker.execute(REQ, provider.call)

        assert len(successes) == 1
        assert len(failures) == 1


# =====================================================
# 2. FAILURE MODE TESTS
# =====================================================


class TestFailureModes:
    @pytest.fixture(autouse=True)
    def _cleanup(self) -> Any:
        self.breakers: list[CircuitBreaker] = []
        yield
        for b in self.breakers:
            b.destroy()

    def _make(self, **kwargs: Any) -> CircuitBreaker:
        b = CircuitBreaker(CircuitBreakerConfig(**kwargs))
        self.breakers.append(b)
        return b

    @pytest.mark.asyncio
    async def test_fm1_trips_on_systemic_failure(self) -> None:
        changes: list[dict[str, CircuitState]] = []
        breaker = self._make(
            failure_threshold=50,
            minimum_requests=5,
            reset_timeout_ms=5000,
            on_state_change=lambda e: changes.append(
                {"from": e.from_state, "to": e.to_state}
            ),
        )
        provider = MockProvider(
            MockProviderConfig(latency_ms=0, failure_rate=1.0, failure_status_code=503)
        )

        await trip_circuit(breaker, provider)
        assert breaker.get_state() == CircuitState.OPEN
        assert {"from": CircuitState.CLOSED, "to": CircuitState.OPEN} in changes

    @pytest.mark.asyncio
    async def test_fm1_minimum_requests_prevents_false_open(self) -> None:
        breaker = self._make(failure_threshold=50, minimum_requests=10)
        provider = MockProvider(
            MockProviderConfig(latency_ms=0, error_sequence=[503, 503, 503])
        )

        await send_failures(breaker, provider, 3)
        assert breaker.get_state() == CircuitState.CLOSED

    @pytest.mark.asyncio
    async def test_fm2_fast_fail_during_open(self) -> None:
        breaker = self._make(
            failure_threshold=50, minimum_requests=5, reset_timeout_ms=60_000
        )
        provider = MockProvider(
            MockProviderConfig(latency_ms=0, failure_rate=1.0, failure_status_code=503)
        )

        provider_calls = await trip_circuit(breaker, provider)
        assert breaker.get_state() == CircuitState.OPEN
        assert provider_calls >= 5

        calls_after_open = provider.call_count

        errors: list[CircuitOpenError] = []
        for _ in range(100):
            try:
                await breaker.execute(REQ, provider.call)
            except CircuitOpenError as e:
                errors.append(e)
            except Exception:
                pass

        assert len(errors) == 100
        assert errors[0].remaining_ms > 0
        assert provider.call_count == calls_after_open

    @pytest.mark.asyncio
    async def test_fm3_transitions_to_half_open(self) -> None:
        breaker = self._make(
            failure_threshold=50,
            minimum_requests=5,
            reset_timeout_ms=100,
            half_open_max_attempts=1,
        )
        provider = MockProvider(
            MockProviderConfig(latency_ms=0, failure_rate=1.0, failure_status_code=503)
        )

        await trip_circuit(breaker, provider)
        assert breaker.get_state() == CircuitState.OPEN

        provider.update_config(failure_rate=0)

        await asyncio.sleep(0.15)
        assert breaker.get_state() == CircuitState.HALF_OPEN

        await breaker.execute(REQ, provider.call)
        assert breaker.get_state() == CircuitState.CLOSED

    @pytest.mark.asyncio
    async def test_fm3_half_open_failure_reopens(self) -> None:
        breaker = self._make(
            failure_threshold=50,
            minimum_requests=5,
            reset_timeout_ms=100,
            half_open_max_attempts=3,
        )
        provider = MockProvider(
            MockProviderConfig(latency_ms=0, failure_rate=1.0, failure_status_code=503)
        )

        await trip_circuit(breaker, provider)
        assert breaker.get_state() == CircuitState.OPEN

        await asyncio.sleep(0.15)

        with pytest.raises(ProviderError):
            await breaker.execute(REQ, provider.call)

        assert breaker.get_state() == CircuitState.OPEN

    @pytest.mark.asyncio
    async def test_fm4_below_threshold_stays_closed(self) -> None:
        breaker = self._make(failure_threshold=50, minimum_requests=10)
        provider = MockProvider(
            MockProviderConfig(
                latency_ms=0,
                error_sequence=[503, 503, 503, 503, "success", "success", "success", "success", "success", "success"],
            )
        )

        await send_failures(breaker, provider, 4)
        await send_successes(breaker, provider, 6)
        assert breaker.get_state() == CircuitState.CLOSED

        stats = breaker.get_stats()
        assert abs(stats.failure_rate - 40) < 1

    @pytest.mark.asyncio
    async def test_fm5_independent_instances(self) -> None:
        breaker1 = self._make(failure_threshold=50, minimum_requests=5)
        breaker2 = self._make(failure_threshold=50, minimum_requests=5)

        failing = MockProvider(
            MockProviderConfig(latency_ms=0, failure_rate=1.0, failure_status_code=503)
        )
        healthy = MockProvider(MockProviderConfig(latency_ms=0))

        await trip_circuit(breaker1, failing)
        await send_successes(breaker2, healthy, 10)

        assert breaker1.get_state() == CircuitState.OPEN
        assert breaker2.get_state() == CircuitState.CLOSED

    @pytest.mark.asyncio
    async def test_fm6_stats_observable(self) -> None:
        breaker = self._make(failure_threshold=50, minimum_requests=10, window_size=100)
        provider = MockProvider(MockProviderConfig(latency_ms=0))

        await send_successes(breaker, provider, 50)

        stats = breaker.get_stats()
        assert stats.failure_rate == 0
        assert stats.total == 50


# =====================================================
# 3. INTEGRATION TESTS
# =====================================================


class TestIntegration:
    @pytest.fixture(autouse=True)
    def _cleanup(self) -> Any:
        self.breakers: list[CircuitBreaker] = []
        yield
        for b in self.breakers:
            b.destroy()

    def _make(self, **kwargs: Any) -> CircuitBreaker:
        b = CircuitBreaker(CircuitBreakerConfig(**kwargs))
        self.breakers.append(b)
        return b

    @pytest.mark.asyncio
    async def test_full_lifecycle(self) -> None:
        transitions: list[dict[str, CircuitState]] = []
        breaker = self._make(
            failure_threshold=50,
            minimum_requests=5,
            reset_timeout_ms=100,
            half_open_max_attempts=2,
            on_state_change=lambda e: transitions.append(
                {"from": e.from_state, "to": e.to_state}
            ),
        )

        # Phase 1: Trip with failures
        provider = MockProvider(
            MockProviderConfig(latency_ms=0, failure_rate=1.0, failure_status_code=503)
        )
        await trip_circuit(breaker, provider)
        assert breaker.get_state() == CircuitState.OPEN

        # Phase 2: OPEN — requests fail fast
        open_error: CircuitOpenError | None = None
        try:
            await breaker.execute(REQ, provider.call)
        except CircuitOpenError as e:
            open_error = e
        except Exception:
            pass
        assert open_error is not None
        assert open_error.failure_rate >= 50

        # Phase 3: Wait for reset -> HALF_OPEN
        await asyncio.sleep(0.15)
        assert breaker.get_state() == CircuitState.HALF_OPEN

        # Phase 4: Successful probes close the circuit
        provider.update_config(failure_rate=0)
        await breaker.execute(REQ, provider.call)
        assert breaker.get_state() == CircuitState.HALF_OPEN  # need 2 probes
        await breaker.execute(REQ, provider.call)
        assert breaker.get_state() == CircuitState.CLOSED

        assert transitions == [
            {"from": CircuitState.CLOSED, "to": CircuitState.OPEN},
            {"from": CircuitState.OPEN, "to": CircuitState.HALF_OPEN},
            {"from": CircuitState.HALF_OPEN, "to": CircuitState.CLOSED},
        ]

    @pytest.mark.asyncio
    async def test_retry_storm_protection(self) -> None:
        breaker = self._make(
            failure_threshold=50, minimum_requests=5, reset_timeout_ms=60_000
        )
        provider = MockProvider(
            MockProviderConfig(latency_ms=0, failure_rate=1.0, failure_status_code=503)
        )

        await trip_circuit(breaker, provider)
        assert breaker.get_state() == CircuitState.OPEN

        calls_before = provider.call_count

        results = await asyncio.gather(
            *[breaker.execute(REQ, provider.call) for _ in range(100)],
            return_exceptions=True,
        )

        rejected = [r for r in results if isinstance(r, CircuitOpenError)]
        assert len(rejected) == 100
        assert provider.call_count == calls_before

    @pytest.mark.asyncio
    async def test_concurrent_state_transition(self) -> None:
        breaker = self._make(
            failure_threshold=50,
            minimum_requests=5,
            reset_timeout_ms=100,
            half_open_max_attempts=1,
        )
        provider = MockProvider(
            MockProviderConfig(latency_ms=0, failure_rate=1.0, failure_status_code=503)
        )

        await trip_circuit(breaker, provider)
        assert breaker.get_state() == CircuitState.OPEN

        await asyncio.sleep(0.15)

        provider.update_config(failure_rate=0)

        result = await breaker.execute(REQ, provider.call)
        assert result.content is not None

    @pytest.mark.asyncio
    async def test_end_to_end_mixed(self) -> None:
        breaker = self._make(
            failure_threshold=60,
            minimum_requests=10,
            reset_timeout_ms=200,
            half_open_max_attempts=2,
            window_size=20,
        )
        provider = MockProvider(MockProviderConfig(latency_ms=0, tokens_per_response=150))

        # Phase 1: Normal operation
        await send_successes(breaker, provider, 15)
        assert breaker.get_state() == CircuitState.CLOSED
        stats = breaker.get_stats()
        assert stats.failure_rate == 0

        # Phase 2: Provider degrades
        provider.update_config(failure_rate=1.0, failure_status_code=503)
        await trip_circuit(breaker, provider)
        assert breaker.get_state() == CircuitState.OPEN

        # Phase 3: Provider recovers
        provider.update_config(failure_rate=0)
        await asyncio.sleep(0.25)

        # Phase 4: Probes close circuit
        await send_successes(breaker, provider, 2)
        assert breaker.get_state() == CircuitState.CLOSED

        # Phase 5: Normal operation resumes
        await send_successes(breaker, provider, 10)
        stats = breaker.get_stats()
        assert stats.failure_rate == 0

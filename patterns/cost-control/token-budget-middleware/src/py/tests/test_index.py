"""
Token Budget Middleware — Tests

Three categories: unit, failure mode, integration.
All tests use the mock provider — no real API calls.
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import MagicMock

import pytest

# Direct imports — conftest.py adds src/py/ to sys.path
from budget_types import (
    BudgetContext,
    BudgetExceededError,
    BudgetUsage,
    ExceededStrategy,
    LLMRequest,
)
from mock_provider import MockProvider, MockProviderConfig
from token_budget_middleware import TokenBudgetMiddleware


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def create_middleware(
    *,
    max_tokens: int = 10_000,
    window_seconds: float = 86_400,
    warning_threshold: float = 0.8,
    on_budget_exceeded: ExceededStrategy = ExceededStrategy.REJECT,
    on_warning: Any = None,
    estimate_tokens: Any = None,
    provider_config: MockProviderConfig | None = None,
) -> tuple[TokenBudgetMiddleware, MockProvider]:
    cfg = provider_config or MockProviderConfig()
    cfg.latency_ms = 0  # fast tests
    if provider_config is None:
        cfg.output_tokens_per_response = 100
    provider = MockProvider(cfg)

    middleware = TokenBudgetMiddleware(
        provider=provider.call,
        max_tokens=max_tokens,
        window_seconds=window_seconds,
        warning_threshold=warning_threshold,
        on_budget_exceeded=on_budget_exceeded,
        on_warning=on_warning,
        estimate_tokens=estimate_tokens,
    )
    return middleware, provider


# ---------------------------------------------------------------------------
# Unit Tests
# ---------------------------------------------------------------------------


class TestUnitCoreBudgetLogic:
    """Unit tests for core budget tracking."""

    @pytest.mark.asyncio
    async def test_tracks_token_usage_across_requests(self) -> None:
        mw, _ = create_middleware(
            max_tokens=10_000,
            provider_config=MockProviderConfig(output_tokens_per_response=50),
        )

        await mw.execute(LLMRequest("a" * 200))  # ~50 input + 50 output = 100
        await mw.execute(LLMRequest("b" * 200))

        usage = mw.get_usage("global")
        assert usage.tokens_used >= 100
        assert usage.utilization > 0

    @pytest.mark.asyncio
    async def test_returns_correct_remaining_budget(self) -> None:
        mw, _ = create_middleware(max_tokens=1_000)

        assert mw.get_remaining_budget("global") == 1_000

        await mw.execute(LLMRequest("test"))

        assert mw.get_remaining_budget("global") < 1_000

    @pytest.mark.asyncio
    async def test_resets_budget_for_specific_key(self) -> None:
        mw, _ = create_middleware(max_tokens=1_000)

        await mw.execute(LLMRequest("test"))
        assert mw.get_usage("global").tokens_used > 0

        mw.reset_budget("global")
        assert mw.get_usage("global").tokens_used == 0

    @pytest.mark.asyncio
    async def test_default_token_estimation(self) -> None:
        mw, _ = create_middleware(
            max_tokens=100_000,
            provider_config=MockProviderConfig(output_tokens_per_response=10),
        )

        result = await mw.execute(LLMRequest("a" * 400))
        # 400 chars / 4 = 100 estimated input tokens
        assert result.estimated_input_tokens == 100

    @pytest.mark.asyncio
    async def test_custom_token_estimator(self) -> None:
        mw, _ = create_middleware(
            max_tokens=100_000,
            estimate_tokens=lambda text: len(text),  # 1 token per char
        )

        result = await mw.execute(LLMRequest("hello"))
        assert result.estimated_input_tokens == 5

    @pytest.mark.asyncio
    async def test_separate_budget_keys_per_user(self) -> None:
        mw, _ = create_middleware(max_tokens=1_000)

        await mw.execute(LLMRequest("test"), BudgetContext(budget_key="user-a"))
        await mw.execute(LLMRequest("test"), BudgetContext(budget_key="user-b"))

        usage_a = mw.get_usage("user-a")
        usage_b = mw.get_usage("user-b")
        assert usage_a.tokens_used > 0
        assert usage_b.tokens_used > 0
        assert usage_a.tokens_used == usage_b.tokens_used

    @pytest.mark.asyncio
    async def test_hierarchical_parent_key_tracking(self) -> None:
        mw, _ = create_middleware(max_tokens=100_000)

        await mw.execute(
            LLMRequest("test"),
            BudgetContext(budget_key="user-1", parent_keys=["team-a", "global"]),
        )

        assert mw.get_usage("user-1").tokens_used > 0
        assert mw.get_usage("team-a").tokens_used > 0
        assert mw.get_usage("global").tokens_used > 0

    @pytest.mark.asyncio
    async def test_window_expiration_resets_usage(self) -> None:
        mw, _ = create_middleware(
            max_tokens=1_000,
            window_seconds=0.05,  # 50ms window
        )

        await mw.execute(LLMRequest("test"))
        assert mw.get_usage("global").tokens_used > 0

        await asyncio.sleep(0.06)

        assert mw.get_usage("global").tokens_used == 0


# ---------------------------------------------------------------------------
# Failure Mode Tests
# ---------------------------------------------------------------------------


class TestFailureModeBudgetExceeded:
    """FM: budget exceeded with reject strategy."""

    @pytest.mark.asyncio
    async def test_raises_budget_exceeded_error(self) -> None:
        mw, _ = create_middleware(
            max_tokens=50,
            provider_config=MockProviderConfig(output_tokens_per_response=100),
        )

        await mw.execute(LLMRequest("hi"))

        with pytest.raises(BudgetExceededError):
            await mw.execute(LLMRequest("hello again"))

    @pytest.mark.asyncio
    async def test_error_includes_usage_details(self) -> None:
        mw, _ = create_middleware(
            max_tokens=50,
            provider_config=MockProviderConfig(output_tokens_per_response=100),
        )

        await mw.execute(LLMRequest("hi"))

        with pytest.raises(BudgetExceededError) as exc_info:
            await mw.execute(LLMRequest("hello"))

        err = exc_info.value
        assert err.usage.budget_key == "global"
        assert err.usage.tokens_used > 0
        assert err.estimated_cost > 0


class TestFailureModeWarnOnly:
    """FM: warn-only strategy allows requests through."""

    @pytest.mark.asyncio
    async def test_does_not_raise_when_exceeded(self) -> None:
        mw, _ = create_middleware(
            max_tokens=50,
            on_budget_exceeded=ExceededStrategy.WARN_ONLY,
            provider_config=MockProviderConfig(output_tokens_per_response=100),
        )

        await mw.execute(LLMRequest("hi"))

        result = await mw.execute(LLMRequest("hello again"))
        assert result.response.content


class TestFailureModeEstimationDrift:
    """FM: token estimation drift detection."""

    @pytest.mark.asyncio
    async def test_detects_actual_vs_estimated_divergence(self) -> None:
        mw, _ = create_middleware(
            max_tokens=100_000,
            estimate_tokens=lambda _: 10,
            provider_config=MockProviderConfig(output_tokens_per_response=500),
        )

        result = await mw.execute(LLMRequest("test"))
        drift = abs(result.actual_tokens - result.estimated_input_tokens) / result.actual_tokens
        assert drift > 0.5


class TestFailureModeWindowBoundary:
    """FM: window boundary reset."""

    @pytest.mark.asyncio
    async def test_resets_after_window_expiry(self) -> None:
        mw, _ = create_middleware(
            max_tokens=200,
            window_seconds=0.05,
            provider_config=MockProviderConfig(output_tokens_per_response=100),
        )

        await mw.execute(LLMRequest("test"))
        assert mw.get_usage("global").tokens_used > 0

        await asyncio.sleep(0.06)

        result = await mw.execute(LLMRequest("test again"))
        assert result.response.content


class TestFailureModeWarningThreshold:
    """FM: warning threshold callback."""

    @pytest.mark.asyncio
    async def test_fires_warning_at_threshold(self) -> None:
        warning_fn = MagicMock()
        mw, _ = create_middleware(
            max_tokens=200,
            warning_threshold=0.5,
            on_warning=warning_fn,
            provider_config=MockProviderConfig(output_tokens_per_response=150),
        )

        await mw.execute(LLMRequest("test"))

        warning_fn.assert_called_once()
        usage_arg: BudgetUsage = warning_fn.call_args[0][0]
        assert usage_arg.utilization >= 0.5

    @pytest.mark.asyncio
    async def test_fires_warning_only_once_per_window(self) -> None:
        warning_fn = MagicMock()
        mw, _ = create_middleware(
            max_tokens=10_000,
            warning_threshold=0.01,
            on_warning=warning_fn,
            on_budget_exceeded=ExceededStrategy.WARN_ONLY,
            provider_config=MockProviderConfig(output_tokens_per_response=50),
        )

        await mw.execute(LLMRequest("test1"))
        await mw.execute(LLMRequest("test2"))
        await mw.execute(LLMRequest("test3"))

        warning_fn.assert_called_once()


class TestFailureModeSilentErosion:
    """FM: silent budget erosion from prompt growth."""

    @pytest.mark.asyncio
    async def test_tracks_increasing_tokens_over_time(self) -> None:
        mw, _ = create_middleware(
            max_tokens=100_000,
            provider_config=MockProviderConfig(output_tokens_per_response=100),
        )

        token_history: list[int] = []
        for i in range(10):
            prompt = "x" * (100 * (i + 1))
            result = await mw.execute(LLMRequest(prompt))
            token_history.append(result.actual_tokens)

        first_half = token_history[:5]
        second_half = token_history[5:]
        avg_first = sum(first_half) / len(first_half)
        avg_second = sum(second_half) / len(second_half)

        assert avg_second > avg_first


class TestFailureModeOverAggressiveRejection:
    """FM: verify no false positives when budget has headroom."""

    @pytest.mark.asyncio
    async def test_does_not_reject_with_headroom(self) -> None:
        mw, _ = create_middleware(
            max_tokens=10_000,
            provider_config=MockProviderConfig(output_tokens_per_response=50),
        )

        result = await mw.execute(LLMRequest("small request"))
        assert result.response.content
        assert result.usage.remaining > 0


# ---------------------------------------------------------------------------
# Integration Tests
# ---------------------------------------------------------------------------


class TestIntegrationEndToEnd:
    """End-to-end tests with mock provider."""

    @pytest.mark.asyncio
    async def test_exhausts_budget_then_rejects(self) -> None:
        mw, provider = create_middleware(
            max_tokens=500,
            provider_config=MockProviderConfig(output_tokens_per_response=100),
        )

        completed = 0
        rejected = False

        for i in range(10):
            try:
                await mw.execute(LLMRequest(f"request {i}"))
                completed += 1
            except BudgetExceededError:
                rejected = True
                break

        assert completed > 0
        assert completed < 10
        assert rejected is True
        assert provider.call_count == completed

    @pytest.mark.asyncio
    async def test_isolates_concurrent_user_budgets(self) -> None:
        mw, _ = create_middleware(
            max_tokens=300,
            provider_config=MockProviderConfig(output_tokens_per_response=200),
        )

        # User A: one call uses ~225 tokens (25 input + 200 output)
        await mw.execute(LLMRequest("a" * 100), BudgetContext(budget_key="user-a"))

        # User A should be blocked with a large prompt estimate
        with pytest.raises(BudgetExceededError):
            await mw.execute(LLMRequest("a" * 400), BudgetContext(budget_key="user-a"))

        # User B has a fresh budget
        result = await mw.execute(LLMRequest("b1"), BudgetContext(budget_key="user-b"))
        assert result.response.content

    @pytest.mark.asyncio
    async def test_variable_length_responses_tracked_correctly(self) -> None:
        mw, _ = create_middleware(
            max_tokens=10_000,
            provider_config=MockProviderConfig(
                output_tokens_per_response=100,
                output_token_variance=50,
            ),
        )

        results: list[int] = []
        for i in range(20):
            result = await mw.execute(LLMRequest(f"req {i}"))
            results.append(result.actual_tokens)

        # With variance, token counts should vary
        assert len(set(results)) > 1

        # Sum should match tracked total
        total_tracked = mw.get_usage("global").tokens_used
        total_actual = sum(results)
        assert total_tracked == total_actual

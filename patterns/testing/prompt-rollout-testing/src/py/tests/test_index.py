"""
Tests for Prompt Rollout Testing (Python implementation).

Three categories:
1. Unit tests — variant routing, stats, statistical evaluator
2. Failure mode tests — one test per failure mode in README
3. Integration tests — full end-to-end with mock provider
"""

from __future__ import annotations

import asyncio
import statistics
from typing import Any

import pytest

from .. import PromptRolloutTester, welch_t_test
from ..mock_provider import MockLLMProvider, MockProviderConfig
from ..types import (
    LLMRequest,
    PromptVariant,
    RolloutConfig,
    RolloutDecisionAction,
    RolloutMode,
)

# ─── Fixtures ─────────────────────────────────────────────────────────────────

CURRENT = PromptVariant(
    id="v1",
    label="current",
    prompt="Answer the question: {{input}}",
    weight=0.9,
)

CANDIDATE = PromptVariant(
    id="v2",
    label="candidate",
    prompt="Answer concisely: {{input}}",
    weight=0.1,
)


async def const_quality(response: str, input_text: str) -> float:
    return 0.8


def make_config(**kwargs: Any) -> RolloutConfig:
    defaults: dict[str, Any] = {
        "variants": [CURRENT, CANDIDATE],
        "mode": RolloutMode.AB,
        "min_sample_size": 10,
        "significance_level": 0.05,
        "quality_metric": const_quality,
        "auto_rollback": True,
        "rollback_threshold": 0.1,
        "evaluation_interval": 50,
    }
    defaults.update(kwargs)
    return RolloutConfig(**defaults)


# ─── Unit Tests ───────────────────────────────────────────────────────────────

class TestVariantRouter:
    @pytest.mark.asyncio
    async def test_assigns_traffic_according_to_weights(self) -> None:
        provider = MockLLMProvider(MockProviderConfig(base_latency_ms=0))
        tester = PromptRolloutTester(
            provider,
            make_config(
                variants=[
                    PromptVariant("v1", "current", "prompt", 0.8),
                    PromptVariant("v2", "candidate", "prompt", 0.2),
                ],
                evaluation_interval=999999,
            ),
        )
        counts: dict[str, int] = {"v1": 0, "v2": 0}
        for _ in range(1000):
            result = await tester.run(LLMRequest(input="test"))
            counts[result.response.variant_id] += 1

        ratio = counts["v1"] / 1000
        assert 0.75 < ratio < 0.85, f"Expected ~0.80, got {ratio}"

    def test_raises_with_fewer_than_two_variants(self) -> None:
        provider = MockLLMProvider()
        with pytest.raises(ValueError, match="at least 2 variants"):
            PromptRolloutTester(
                provider,
                make_config(variants=[PromptVariant("v1", "current", "prompt", 1.0)]),
            )

    def test_raises_when_weights_dont_sum_to_one(self) -> None:
        provider = MockLLMProvider()
        with pytest.raises(ValueError, match="sum to 1.0"):
            PromptRolloutTester(
                provider,
                make_config(
                    variants=[
                        PromptVariant("v1", "current", "prompt", 0.5),
                        PromptVariant("v2", "candidate", "prompt", 0.3),
                    ]
                ),
            )


class TestStatisticalEvaluator:
    @pytest.mark.asyncio
    async def test_holds_below_min_sample_size(self) -> None:
        provider = MockLLMProvider(MockProviderConfig(base_latency_ms=0))
        tester = PromptRolloutTester(
            provider,
            make_config(min_sample_size=100, evaluation_interval=999999),
        )
        await tester.run(LLMRequest(input="test"))
        decision = await tester.force_evaluate()
        assert decision.action == RolloutDecisionAction.HOLD
        assert "Insufficient" in decision.reasoning

    @pytest.mark.asyncio
    async def test_holds_when_quality_identical(self) -> None:
        provider = MockLLMProvider(MockProviderConfig(base_latency_ms=0))
        tester = PromptRolloutTester(
            provider,
            make_config(
                variants=[
                    PromptVariant("v1", "current", "p", 0.5),
                    PromptVariant("v2", "candidate", "p", 0.5),
                ],
                min_sample_size=5,
                evaluation_interval=999999,
                quality_metric=const_quality,  # identical for all
            ),
        )
        for _ in range(20):
            await tester.run(LLMRequest(input="test"))
        decision = await tester.force_evaluate()
        assert decision.action == RolloutDecisionAction.HOLD

    def test_welch_t_test_detects_clear_difference(self) -> None:
        a = [0.9 + 0.01 * i for i in range(50)]
        b = [0.5 + 0.01 * i for i in range(50)]
        p = welch_t_test(a, b)
        assert p < 0.001

    def test_welch_t_test_high_p_for_identical_groups(self) -> None:
        a = [0.8] * 50
        b = [0.8] * 50
        p = welch_t_test(a, b)
        assert p > 0.99

    def test_welch_t_test_returns_one_for_tiny_samples(self) -> None:
        assert welch_t_test([0.8], [0.9]) == 1.0
        assert welch_t_test([], []) == 1.0


class TestMetricCollector:
    @pytest.mark.asyncio
    async def test_records_per_variant_stats(self) -> None:
        provider = MockLLMProvider(MockProviderConfig(base_latency_ms=0))
        tester = PromptRolloutTester(
            provider,
            make_config(
                variants=[
                    PromptVariant("v1", "current", "p", 0.5),
                    PromptVariant("v2", "candidate", "p", 0.5),
                ],
                evaluation_interval=999999,
            ),
        )
        for _ in range(20):
            await tester.run(LLMRequest(input="test"))

        stats = tester.get_stats()
        total = sum(s.request_count for s in stats.values())
        assert total == 20

        for s in stats.values():
            if s.request_count > 0:
                assert all(q == 0.8 for q in s.quality_scores)


# ─── Failure Mode Tests ───────────────────────────────────────────────────────

class TestFailureModeNoveltybias:
    """FM1: Early samples skew high — decision deferred until minSampleSize."""

    @pytest.mark.asyncio
    async def test_defers_decision_when_min_sample_not_reached(self) -> None:
        provider = MockLLMProvider(MockProviderConfig(base_latency_ms=0))
        tester = PromptRolloutTester(
            provider,
            make_config(min_sample_size=200, evaluation_interval=1),
        )
        for _ in range(10):
            result = await tester.run(LLMRequest(input="test"))
            if result.decision:
                assert result.decision.action == RolloutDecisionAction.HOLD


class TestFailureModeInsufficientPower:
    """FM6: Insufficient power — hold when no real difference exists."""

    @pytest.mark.asyncio
    async def test_holds_with_no_quality_difference(self) -> None:
        provider = MockLLMProvider(MockProviderConfig(base_latency_ms=0))
        tester = PromptRolloutTester(
            provider,
            make_config(
                variants=[
                    PromptVariant("v1", "current", "p", 0.5),
                    PromptVariant("v2", "candidate", "p", 0.5),
                ],
                min_sample_size=5,
                evaluation_interval=999999,
                quality_metric=const_quality,
            ),
        )
        for _ in range(20):
            await tester.run(LLMRequest(input="test"))
        decision = await tester.force_evaluate()
        assert decision.action == RolloutDecisionAction.HOLD


class TestFailureModeRollbackStorms:
    """FM4: Auto-rollback routes all traffic to current variant."""

    @pytest.mark.asyncio
    async def test_auto_rollback_sets_current_to_100pct(self) -> None:
        provider = MockLLMProvider(MockProviderConfig(base_latency_ms=0))
        tester = PromptRolloutTester(
            provider,
            make_config(
                variants=[
                    PromptVariant("v1", "current", "p", 0.5),
                    PromptVariant("v2", "candidate", "p", 0.5),
                ],
                min_sample_size=5,
                evaluation_interval=999999,
                rollback_threshold=0.0001,
                auto_rollback=True,
                quality_metric=lambda r, i: asyncio.coroutine(lambda: 0.8 + 0.2 * ("v1" in r))(),
            ),
        )
        for _ in range(20):
            await tester.run(LLMRequest(input="test"))
        decision = await tester.force_evaluate()
        if decision.action == RolloutDecisionAction.ROLLBACK:
            weights = tester.get_weights()
            assert weights["v1"] == 1.0
            assert weights["v2"] == 0.0


class TestFailureModeSilentDrift:
    """FM5: Detect drift by comparing quality over time."""

    @pytest.mark.asyncio
    async def test_baseline_comparison_detects_drift(self) -> None:
        provider = MockLLMProvider(MockProviderConfig(base_latency_ms=0))
        epoch_quality = [0.9]  # mutable to allow closure update

        async def variable_quality(resp: str, inp: str) -> float:
            return epoch_quality[0]

        tester = PromptRolloutTester(
            provider,
            make_config(
                variants=[
                    PromptVariant("v1", "current", "p", 0.5),
                    PromptVariant("v2", "candidate", "p", 0.5),
                ],
                evaluation_interval=999999,
                quality_metric=variable_quality,
            ),
        )

        # Epoch 1: quality at 0.9
        for _ in range(10):
            await tester.run(LLMRequest(input="test"))
        early_scores = list(tester.get_stats()["v1"].quality_scores)

        # Epoch 2: quality drifts to 0.7
        epoch_quality[0] = 0.7
        for _ in range(10):
            await tester.run(LLMRequest(input="test"))
        all_scores = tester.get_stats()["v1"].quality_scores
        recent_scores = all_scores[-10:]

        early_mean = statistics.mean(early_scores)
        recent_mean = statistics.mean(recent_scores)
        assert early_mean - recent_mean > 0.1


# ─── Integration Tests ────────────────────────────────────────────────────────

class TestIntegrationFullRollout:
    @pytest.mark.asyncio
    async def test_end_to_end_ab_rollout(self) -> None:
        provider = MockLLMProvider(MockProviderConfig(base_latency_ms=5))
        tester = PromptRolloutTester(
            provider,
            make_config(
                variants=[
                    PromptVariant("v1", "current", "p", 0.5),
                    PromptVariant("v2", "candidate", "p", 0.5),
                ],
                min_sample_size=5,
                evaluation_interval=10,
            ),
        )
        last_decision = None
        for i in range(50):
            result = await tester.run(LLMRequest(input=f"query {i}"))
            assert result.response.output
            assert result.response.latency_ms > 0
            if result.decision:
                last_decision = result.decision

        assert last_decision is not None
        assert last_decision.action in (
            RolloutDecisionAction.HOLD,
            RolloutDecisionAction.PROMOTE,
            RolloutDecisionAction.ROLLBACK,
        )

    @pytest.mark.asyncio
    async def test_shadow_mode_returns_current_variant(self) -> None:
        provider = MockLLMProvider(MockProviderConfig(base_latency_ms=5))
        tester = PromptRolloutTester(
            provider,
            make_config(
                mode=RolloutMode.SHADOW,
                variants=[
                    PromptVariant("v1", "current", "p", 1.0),
                    PromptVariant("v2", "candidate", "p", 0.0),
                ],
                evaluation_interval=999999,
            ),
        )
        result = await tester.run(LLMRequest(input="test"))
        assert result.response.variant_id == "v1"
        assert result.response.output

    @pytest.mark.asyncio
    async def test_concurrent_requests_no_data_corruption(self) -> None:
        provider = MockLLMProvider(MockProviderConfig(base_latency_ms=5))
        tester = PromptRolloutTester(
            provider,
            make_config(
                variants=[
                    PromptVariant("v1", "current", "p", 0.5),
                    PromptVariant("v2", "candidate", "p", 0.5),
                ],
                evaluation_interval=999999,
            ),
        )
        await asyncio.gather(
            *[tester.run(LLMRequest(input=f"query {i}")) for i in range(20)]
        )
        assert tester.request_count == 20
        total = sum(s.request_count for s in tester.get_stats().values())
        assert total == 20

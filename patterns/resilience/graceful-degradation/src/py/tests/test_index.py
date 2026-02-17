"""
Graceful Degradation — Tests

Three categories:
  1. Unit tests — core logic, configuration, state
  2. Failure mode tests — one per failure mode from the table
  3. Integration tests — end-to-end with mock provider
"""

from __future__ import annotations

import asyncio
import re
import time
from unittest.mock import MagicMock

import pytest

from .. import DegradationChain
from ..mock_provider import (
    MockProvider,
    create_cache_handler,
    create_rule_based_handler,
    create_static_handler,
)
from ..types import (
    AllTiersExhaustedError,
    DegradationTier,
    LLMRequest,
    LLMResponse,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_primary_tier(
    *, failure_rate: float = 0.0, latency_ms: float = 5.0
) -> DegradationTier:
    provider = MockProvider(
        latency_ms=latency_ms,
        failure_rate=failure_rate,
        model_name="primary-model",
    )
    return DegradationTier(
        name="primary",
        handler=provider.call,
        quality_score=1.0,
        timeout_ms=500,
    )


def make_fallback_tier(
    *, failure_rate: float = 0.0, latency_ms: float = 5.0
) -> DegradationTier:
    provider = MockProvider(
        latency_ms=latency_ms,
        failure_rate=failure_rate,
        model_name="fallback-model",
    )
    return DegradationTier(
        name="fallback",
        handler=provider.call,
        quality_score=0.7,
        timeout_ms=500,
    )


def make_static_tier() -> DegradationTier:
    return DegradationTier(
        name="static",
        handler=create_static_handler("Service is temporarily limited."),
        quality_score=0.1,
        timeout_ms=100,
    )


def make_cache_tier():
    cache = create_cache_handler()
    tier = DegradationTier(
        name="cache",
        handler=cache.handler,
        quality_score=0.5,
        timeout_ms=200,
    )
    return tier, cache


def make_rule_tier() -> DegradationTier:
    return DegradationTier(
        name="rule-based",
        handler=create_rule_based_handler([
            (re.compile(r"hello|hi|hey", re.IGNORECASE), "Hello! How can I help?"),
            (re.compile(r"help", re.IGNORECASE), "Here are some common options..."),
        ]),
        quality_score=0.3,
        timeout_ms=100,
    )


# ---------------------------------------------------------------------------
# 1. Unit Tests — core logic, configuration, state
# ---------------------------------------------------------------------------

class TestUnit:
    async def test_returns_primary_tier_when_healthy(self):
        chain = DegradationChain(tiers=[make_primary_tier()])

        result = await chain.execute(LLMRequest(prompt="Hello"))

        assert result.tier == "primary"
        assert result.quality == 1.0
        assert result.degraded is False
        assert result.response.content
        assert result.latency_ms > 0
        assert len(result.attempted_tiers) == 1
        assert result.attempted_tiers[0].status == "success"

    async def test_walks_through_tiers_in_order_on_failure(self):
        chain = DegradationChain(
            tiers=[
                make_primary_tier(failure_rate=1.0),
                make_fallback_tier(),
                make_static_tier(),
            ],
        )

        result = await chain.execute(LLMRequest(prompt="Hello"))

        assert result.tier == "fallback"
        assert result.degraded is True
        assert len(result.attempted_tiers) == 2
        assert result.attempted_tiers[0].status == "failure"
        assert result.attempted_tiers[1].status == "success"

    async def test_requires_at_least_one_tier(self):
        with pytest.raises(ValueError, match="requires at least one tier"):
            DegradationChain(tiers=[])

    async def test_applies_default_global_timeout(self):
        chain = DegradationChain(tiers=[make_primary_tier()])

        result = await chain.execute(LLMRequest(prompt="test"))
        # Should succeed — default timeout is 5000ms, primary takes 5ms
        assert result.tier == "primary"

    async def test_applies_default_min_quality(self):
        chain = DegradationChain(
            tiers=[
                make_primary_tier(failure_rate=1.0),
                make_static_tier(),  # quality 0.1
            ],
        )

        result = await chain.execute(LLMRequest(prompt="test"))
        # Should reach static tier since min_quality defaults to 0.0
        assert result.tier == "static"

    async def test_skips_tiers_below_min_quality(self):
        chain = DegradationChain(
            tiers=[
                make_primary_tier(failure_rate=1.0),
                make_fallback_tier(failure_rate=1.0),
                make_static_tier(),  # quality 0.1
            ],
            min_quality=0.5,
        )

        with pytest.raises(AllTiersExhaustedError):
            await chain.execute(LLMRequest(prompt="test"))

    async def test_skips_unhealthy_tiers(self):
        primary = make_primary_tier()
        primary.is_healthy = lambda: False

        chain = DegradationChain(tiers=[primary, make_fallback_tier()])

        result = await chain.execute(LLMRequest(prompt="test"))

        assert result.tier == "fallback"
        assert result.attempted_tiers[0].status == "skipped_unhealthy"

    async def test_fires_on_degradation_callback(self):
        callback = MagicMock()

        chain = DegradationChain(
            tiers=[
                make_primary_tier(failure_rate=1.0),
                make_fallback_tier(),
            ],
            on_degradation=callback,
        )

        await chain.execute(LLMRequest(prompt="test"))

        callback.assert_called_once()
        result_arg = callback.call_args[0][0]
        assert result_arg.tier == "fallback"
        assert result_arg.degraded is True

    async def test_does_not_fire_on_degradation_when_primary_succeeds(self):
        callback = MagicMock()

        chain = DegradationChain(
            tiers=[make_primary_tier(), make_fallback_tier()],
            on_degradation=callback,
        )

        await chain.execute(LLMRequest(prompt="test"))

        callback.assert_not_called()

    async def test_records_latency_in_result_and_attempt(self):
        chain = DegradationChain(
            tiers=[make_primary_tier(latency_ms=20)],
        )

        result = await chain.execute(LLMRequest(prompt="test"))

        assert result.latency_ms >= 15
        assert result.attempted_tiers[0].latency_ms >= 15


# ---------------------------------------------------------------------------
# 2. Failure Mode Tests — one per failure mode from the table
# ---------------------------------------------------------------------------

class TestFailureModes:
    # FM1: Stale cache served indefinitely
    async def test_fm1_detects_stale_cache(self):
        cache_tier, cache = make_cache_tier()
        cache.populate("stale query", "Old cached response from last week")

        chain = DegradationChain(
            tiers=[make_primary_tier(failure_rate=1.0), cache_tier],
        )

        result = await chain.execute(LLMRequest(prompt="stale query"))

        assert result.tier == "cache"
        assert result.degraded is True
        assert result.quality == 0.5
        assert result.response.finish_reason == "cache_hit"

    # FM2: All tiers fail simultaneously
    async def test_fm2_all_tiers_exhausted_with_details(self):
        chain = DegradationChain(
            tiers=[
                make_primary_tier(failure_rate=1.0),
                make_fallback_tier(failure_rate=1.0),
            ],
        )

        with pytest.raises(AllTiersExhaustedError) as exc_info:
            await chain.execute(LLMRequest(prompt="test"))

        err = exc_info.value
        assert len(err.attempts) == 2
        assert err.attempts[0].tier == "primary"
        assert err.attempts[0].status == "failure"
        assert err.attempts[1].tier == "fallback"
        assert err.attempts[1].status == "failure"
        assert "All degradation tiers exhausted" in str(err)

    # FM3: Health check false positive
    async def test_fm3_false_positive_health_check(self):
        primary = make_primary_tier()
        # Health check says unhealthy even though provider is fine
        primary.is_healthy = lambda: False

        chain = DegradationChain(tiers=[primary, make_fallback_tier()])

        result = await chain.execute(LLMRequest(prompt="test"))

        assert result.tier == "fallback"
        assert result.attempted_tiers[0].status == "skipped_unhealthy"
        assert result.degraded is True

    # FM4: Fallback quality too low for use case
    async def test_fm4_min_quality_prevents_low_quality_serving(self):
        chain = DegradationChain(
            tiers=[
                make_primary_tier(failure_rate=1.0),
                make_rule_tier(),    # quality 0.3
                make_static_tier(),  # quality 0.1
            ],
            min_quality=0.5,
        )

        with pytest.raises(AllTiersExhaustedError):
            await chain.execute(LLMRequest(prompt="hello"))

    # FM5: Timeout cascade across tiers
    async def test_fm5_global_timeout_prevents_cascade(self):
        chain = DegradationChain(
            tiers=[
                make_primary_tier(latency_ms=300, failure_rate=1.0),
                make_fallback_tier(latency_ms=300, failure_rate=1.0),
                make_static_tier(),
            ],
            global_timeout_ms=400,
        )

        start = time.perf_counter()
        with pytest.raises(AllTiersExhaustedError) as exc_info:
            await chain.execute(LLMRequest(prompt="test"))
        elapsed_ms = (time.perf_counter() - start) * 1000

        err = exc_info.value
        assert elapsed_ms < 550

        static_attempt = next(a for a in err.attempts if a.tier == "static")
        assert static_attempt.status == "timeout"
        assert "Global timeout" in (static_attempt.error or "")

    # FM6: Tier ordering becomes suboptimal
    async def test_fm6_per_tier_metrics_available_for_review(self):
        chain = DegradationChain(
            tiers=[
                make_primary_tier(latency_ms=100),
                make_fallback_tier(latency_ms=5),
            ],
        )

        result = await chain.execute(LLMRequest(prompt="test"))

        assert result.tier == "primary"
        assert result.attempted_tiers[0].latency_ms > 50

    # FM7: Cache poisoning
    async def test_fm7_poisoned_cache_entry_served(self):
        cache_tier, cache = make_cache_tier()
        cache.populate("important query", "")

        chain = DegradationChain(
            tiers=[
                make_primary_tier(failure_rate=1.0),
                cache_tier,
                make_static_tier(),
            ],
        )

        result = await chain.execute(LLMRequest(prompt="important query"))

        assert result.tier == "cache"
        assert result.response.content == ""

    # FM8: Fallback tier behavioral divergence
    async def test_fm8_fallback_returns_structurally_different_responses(self):
        rule_handler = create_rule_based_handler([
            (re.compile(r".*"), "Generic rule response"),
        ])

        chain = DegradationChain(
            tiers=[
                make_primary_tier(failure_rate=1.0),
                DegradationTier(
                    name="rule-based",
                    handler=rule_handler,
                    quality_score=0.3,
                    timeout_ms=100,
                ),
            ],
        )

        result = await chain.execute(
            LLMRequest(prompt="complex analysis request"),
        )

        assert result.tier == "rule-based"
        assert result.response.model == "rule-based"
        assert result.response.finish_reason == "rule_match"

    # FM9: Silent degradation — quality tier drift
    async def test_fm9_quality_tier_drift_detectable(self):
        primary_healthy = True

        def check_health() -> bool:
            return primary_healthy

        primary = make_primary_tier()
        primary.is_healthy = check_health

        chain = DegradationChain(tiers=[primary, make_fallback_tier()])

        tier_counts: dict[str, int] = {"primary": 0, "fallback": 0}

        # Week 1: primary is healthy
        for i in range(10):
            result = await chain.execute(LLMRequest(prompt=f"query {i}"))
            tier_counts[result.tier] += 1

        assert tier_counts["primary"] == 10
        assert tier_counts["fallback"] == 0

        # Simulate drift: primary becomes unhealthy
        primary_healthy = False
        for i in range(10):
            result = await chain.execute(LLMRequest(prompt=f"query {i}"))
            tier_counts[result.tier] += 1

        total = tier_counts["primary"] + tier_counts["fallback"]
        primary_pct = tier_counts["primary"] / total

        assert primary_pct < 0.85
        assert tier_counts["fallback"] > 0


# ---------------------------------------------------------------------------
# 3. Integration Tests — end-to-end with mock provider
# ---------------------------------------------------------------------------

class TestIntegration:
    async def test_full_chain_walks_to_static(self):
        cache_tier, _ = make_cache_tier()

        chain = DegradationChain(
            tiers=[
                make_primary_tier(failure_rate=1.0),
                make_fallback_tier(failure_rate=1.0),
                cache_tier,        # will miss since nothing cached
                make_rule_tier(),  # won't match "xyz123"
                make_static_tier(),
            ],
        )

        result = await chain.execute(
            LLMRequest(prompt="xyz123 unmatched prompt"),
        )

        assert result.tier == "static"
        assert result.quality == 0.1
        assert result.degraded is True
        assert result.response.content == "Service is temporarily limited."
        assert len(result.attempted_tiers) == 5
        assert result.attempted_tiers[0].status == "failure"  # primary
        assert result.attempted_tiers[1].status == "failure"  # fallback
        assert result.attempted_tiers[2].status == "failure"  # cache miss
        assert result.attempted_tiers[3].status == "failure"  # no rule match
        assert result.attempted_tiers[4].status == "success"  # static

    async def test_cache_serves_when_populated(self):
        cache_tier, cache = make_cache_tier()
        cache.populate(
            "What is Python?",
            "Python is a high-level programming language.",
        )

        chain = DegradationChain(
            tiers=[
                make_primary_tier(failure_rate=1.0),
                cache_tier,
                make_static_tier(),
            ],
        )

        result = await chain.execute(LLMRequest(prompt="What is Python?"))

        assert result.tier == "cache"
        assert result.quality == 0.5
        assert "Python" in result.response.content

    async def test_rule_tier_matches_patterns(self):
        chain = DegradationChain(
            tiers=[
                make_primary_tier(failure_rate=1.0),
                make_rule_tier(),
                make_static_tier(),
            ],
        )

        result = await chain.execute(LLMRequest(prompt="Hello there!"))

        assert result.tier == "rule-based"
        assert result.quality == 0.3
        assert result.response.content == "Hello! How can I help?"

    async def test_concurrent_requests_independent(self):
        chain = DegradationChain(
            tiers=[make_primary_tier(latency_ms=10), make_static_tier()],
        )

        results = await asyncio.gather(
            chain.execute(LLMRequest(prompt="request 1")),
            chain.execute(LLMRequest(prompt="request 2")),
            chain.execute(LLMRequest(prompt="request 3")),
        )

        assert len(results) == 3
        for r in results:
            assert r.tier == "primary"
            assert r.degraded is False

    async def test_per_tier_timeout_triggers_fallthrough(self):
        async def slow_handler(_request: LLMRequest) -> LLMResponse:
            await asyncio.sleep(1.0)
            return LLMResponse(content="slow response", model="slow")

        slow_primary = DegradationTier(
            name="primary",
            handler=slow_handler,
            quality_score=1.0,
            timeout_ms=50,  # 50ms timeout, handler takes 1000ms
        )

        chain = DegradationChain(
            tiers=[slow_primary, make_static_tier()],
            global_timeout_ms=5000,
        )

        result = await chain.execute(LLMRequest(prompt="test"))

        assert result.tier == "static"
        assert result.attempted_tiers[0].status == "timeout"
        assert result.attempted_tiers[0].latency_ms < 200

    async def test_mixed_healthy_unhealthy_with_cache_hit(self):
        primary = make_primary_tier()
        primary.is_healthy = lambda: False

        cache_tier, cache = make_cache_tier()
        cache.populate("cached prompt", "Previously cached response")

        chain = DegradationChain(
            tiers=[
                primary,
                make_fallback_tier(failure_rate=1.0),
                cache_tier,
                make_static_tier(),
            ],
        )

        result = await chain.execute(LLMRequest(prompt="cached prompt"))

        assert result.tier == "cache"
        assert result.attempted_tiers[0].status == "skipped_unhealthy"
        assert result.attempted_tiers[1].status == "failure"
        assert result.attempted_tiers[2].status == "success"

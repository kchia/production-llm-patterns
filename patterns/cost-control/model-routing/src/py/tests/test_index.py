"""Tests for Model Routing pattern — unit, failure mode, and integration tests."""

from __future__ import annotations

import asyncio
import importlib.util
import time
from pathlib import Path

import pytest

# conftest.py adds src/py/ to sys.path so flat module imports work
from models import (
    ModelConfig,
    ModelTier,
    RouteRequest,
    RouterConfig,
)
from mock_provider import MockProvider, MockProviderConfig

# Import __init__.py as a named module (avoids the 'py' namespace collision)
_init_path = Path(__file__).resolve().parent.parent / "__init__.py"
_spec = importlib.util.spec_from_file_location("model_routing", str(_init_path))
assert _spec and _spec.loader
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

HeuristicClassifier = _mod.HeuristicClassifier
ModelRouter = _mod.ModelRouter

FAST_CONFIG = MockProviderConfig(
    strong_latency_ms=0,
    mid_latency_ms=0,
    weak_latency_ms=0,
    latency_jitter_ms=0,
)


# ─── HeuristicClassifier Unit Tests ────────────────────────


class TestHeuristicClassifierTaskTypes:
    def test_classifies_extraction_as_simple(self) -> None:
        c = HeuristicClassifier()
        assert c.classify("anything", "extraction") < 0.3

    def test_classifies_classification_as_simple(self) -> None:
        c = HeuristicClassifier()
        assert c.classify("anything", "classification") < 0.3

    def test_classifies_reasoning_as_complex(self) -> None:
        c = HeuristicClassifier()
        assert c.classify("anything", "reasoning") > 0.7

    def test_classifies_code_generation_as_complex(self) -> None:
        c = HeuristicClassifier()
        assert c.classify("anything", "code-generation") > 0.7


class TestHeuristicClassifierPromptSignals:
    def test_short_simple_prompts_score_lower(self) -> None:
        c = HeuristicClassifier()
        assert c.classify("List the colors.") < 0.5

    def test_numbered_steps_score_higher(self) -> None:
        c = HeuristicClassifier()
        prompt = (
            "1. First analyze the data. 2. Then compare results. "
            "3. Finally summarize findings. 4. Provide recommendations."
        )
        assert c.classify(prompt) > 0.5

    def test_code_blocks_score_higher_than_plain_text(self) -> None:
        c = HeuristicClassifier()
        with_code = "Review this code:\n```\nfunction add(a, b) { return a + b; }\n```"
        without_code = "Review this text about addition and basic math operations in detail."
        assert c.classify(with_code) > c.classify(without_code)

    def test_complexity_down_keywords_score_lower(self) -> None:
        c = HeuristicClassifier()
        assert c.classify("Extract the names from this list.") < 0.5

    def test_complexity_up_keywords_score_higher_than_without(self) -> None:
        c = HeuristicClassifier()
        with_kw = c.classify("Analyze the trade-off between speed and accuracy in this approach.")
        without = c.classify("Here is some information about speed and accuracy in this approach.")
        assert with_kw > without


class TestHeuristicClassifierBounds:
    def test_never_below_zero(self) -> None:
        c = HeuristicClassifier()
        assert c.classify("yes", "classification") >= 0

    def test_never_above_one(self) -> None:
        c = HeuristicClassifier()
        long_complex = "analyze " + "step by step " * 100 + "```code```"
        assert c.classify(long_complex, "reasoning") <= 1.0


# ─── ModelRouter Unit Tests ─────────────────────────────────


class TestModelRouterRoutingDecisions:
    @pytest.mark.asyncio
    async def test_routes_extraction_to_weak(self) -> None:
        router = ModelRouter(MockProvider(FAST_CONFIG))
        result = await router.route(RouteRequest(prompt="Extract the name from: John Smith", task_type="extraction"))
        assert result.tier == ModelTier.WEAK
        assert result.model == "gpt-4o-mini"

    @pytest.mark.asyncio
    async def test_routes_reasoning_to_strong(self) -> None:
        router = ModelRouter(MockProvider(FAST_CONFIG))
        result = await router.route(RouteRequest(
            prompt="Explain the trade-offs between microservices and monoliths",
            task_type="reasoning",
        ))
        assert result.tier == ModelTier.STRONG
        assert result.model == "gpt-4o"

    @pytest.mark.asyncio
    async def test_routes_mid_complexity_to_mid(self) -> None:
        router = ModelRouter(MockProvider(FAST_CONFIG))
        result = await router.route(RouteRequest(
            prompt="Summarize the following article about climate change and its economic impacts over the next decade. The article discusses several key themes including policy responses, technological innovation, and market adaptation.",
        ))
        assert result.tier == ModelTier.MID
        assert result.model == "claude-sonnet"


class TestModelRouterConfiguration:
    @pytest.mark.asyncio
    async def test_respects_custom_thresholds(self) -> None:
        config = RouterConfig(weak_threshold=0.8, strong_threshold=0.95)
        router = ModelRouter(MockProvider(FAST_CONFIG), config)
        result = await router.route(RouteRequest(
            prompt="Summarize the following paragraph about climate change.",
        ))
        assert result.tier == ModelTier.WEAK

    @pytest.mark.asyncio
    async def test_respects_custom_model_ids(self) -> None:
        config = RouterConfig(models={
            ModelTier.STRONG: ModelConfig(id="custom-strong", tier=ModelTier.STRONG, input_cost_per_1m_tokens=5, output_cost_per_1m_tokens=15),
            ModelTier.MID: ModelConfig(id="custom-mid", tier=ModelTier.MID, input_cost_per_1m_tokens=2, output_cost_per_1m_tokens=8),
            ModelTier.WEAK: ModelConfig(id="custom-weak", tier=ModelTier.WEAK, input_cost_per_1m_tokens=0.1, output_cost_per_1m_tokens=0.3),
        })
        router = ModelRouter(MockProvider(FAST_CONFIG), config)
        result = await router.route(RouteRequest(prompt="Extract name", task_type="extraction"))
        assert result.model == "custom-weak"

    @pytest.mark.asyncio
    async def test_runtime_config_update(self) -> None:
        router = ModelRouter(MockProvider(FAST_CONFIG))
        router.update_config(models={
            ModelTier.STRONG: ModelConfig(id="new-strong", tier=ModelTier.STRONG, input_cost_per_1m_tokens=2, output_cost_per_1m_tokens=8),
            ModelTier.MID: ModelConfig(id="claude-sonnet", tier=ModelTier.MID, input_cost_per_1m_tokens=3, output_cost_per_1m_tokens=15),
            ModelTier.WEAK: ModelConfig(id="gpt-4o-mini", tier=ModelTier.WEAK, input_cost_per_1m_tokens=0.15, output_cost_per_1m_tokens=0.6),
        })
        result = await router.route(RouteRequest(prompt="Complex analysis", task_type="reasoning"))
        assert result.model == "new-strong"


class TestModelRouterStats:
    @pytest.mark.asyncio
    async def test_tracks_total_requests(self) -> None:
        router = ModelRouter(MockProvider(FAST_CONFIG))
        await router.route(RouteRequest(prompt="test 1", task_type="extraction"))
        await router.route(RouteRequest(prompt="test 2", task_type="reasoning"))
        assert router.get_stats().total_requests == 2

    @pytest.mark.asyncio
    async def test_tracks_routes_by_tier(self) -> None:
        router = ModelRouter(MockProvider(FAST_CONFIG))
        await router.route(RouteRequest(prompt="a", task_type="extraction"))
        await router.route(RouteRequest(prompt="b", task_type="reasoning"))
        await router.route(RouteRequest(prompt="c", task_type="classification"))
        stats = router.get_stats()
        assert stats.routes_by_tier[ModelTier.WEAK] == 2
        assert stats.routes_by_tier[ModelTier.STRONG] == 1

    @pytest.mark.asyncio
    async def test_tracks_average_complexity(self) -> None:
        router = ModelRouter(MockProvider(FAST_CONFIG))
        await router.route(RouteRequest(prompt="simple", task_type="extraction"))
        await router.route(RouteRequest(prompt="complex", task_type="reasoning"))
        avg = router.get_stats().average_complexity_score
        assert 0 < avg < 1

    @pytest.mark.asyncio
    async def test_records_recent_decisions(self) -> None:
        router = ModelRouter(MockProvider(FAST_CONFIG))
        await router.route(RouteRequest(prompt="test", task_type="extraction"))
        decisions = router.get_stats().recent_decisions
        assert len(decisions) == 1
        assert decisions[0].tier == ModelTier.WEAK
        assert decisions[0].model == "gpt-4o-mini"

    @pytest.mark.asyncio
    async def test_reset_stats(self) -> None:
        router = ModelRouter(MockProvider(FAST_CONFIG))
        await router.route(RouteRequest(prompt="test", task_type="extraction"))
        router.reset_stats()
        stats = router.get_stats()
        assert stats.total_requests == 0
        assert len(stats.recent_decisions) == 0


class TestModelRouterTierDistribution:
    @pytest.mark.asyncio
    async def test_returns_percentages(self) -> None:
        router = ModelRouter(MockProvider(FAST_CONFIG))
        await router.route(RouteRequest(prompt="a", task_type="extraction"))
        await router.route(RouteRequest(prompt="b", task_type="extraction"))
        await router.route(RouteRequest(prompt="c", task_type="reasoning"))
        await router.route(RouteRequest(prompt="d", task_type="reasoning"))
        dist = router.get_tier_distribution()
        assert dist[ModelTier.WEAK] == 0.5
        assert dist[ModelTier.STRONG] == 0.5


# ─── Failure Mode Tests ─────────────────────────────────────


class TestFM1MisrouteToWeak:
    @pytest.mark.asyncio
    async def test_complex_untyped_prompts_not_routed_to_weak(self) -> None:
        router = ModelRouter(MockProvider(FAST_CONFIG))
        result = await router.route(RouteRequest(
            prompt=(
                "Analyze the trade-off between consistency and availability in distributed systems. "
                "1. First compare CAP theorem implications. "
                "2. Then evaluate Raft vs Paxos consensus. "
                "3. Consider the implications for microservice architectures. "
                "4. Provide a step by step reasoning."
            ),
        ))
        assert result.tier != ModelTier.WEAK


class TestFM2MisrouteToStrong:
    @pytest.mark.asyncio
    async def test_simple_prompts_not_routed_to_strong(self) -> None:
        router = ModelRouter(MockProvider(FAST_CONFIG))
        result = await router.route(RouteRequest(prompt="List the colors: red, blue, green"))
        assert result.tier != ModelTier.STRONG


class TestFM3ClassifierLatency:
    def test_classification_throughput(self) -> None:
        c = HeuristicClassifier()
        start = time.perf_counter()
        for _ in range(1000):
            c.classify(
                "Analyze the implications of this complex multi-step reasoning task with code ```function test() {}```"
            )
        elapsed_ms = (time.perf_counter() - start) * 1000
        assert elapsed_ms < 50


class TestFM4FallbackOverload:
    @pytest.mark.asyncio
    async def test_falls_back_to_strong_when_classifier_throws(self) -> None:
        class BrokenClassifier:
            def classify(self, prompt: str, task_type: str | None = None) -> float:
                raise RuntimeError("classifier broken")

        router = ModelRouter(MockProvider(FAST_CONFIG), classifier=BrokenClassifier())
        result = await router.route(RouteRequest(prompt="test"))
        assert result.tier == ModelTier.STRONG
        assert result.complexity_score == -1.0
        assert router.get_stats().classification_errors == 1

    @pytest.mark.asyncio
    async def test_tracks_fallback_rate(self) -> None:
        call_count = 0

        class FlakyClassifier:
            def classify(self, prompt: str, task_type: str | None = None) -> float:
                nonlocal call_count
                call_count += 1
                if call_count % 2 == 0:
                    raise RuntimeError("intermittent failure")
                return 0.5

        router = ModelRouter(MockProvider(FAST_CONFIG), classifier=FlakyClassifier())
        for _ in range(10):
            await router.route(RouteRequest(prompt="test"))
        assert router.get_stats().classification_errors == 5


class TestFM5ModelPoolStaleness:
    @pytest.mark.asyncio
    async def test_tier_distribution_exposed_for_drift_monitoring(self) -> None:
        router = ModelRouter(MockProvider(FAST_CONFIG))
        for prompt in ["Extract name: John", "Classify: positive", "List items: a, b, c"]:
            await router.route(RouteRequest(prompt=prompt, task_type="extraction"))
        dist = router.get_tier_distribution()
        assert dist[ModelTier.WEAK] == 1.0


class TestFM6ThresholdDrift:
    @pytest.mark.asyncio
    async def test_detects_distribution_shift(self) -> None:
        router = ModelRouter(MockProvider(FAST_CONFIG))

        for _ in range(5):
            await router.route(RouteRequest(prompt="extract item", task_type="extraction"))
        phase1 = router.get_tier_distribution()

        router.reset_stats()

        for _ in range(5):
            await router.route(RouteRequest(prompt="deep analysis", task_type="reasoning"))
        phase2 = router.get_tier_distribution()

        assert abs(phase1[ModelTier.WEAK] - phase2[ModelTier.WEAK]) > 0.5


# ─── Integration Tests ──────────────────────────────────────


class TestIntegration:
    @pytest.mark.asyncio
    async def test_mixed_workload_end_to_end(self) -> None:
        config = MockProviderConfig(
            strong_latency_ms=0, mid_latency_ms=0, weak_latency_ms=0,
            latency_jitter_ms=0, avg_output_tokens=100,
        )
        router = ModelRouter(MockProvider(config))

        requests = [
            RouteRequest(prompt="Extract the email from: john@example.com", task_type="extraction"),
            RouteRequest(prompt="Classify this text as positive or negative: I love this product", task_type="classification"),
            RouteRequest(
                prompt=(
                    "Analyze the architectural implications of migrating from a monolith to microservices, "
                    "considering: 1. Data consistency. 2. Network partition handling. "
                    "3. Deployment complexity. 4. Team organization."
                ),
                task_type="reasoning",
            ),
            RouteRequest(prompt="Summarize the following article in one sentence."),
        ]

        results = [await router.route(req) for req in requests]

        assert results[0].tier == ModelTier.WEAK
        assert results[1].tier == ModelTier.WEAK
        assert results[2].tier == ModelTier.STRONG

        for r in results:
            assert r.response
            assert r.input_tokens > 0
            assert r.output_tokens > 0
            assert r.latency_ms > 0

        stats = router.get_stats()
        assert stats.total_requests == 4
        assert sum(stats.routes_by_tier.values()) == 4
        assert stats.classification_errors == 0
        assert len(stats.recent_decisions) == 4

    @pytest.mark.asyncio
    async def test_provider_errors_propagate(self) -> None:
        config = MockProviderConfig(
            strong_latency_ms=0, mid_latency_ms=0, weak_latency_ms=0,
            latency_jitter_ms=0, error_rate=1.0,
        )
        router = ModelRouter(MockProvider(config))
        with pytest.raises(RuntimeError, match="MockProvider: simulated error"):
            await router.route(RouteRequest(prompt="test", task_type="extraction"))

    @pytest.mark.asyncio
    async def test_concurrent_routing_maintains_stats(self) -> None:
        router = ModelRouter(MockProvider(FAST_CONFIG))
        tasks = [
            router.route(RouteRequest(
                prompt=f"request {i}",
                task_type="extraction" if i % 2 == 0 else "reasoning",
            ))
            for i in range(20)
        ]
        await asyncio.gather(*tasks)

        stats = router.get_stats()
        assert stats.total_requests == 20
        assert sum(stats.routes_by_tier.values()) == 20

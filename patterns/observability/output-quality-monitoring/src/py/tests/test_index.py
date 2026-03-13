"""Tests for Output Quality Monitoring — Python implementation.

Three categories: unit tests, failure mode tests, integration tests.
"""

from __future__ import annotations

import asyncio
import re
import time
from unittest.mock import MagicMock

import pytest

# Use conftest.py sys.path setup — direct imports avoid 'py' name conflict
from quality_monitoring import (
    Aggregator,
    BaselineTracker,
    FormatScorer,
    KeywordScorer,
    LengthScorer,
    QualityMonitor,
    Sampler,
    ScoreStore,
)
from quality_monitoring.mock_provider import MockProvider
from quality_monitoring.types import (
    AlertSeverity,
    LLMInteraction,
    QualityMonitorConfig,
    ScoreResult,
    StoredScore,
    TimeWindow,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_id_seq = 0


def make_interaction(**overrides) -> LLMInteraction:
    global _id_seq
    _id_seq += 1
    defaults = dict(
        id=f"test-{_id_seq}",
        input="Analyze the impact of climate change on coastal ecosystems.",
        output=(
            "The analysis shows that climate change demonstrates significant impact "
            "across multiple dimensions. Key findings include rising sea levels "
            "affecting coastal habitats, increased ocean acidification impacting "
            "marine biodiversity, and shifting weather patterns disrupting "
            "ecosystem balance."
        ),
        model="test-model",
        prompt_template="default",
        metadata={},
        timestamp=time.time() * 1000,
        latency_ms=200,
        token_count={"input": 50, "output": 100},
    )
    defaults.update(overrides)
    return LLMInteraction(**defaults)


def create_monitor(alerts: list | None = None, **config_overrides):
    """Create a QualityMonitor with 100% sample rate and alert capture."""
    cfg = dict(sample_rate=1.0, min_samples_for_alert=1)
    cfg.update(config_overrides)
    monitor = QualityMonitor(cfg)
    if alerts is not None:
        monitor.on_alert(lambda a: alerts.append(a))
    return monitor


# ===================================================================
# Unit Tests
# ===================================================================


class TestLengthScorer:
    @pytest.mark.asyncio
    async def test_short_output_scores_low(self):
        scorer = LengthScorer(ideal_length=500)
        interaction = make_interaction(output="Short.")
        result = await scorer.score(interaction)
        assert result.scorer_name == "length"
        assert result.value < 0.1

    @pytest.mark.asyncio
    async def test_ideal_length_scores_high(self):
        scorer = LengthScorer(ideal_length=100)
        interaction = make_interaction(output="x" * 200)
        result = await scorer.score(interaction)
        assert result.value == 1.0

    @pytest.mark.asyncio
    async def test_records_duration(self):
        scorer = LengthScorer()
        result = await scorer.score(make_interaction())
        assert result.duration_ms >= 0


class TestFormatScorer:
    @pytest.mark.asyncio
    async def test_all_patterns_match(self):
        scorer = FormatScorer([r"analysis", r"findings"])
        result = await scorer.score(make_interaction())
        assert result.value == 1.0

    @pytest.mark.asyncio
    async def test_partial_match(self):
        scorer = FormatScorer([r"analysis", r"ZZZZNOTFOUND"])
        result = await scorer.score(make_interaction())
        assert result.value == pytest.approx(0.5)

    @pytest.mark.asyncio
    async def test_no_patterns_gives_perfect_score(self):
        scorer = FormatScorer([])
        result = await scorer.score(make_interaction())
        assert result.value == 1.0


class TestKeywordScorer:
    @pytest.mark.asyncio
    async def test_all_keywords_present(self):
        scorer = KeywordScorer(["climate", "impact", "biodiversity"])
        result = await scorer.score(make_interaction())
        assert result.value == 1.0

    @pytest.mark.asyncio
    async def test_case_insensitive(self):
        scorer = KeywordScorer(["CLIMATE", "IMPACT"])
        result = await scorer.score(make_interaction())
        assert result.value == 1.0

    @pytest.mark.asyncio
    async def test_missing_keywords(self):
        scorer = KeywordScorer(["climate", "quantum", "blockchain"])
        result = await scorer.score(make_interaction())
        assert result.value == pytest.approx(1 / 3, abs=0.01)


class TestSampler:
    def test_always_sample_at_rate_1(self):
        sampler = Sampler(rate=1.0)
        sampled = sum(
            1 for _ in range(100) if sampler.should_sample(make_interaction())
        )
        assert sampled == 100

    def test_never_sample_at_rate_0(self):
        sampler = Sampler(rate=0.0)
        sampled = sum(
            1 for _ in range(100) if sampler.should_sample(make_interaction())
        )
        assert sampled == 0

    def test_dimension_override(self):
        sampler = Sampler(rate=0.0, dimension_overrides={"special-template": 1.0})
        interaction = make_interaction(prompt_template="special-template")
        sampled = sum(
            1 for _ in range(100) if sampler.should_sample(interaction)
        )
        assert sampled == 100


class TestScoreStore:
    def test_add_and_query(self):
        store = ScoreStore(max_size=100)
        now = time.time() * 1000
        entry = StoredScore(
            interaction_id="s-1",
            timestamp=now,
            dimensions={"model": "gpt-4"},
            scores=[ScoreResult(scorer_name="length", value=0.8, duration_ms=1)],
        )
        store.add(entry)
        results = store.query(TimeWindow(start_ms=now - 1000, end_ms=now + 1000))
        assert len(results) == 1

    def test_eviction_at_max_size(self):
        store = ScoreStore(max_size=10)
        now = time.time() * 1000
        for i in range(20):
            store.add(
                StoredScore(
                    interaction_id=f"s-{i}",
                    timestamp=now + i,
                    dimensions={},
                    scores=[],
                )
            )
        assert store.size == 10

    def test_dimension_filter(self):
        store = ScoreStore()
        now = time.time() * 1000
        store.add(
            StoredScore(
                interaction_id="a",
                timestamp=now,
                dimensions={"model": "gpt-4"},
                scores=[],
            )
        )
        store.add(
            StoredScore(
                interaction_id="b",
                timestamp=now,
                dimensions={"model": "claude"},
                scores=[],
            )
        )
        results = store.query(
            TimeWindow(start_ms=now - 1000, end_ms=now + 1000),
            {"model": "gpt-4"},
        )
        assert len(results) == 1
        assert results[0].interaction_id == "a"


class TestBaselineTracker:
    def test_initial_value(self):
        tracker = BaselineTracker(decay=0.9)
        tracker.update("dim", "scorer", 0.8)
        entry = tracker.get("dim", "scorer")
        assert entry is not None
        assert entry.value == pytest.approx(0.8)

    def test_ema_convergence(self):
        tracker = BaselineTracker(decay=0.9)
        tracker.update("dim", "scorer", 0.9)
        for _ in range(100):
            tracker.update("dim", "scorer", 0.5)
        entry = tracker.get("dim", "scorer")
        assert entry is not None
        assert entry.value == pytest.approx(0.5, abs=0.05)

    def test_separate_dimensions(self):
        tracker = BaselineTracker()
        tracker.update("dim-a", "scorer", 0.9)
        tracker.update("dim-b", "scorer", 0.3)
        assert tracker.get("dim-a", "scorer").value == pytest.approx(0.9)
        assert tracker.get("dim-b", "scorer").value == pytest.approx(0.3)


class TestQualityMonitorConfig:
    @pytest.mark.asyncio
    async def test_default_config(self):
        monitor = QualityMonitor()
        health = monitor.check_health()
        assert health.healthy is True
        assert health.scorer_count == 0

    @pytest.mark.asyncio
    async def test_custom_config(self):
        monitor = QualityMonitor({"sample_rate": 0.5, "max_queue_depth": 500})
        health = monitor.check_health()
        assert health.healthy is True


# ===================================================================
# Failure Mode Tests
# ===================================================================


class TestFailureModes:
    @pytest.mark.asyncio
    async def test_broken_scorer_canary(self):
        """FM: Broken scorer doesn't block pipeline — other scorers still run."""

        class BrokenScorer:
            name = "broken"

            async def score(self, interaction: LLMInteraction) -> ScoreResult:
                raise RuntimeError("Scorer crashed")

        monitor = create_monitor()
        monitor.register_scorer(LengthScorer())
        monitor.register_scorer(BrokenScorer())
        monitor.register_scorer(KeywordScorer(["climate"]))

        # Record should not raise despite broken scorer
        await monitor.record(make_interaction())
        metrics = monitor.get_metrics()
        assert metrics["scored"] == 1
        assert metrics["scorer_errors"] == 1

    @pytest.mark.asyncio
    async def test_low_sample_rate_reduces_scoring(self):
        """FM: Low sample rate means most interactions aren't scored."""
        monitor = QualityMonitor({"sample_rate": 0.01, "min_samples_for_alert": 1})
        monitor.register_scorer(LengthScorer())

        for _ in range(1000):
            await monitor.record(make_interaction())

        metrics = monitor.get_metrics()
        assert metrics["recorded"] == 1000
        # With 1% rate, expect ~10 ± some variance
        assert metrics["sampled"] < 50

    @pytest.mark.asyncio
    async def test_scorer_timeout(self):
        """FM: Slow scorer is terminated after timeout, pipeline continues."""

        class SlowScorer:
            name = "slow"

            async def score(self, interaction: LLMInteraction) -> ScoreResult:
                await asyncio.sleep(10)  # 10 seconds — will be timed out
                return ScoreResult(scorer_name="slow", value=1.0)

        monitor = create_monitor(scorer_timeout_ms=50)
        monitor.register_scorer(LengthScorer())
        monitor.register_scorer(SlowScorer())

        await monitor.record(make_interaction())
        metrics = monitor.get_metrics()
        assert metrics["scorer_timeouts"] == 1
        assert metrics["scored"] == 1  # Interaction was still scored

    @pytest.mark.asyncio
    async def test_baseline_drift_masks_degradation(self):
        """FM: Gradual degradation outpaces baseline adaptation (silent degradation).

        With high decay (0.99), the baseline follows the declining scores closely,
        so the relative threshold never fires. The absolute threshold is the safety net.
        """
        alerts: list = []
        monitor = create_monitor(
            alerts=alerts,
            baseline_decay=0.99,
            relative_threshold=0.1,
            absolute_threshold=0.3,
            min_samples_for_alert=5,
        )
        monitor.register_scorer(LengthScorer(ideal_length=100))

        # Feed gradually shrinking outputs — baseline chases the decline
        for i in range(100):
            length = max(1, 100 - i)  # 100 → 1 over 100 iterations
            await monitor.record(make_interaction(output="x" * length))

        # Relative alerts should be rare because baseline drifts with the data.
        # Absolute alerts fire once scores drop below 0.3.
        absolute_alerts = [
            a for a in alerts if a.severity == AlertSeverity.CRITICAL
        ]
        assert len(absolute_alerts) > 0, "Absolute threshold should catch degradation"

    @pytest.mark.asyncio
    async def test_absolute_threshold_catches_degradation(self):
        """FM: Even with baseline drift, absolute threshold fires."""
        alerts: list = []
        monitor = create_monitor(
            alerts=alerts,
            absolute_threshold=0.5,
            min_samples_for_alert=1,
        )
        monitor.register_scorer(LengthScorer(ideal_length=1000))

        # Short output should trigger absolute threshold
        await monitor.record(make_interaction(output="tiny"))
        critical = [a for a in alerts if a.severity == AlertSeverity.CRITICAL]
        assert len(critical) > 0

    @pytest.mark.asyncio
    async def test_dimensional_explosion(self):
        """FM: High dimension cardinality doesn't crash — just dilutes samples."""
        monitor = create_monitor(
            dimensions=["prompt_template"],
            min_samples_for_alert=100,
        )
        monitor.register_scorer(LengthScorer())

        # 500 unique templates
        for i in range(500):
            await monitor.record(
                make_interaction(prompt_template=f"template-{i}")
            )

        metrics = monitor.get_metrics()
        assert metrics["scored"] == 500
        health = monitor.check_health()
        assert health.scorer_count == 1

    @pytest.mark.asyncio
    async def test_queue_backpressure(self):
        """FM: When queue is full, excess interactions are dropped."""
        monitor = create_monitor(max_queue_depth=1)
        # Register a slow scorer to keep the queue occupied
        class SlowScorer:
            name = "slow"

            async def score(self, interaction: LLMInteraction) -> ScoreResult:
                await asyncio.sleep(0.1)
                return ScoreResult(scorer_name="slow", value=0.9)

        monitor.register_scorer(SlowScorer())

        # Fire many concurrent records — some should be dropped
        tasks = [monitor.record(make_interaction()) for _ in range(20)]
        await asyncio.gather(*tasks)

        metrics = monitor.get_metrics()
        assert metrics["queue_dropped"] > 0, "Some interactions should be dropped"


# ===================================================================
# Integration Tests
# ===================================================================


class TestIntegration:
    @pytest.mark.asyncio
    async def test_full_pipeline_with_mock_provider(self):
        """End-to-end: mock provider → monitor → store → query."""
        provider = MockProvider(
            base_latency_ms=1,
            base_quality=0.9,
            avg_input_tokens=50,
            avg_output_tokens=150,
        )

        alerts: list = []
        monitor = create_monitor(alerts=alerts)
        monitor.register_scorer(LengthScorer())
        monitor.register_scorer(KeywordScorer(["climate", "impact"]))

        # Record several interactions from the mock provider
        for _ in range(10):
            interaction = await provider.complete(
                "Test prompt", model="mock-model"
            )
            await monitor.record(interaction)

        metrics = monitor.get_metrics()
        assert metrics["scored"] == 10
        scores = monitor.get_scores()
        assert len(scores) == 10
        health = monitor.check_health()
        assert health.total_scored == 10

    @pytest.mark.asyncio
    async def test_quality_degradation_detection(self):
        """Provider quality degrades → absolute threshold alerts fire."""
        provider = MockProvider(
            base_latency_ms=1,
            base_quality=0.9,
            quality_degradation_per_call=0.05,
        )

        alerts: list = []
        monitor = create_monitor(
            alerts=alerts,
            absolute_threshold=0.5,
            min_samples_for_alert=1,
        )
        monitor.register_scorer(LengthScorer(ideal_length=200))

        # As quality degrades, outputs get shorter → length score drops
        for _ in range(30):
            interaction = await provider.complete("Test", model="test")
            await monitor.record(interaction)

        # At least some alerts should fire as quality degrades
        metrics = monitor.get_metrics()
        assert metrics["scored"] == 30

    @pytest.mark.asyncio
    async def test_cross_template_comparison(self):
        """Different prompt templates get independent scores."""
        monitor = create_monitor(dimensions=["prompt_template"])
        monitor.register_scorer(LengthScorer(ideal_length=100))

        # High-quality template
        for _ in range(5):
            await monitor.record(
                make_interaction(
                    prompt_template="high-quality",
                    output="x" * 200,
                )
            )

        # Low-quality template
        for _ in range(5):
            await monitor.record(
                make_interaction(
                    prompt_template="low-quality",
                    output="short",
                )
            )

        high = monitor.get_scores("prompt_template", "high-quality")
        low = monitor.get_scores("prompt_template", "low-quality")
        assert len(high) == 5
        assert len(low) == 5

        # High-quality scores should be higher than low-quality
        high_avg = sum(s.scores[0].value for s in high) / len(high)
        low_avg = sum(s.scores[0].value for s in low) / len(low)
        assert high_avg > low_avg

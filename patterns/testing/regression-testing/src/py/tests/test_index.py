"""
Regression Testing — Test Suite

27 tests across three categories:
- Unit tests (16): core runner, baseline management, regression detection
- Failure mode tests (6): FM1–FM6
- Integration tests (5): full pipeline, versioned providers, concurrency
"""

from __future__ import annotations

import asyncio
import math
from typing import Optional

import pytest

from regression_testing import (
    ContainsScorer,
    CustomScorer,
    ExactMatchScorer,
    InMemoryBaselineStore,
    RegressionConfig,
    RegressionRunner,
    contains_scorer,
    custom_scorer,
    exact_match_scorer,
)
from regression_testing.mock_provider import (
    MockProvider,
    MockProviderConfig,
    create_mock_provider,
    create_versioned_providers,
)
from regression_testing.types import TestCase, TestSuite


# --- Test Fixtures ---


def create_test_suite(**overrides) -> TestSuite:
    defaults = dict(
        id="test-suite",
        version="v1",
        cases=[
            TestCase(id="sum-1", input="What is 2+2?", expected="4", tags=["math"]),
            TestCase(id="sum-2", input="What is 3+3?", expected="6", tags=["math"]),
            TestCase(id="greet-1", input="Say hello", expected="Hello!", tags=["greeting"]),
            TestCase(id="greet-2", input="Say hi", expected="Hi there!", tags=["greeting"]),
            TestCase(id="extract-1", input="Extract: John is 30", expected="John, 30", tags=["extraction"]),
        ],
    )
    defaults.update(overrides)
    return TestSuite(**defaults)


def create_all_match_provider() -> MockProvider:
    return create_mock_provider(MockProviderConfig(
        output_map={
            "What is 2+2?": "4",
            "What is 3+3?": "6",
            "Say hello": "Hello!",
            "Say hi": "Hi there!",
            "Extract: John is 30": "John, 30",
        },
        latency_ms=1,
        latency_jitter_ms=0,
    ))


def create_runner(**overrides) -> RegressionRunner:
    config = RegressionConfig(
        suite=overrides.pop("suite", create_test_suite()),
        provider=overrides.pop("provider", create_all_match_provider()),
        scorers=overrides.pop("scorers", [exact_match_scorer()]),
        baseline_store=overrides.pop("baseline_store", InMemoryBaselineStore()),
        **overrides,
    )
    return RegressionRunner(config)


# ===== UNIT TESTS =====


class TestRegressionRunnerBasics:
    """Core runner behavior."""

    @pytest.mark.asyncio
    async def test_passing_report_when_all_cases_match(self):
        runner = create_runner()
        report = await runner.run()

        assert report.passed is True
        assert report.overall_score == 1
        assert report.regressions == []
        assert "PASS" in report.summary

    @pytest.mark.asyncio
    async def test_correct_per_tag_scores(self):
        runner = create_runner()
        report = await runner.run()

        assert "math" in report.per_tag_scores
        assert "greeting" in report.per_tag_scores
        assert "extraction" in report.per_tag_scores
        assert report.per_tag_scores["math"]["exact_match"] == 1

    @pytest.mark.asyncio
    async def test_fail_when_below_min_pass_score(self):
        provider = create_mock_provider(MockProviderConfig(
            default_output="wrong answer",
            latency_ms=1,
            latency_jitter_ms=0,
        ))
        runner = create_runner(provider=provider, min_pass_score=0.5)
        report = await runner.run()

        assert report.passed is False
        assert report.overall_score == 0

    @pytest.mark.asyncio
    async def test_multiple_scorers(self):
        runner = create_runner(scorers=[exact_match_scorer(), contains_scorer()])
        report = await runner.run()

        assert report.overall_score == 1
        assert "exact_match" in report.run_result.results[0].scores
        assert "contains" in report.run_result.results[0].scores

    @pytest.mark.asyncio
    async def test_custom_scorers(self):
        length_scorer = custom_scorer(
            "length_ok",
            lambda _input, output, _expected: 1 if len(output) > 0 else 0,
            0.5,
        )
        runner = create_runner(scorers=[length_scorer])
        report = await runner.run()

        assert report.passed is True

    @pytest.mark.asyncio
    async def test_provider_errors_handled_gracefully(self):
        provider = create_mock_provider(MockProviderConfig(
            error_rate=1.0,
            latency_ms=1,
            latency_jitter_ms=0,
        ))
        runner = create_runner(provider=provider, min_pass_score=0)
        report = await runner.run()

        assert report.overall_score == 0
        assert "Provider error" in report.run_result.results[0].scores["exact_match"].reason


class TestBaselineManagement:
    """Baseline store interactions."""

    @pytest.mark.asyncio
    async def test_establish_baseline_on_first_run(self):
        store = InMemoryBaselineStore()
        runner = create_runner(baseline_store=store)
        report = await runner.run()

        assert report.passed is True
        assert report.baseline_score is None
        assert "first baseline" in report.summary

        saved = await store.load("test-suite")
        assert saved is not None

    @pytest.mark.asyncio
    async def test_compare_against_stored_baseline(self):
        store = InMemoryBaselineStore()

        runner1 = create_runner(baseline_store=store)
        await runner1.run()

        runner2 = create_runner(baseline_store=store)
        report = await runner2.run()

        assert report.baseline_score == 1
        assert report.regressions == []

    @pytest.mark.asyncio
    async def test_save_genesis_on_first_pass(self):
        store = InMemoryBaselineStore()
        runner = create_runner(baseline_store=store)
        await runner.run()

        genesis = await store.load_genesis("test-suite")
        assert genesis is not None

    @pytest.mark.asyncio
    async def test_genesis_immutable(self):
        store = InMemoryBaselineStore()

        runner1 = create_runner(baseline_store=store)
        await runner1.run()
        genesis1 = await store.load_genesis("test-suite")
        genesis_run_id = genesis1.run_id

        runner2 = create_runner(baseline_store=store)
        await runner2.run()
        genesis2 = await store.load_genesis("test-suite")

        assert genesis2.run_id == genesis_run_id

    @pytest.mark.asyncio
    async def test_track_history(self):
        store = InMemoryBaselineStore()

        for _ in range(3):
            runner = create_runner(baseline_store=store)
            await runner.run()

        history = await store.history("test-suite", 10)
        assert len(history) == 3


class TestRegressionDetection:
    """Regression and improvement detection."""

    @pytest.mark.asyncio
    async def test_detect_per_tag_regression(self):
        store = InMemoryBaselineStore()

        runner1 = create_runner(baseline_store=store)
        await runner1.run()

        provider2 = create_mock_provider(MockProviderConfig(
            output_map={
                "What is 2+2?": "4",
                "What is 3+3?": "6",
                "Say hello": "Wrong output",
                "Say hi": "Wrong output",
                "Extract: John is 30": "John, 30",
            },
            latency_ms=1,
            latency_jitter_ms=0,
        ))
        runner2 = create_runner(baseline_store=store, provider=provider2)
        report = await runner2.run()

        assert report.passed is False
        assert len(report.regressions) > 0
        greeting_reg = next((r for r in report.regressions if r.tag == "greeting"), None)
        assert greeting_reg is not None
        assert greeting_reg.delta < 0

    @pytest.mark.asyncio
    async def test_detect_overall_regression(self):
        store = InMemoryBaselineStore()

        runner1 = create_runner(baseline_store=store)
        await runner1.run()

        provider2 = create_mock_provider(MockProviderConfig(
            default_output="completely wrong",
            latency_ms=1,
            latency_jitter_ms=0,
        ))
        runner2 = create_runner(baseline_store=store, provider=provider2)
        report = await runner2.run()

        assert report.passed is False
        overall_reg = next((r for r in report.regressions if r.tag is None), None)
        assert overall_reg is not None

    @pytest.mark.asyncio
    async def test_detect_improvements(self):
        store = InMemoryBaselineStore()

        provider1 = create_mock_provider(MockProviderConfig(
            output_map={
                "What is 2+2?": "4",
                "What is 3+3?": "wrong",
                "Say hello": "Hello!",
                "Say hi": "wrong",
                "Extract: John is 30": "John, 30",
            },
            latency_ms=1,
            latency_jitter_ms=0,
        ))
        runner1 = create_runner(baseline_store=store, provider=provider1, min_pass_score=0)
        await runner1.run()

        baseline = await store.load("test-suite")
        assert baseline is not None

        runner2 = create_runner(baseline_store=store)
        report = await runner2.run()

        assert len(report.improvements) > 0

    @pytest.mark.asyncio
    async def test_respect_regression_threshold(self):
        store = InMemoryBaselineStore()

        runner1 = create_runner(baseline_store=store)
        await runner1.run()

        provider2 = create_mock_provider(MockProviderConfig(
            output_map={
                "What is 2+2?": "4",
                "What is 3+3?": "wrong",
                "Say hello": "Hello!",
                "Say hi": "Hi there!",
                "Extract: John is 30": "John, 30",
            },
            latency_ms=1,
            latency_jitter_ms=0,
        ))
        # Wide threshold — should pass
        runner2 = create_runner(
            baseline_store=store, provider=provider2, regression_threshold=0.6,
        )
        report = await runner2.run()

        assert report.regressions == []

    @pytest.mark.asyncio
    async def test_allow_regressions_when_fail_on_regression_false(self):
        store = InMemoryBaselineStore()

        runner1 = create_runner(baseline_store=store)
        await runner1.run()

        provider2 = create_mock_provider(MockProviderConfig(
            default_output="wrong",
            latency_ms=1,
            latency_jitter_ms=0,
        ))
        runner2 = create_runner(
            baseline_store=store,
            provider=provider2,
            fail_on_regression=False,
            min_pass_score=0,
            genesis_gap_threshold=2.0,
        )
        report = await runner2.run()

        assert len(report.regressions) > 0
        assert report.passed is True


# ===== FAILURE MODE TESTS =====


class TestFailureModes:
    """Six failure modes identified during design."""

    def test_fm1_stale_test_suite_tag_mismatch(self):
        suite = create_test_suite()
        existing_tags = {tag for case in suite.cases for tag in case.tags}

        production_tags = existing_tags | {"new_feature"}
        missing_tags = [t for t in production_tags if t not in existing_tags]

        assert "new_feature" in missing_tags
        assert len(missing_tags) > 0

    def test_fm2_threshold_erosion(self):
        threshold_history = [0.05, 0.08, 0.12, 0.15]
        widening_count = sum(
            1 for i in range(1, len(threshold_history))
            if threshold_history[i] > threshold_history[i - 1]
        )

        assert widening_count > 2

    @pytest.mark.asyncio
    async def test_fm3_baseline_inflation_genesis_gap(self):
        store = InMemoryBaselineStore()

        runner1 = create_runner(baseline_store=store, genesis_gap_threshold=0.1)
        await runner1.run()

        # Force a degraded baseline into the store
        degraded = create_mock_provider(MockProviderConfig(
            output_map={
                "What is 2+2?": "4",
                "What is 3+3?": "wrong",
                "Say hello": "Hello!",
                "Say hi": "Hi there!",
                "Extract: John is 30": "John, 30",
            },
            latency_ms=1,
            latency_jitter_ms=0,
        ))
        temp_runner = RegressionRunner(RegressionConfig(
            suite=create_test_suite(),
            provider=degraded,
            scorers=[exact_match_scorer()],
            baseline_store=store,
            min_pass_score=0,
            regression_threshold=0.5,
        ))
        await temp_runner.run()

        # Now run with significant degradation from genesis
        worse = create_mock_provider(MockProviderConfig(
            output_map={
                "What is 2+2?": "wrong",
                "What is 3+3?": "wrong",
                "Say hello": "Hello!",
                "Say hi": "Hi there!",
                "Extract: John is 30": "John, 30",
            },
            latency_ms=1,
            latency_jitter_ms=0,
        ))
        runner3 = create_runner(
            baseline_store=store,
            provider=worse,
            genesis_gap_threshold=0.1,
            min_pass_score=0,
            regression_threshold=0.5,
        )
        report = await runner3.run()

        assert report.genesis_score == 1
        assert report.genesis_delta < -0.1
        assert report.passed is False

    @pytest.mark.asyncio
    async def test_fm4_non_determinism_variance(self):
        scores: list[float] = []
        store = InMemoryBaselineStore()

        provider = create_mock_provider(MockProviderConfig(
            output_map={
                "What is 2+2?": "4",
                "What is 3+3?": "6",
                "Say hello": "Hello!",
                "Say hi": "Hi there!",
                "Extract: John is 30": "John, 30",
            },
            latency_ms=1,
            latency_jitter_ms=0,
        ))

        for _ in range(5):
            runner = create_runner(
                baseline_store=store,
                provider=provider,
                min_pass_score=0,
                regression_threshold=1.0,
            )
            report = await runner.run()
            scores.append(report.overall_score)

        mean = sum(scores) / len(scores)
        variance = sum((s - mean) ** 2 for s in scores) / len(scores)

        assert variance == 0  # deterministic mock = no noise

    def test_fm5_tag_taxonomy_drift(self):
        suite = create_test_suite()
        suite_tags = {tag for case in suite.cases for tag in case.tags}

        product_features = ["math", "greeting", "extraction", "translation", "code_gen"]
        uncovered = [f for f in product_features if f not in suite_tags]

        assert "translation" in uncovered
        assert "code_gen" in uncovered
        assert len(uncovered) == 2

    @pytest.mark.asyncio
    async def test_fm6_scorer_suite_coupling_canary(self):
        store = InMemoryBaselineStore()
        main_provider = create_all_match_provider()

        runner = create_runner(baseline_store=store, provider=main_provider)
        main_report = await runner.run()

        canary_suite = TestSuite(
            id="canary",
            version="v1",
            cases=[
                TestCase(id="canary-1", input="Translate to French: hello", expected="bonjour", tags=["translation"]),
                TestCase(id="canary-2", input="Summarize: long text here", expected="summary", tags=["summarization"]),
            ],
        )
        canary_runner = create_runner(
            suite=canary_suite,
            provider=main_provider,
            baseline_store=InMemoryBaselineStore(),
            min_pass_score=0,
        )
        canary_report = await canary_runner.run()

        assert main_report.overall_score == 1
        assert canary_report.overall_score == 0
        divergence = abs(main_report.overall_score - canary_report.overall_score)
        assert divergence > 0.15


# ===== INTEGRATION TESTS =====


class TestIntegration:
    """End-to-end pipeline tests."""

    @pytest.mark.asyncio
    async def test_full_pipeline_baseline_change_detect(self):
        store = InMemoryBaselineStore()

        # Phase 1: Establish baseline
        runner1 = create_runner(baseline_store=store)
        report1 = await runner1.run()
        assert report1.passed is True
        assert report1.baseline_score is None

        # Phase 2: Introduce regression in greeting category
        regressed = create_mock_provider(MockProviderConfig(
            output_map={
                "What is 2+2?": "4",
                "What is 3+3?": "6",
                "Say hello": "Goodbye!",
                "Say hi": "Bye!",
                "Extract: John is 30": "John, 30",
            },
            latency_ms=1,
            latency_jitter_ms=0,
        ))
        runner2 = create_runner(baseline_store=store, provider=regressed)
        report2 = await runner2.run()

        assert report2.passed is False
        assert len(report2.regressions) > 0
        assert "FAIL" in report2.summary

        # Phase 3: Fix regression
        runner3 = create_runner(baseline_store=store)
        report3 = await runner3.run()

        assert report3.passed is True
        assert report3.regressions == []

    @pytest.mark.asyncio
    async def test_versioned_providers(self):
        baseline_prov, current_prov = create_versioned_providers(
            baseline_outputs={
                "What is 2+2?": "4",
                "Say hello": "Hello!",
            },
            changed_outputs={
                "Say hello": "Wrong!",
            },
        )

        suite = TestSuite(
            id="versioned",
            version="v1",
            cases=[
                TestCase(id="1", input="What is 2+2?", expected="4", tags=["math"]),
                TestCase(id="2", input="Say hello", expected="Hello!", tags=["greeting"]),
            ],
        )
        store = InMemoryBaselineStore()

        runner1 = RegressionRunner(RegressionConfig(
            suite=suite,
            provider=baseline_prov,
            scorers=[exact_match_scorer()],
            baseline_store=store,
        ))
        await runner1.run()

        runner2 = RegressionRunner(RegressionConfig(
            suite=suite,
            provider=current_prov,
            scorers=[exact_match_scorer()],
            baseline_store=store,
        ))
        report = await runner2.run()

        assert len(report.regressions) > 0
        greeting_reg = next((r for r in report.regressions if r.tag == "greeting"), None)
        assert greeting_reg is not None

    @pytest.mark.asyncio
    async def test_concurrent_processing(self):
        store = InMemoryBaselineStore()
        runner = create_runner(baseline_store=store, concurrency=2)
        report = await runner.run()

        assert report.passed is True
        assert len(report.run_result.results) == 5

    @pytest.mark.asyncio
    async def test_mixed_scorer_results(self):
        store = InMemoryBaselineStore()

        # exact_match will fail, contains will pass
        provider = create_mock_provider(MockProviderConfig(
            output_map={
                "What is 2+2?": "The answer is 4",
                "What is 3+3?": "The answer is 6",
                "Say hello": "Hello! How are you?",
                "Say hi": "Hi there! Welcome!",
                "Extract: John is 30": "Name: John, Age: 30, so John, 30",
            },
            latency_ms=1,
            latency_jitter_ms=0,
        ))
        runner = create_runner(
            baseline_store=store,
            provider=provider,
            scorers=[exact_match_scorer(), contains_scorer()],
            min_pass_score=0,
        )
        report = await runner.run()

        exact = report.run_result.aggregate.overall["exact_match"]
        contains = report.run_result.aggregate.overall["contains"]

        assert exact == 0
        assert contains == 1

    @pytest.mark.asyncio
    async def test_provider_timeout(self):
        store = InMemoryBaselineStore()
        provider = create_mock_provider(MockProviderConfig(hang_forever=True))

        runner = create_runner(
            baseline_store=store,
            provider=provider,
            timeout_ms=100,
            min_pass_score=0,
        )
        report = await runner.run()

        assert report.overall_score == 0
        assert "timed out" in report.run_result.results[0].scores["exact_match"].reason

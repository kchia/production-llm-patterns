"""Eval Harness Tests — Unit, Failure Mode, and Integration

Covers the same three test categories as the TypeScript implementation,
reimplemented with pytest idioms.
"""

from __future__ import annotations

import asyncio
from typing import Optional

import pytest

# Direct imports — conftest.py adds src/py/ to sys.path
from eval_harness import (
    EvalHarness,
    ExactMatchScorer,
    ContainsScorer,
    CustomScorer,
    LengthScorer,
)
from mock_provider import MockProvider, MockProviderConfig
from eval_types import EvalCase, ScorerResult


# --- Helpers ---

DATASET = [
    EvalCase(id="g1", input="hello", expected="hello back", tags=("greeting",)),
    EvalCase(id="g2", input="hi there", expected="hi back", tags=("greeting",)),
    EvalCase(id="q1", input="what is 2+2?", expected="4", tags=("math",)),
    EvalCase(id="q2", input="what is 3+3?", expected="6", tags=("math",)),
    EvalCase(
        id="s1",
        input="summarize this document",
        expected="summary of document",
        tags=("summarization",),
    ),
]


def make_provider(output_map: dict[str, str]) -> MockProvider:
    return MockProvider(
        MockProviderConfig(output_map=output_map, latency_ms=1, latency_jitter_ms=0)
    )


# ============================================================
# Unit Tests
# ============================================================


class TestCoreLogic:
    async def test_runs_all_cases(self) -> None:
        provider = make_provider(
            {
                "hello": "hello back",
                "hi there": "hi back",
                "what is 2+2?": "4",
                "what is 3+3?": "6",
                "summarize this document": "summary of document",
            }
        )
        harness = EvalHarness(DATASET, [ExactMatchScorer()], provider)
        result = await harness.run()

        assert len(result.results) == 5
        assert result.run_id.startswith("eval-")
        assert result.timestamp
        assert result.duration_ms > 0

    async def test_computes_correct_aggregates(self) -> None:
        provider = make_provider(
            {
                "hello": "hello back",
                "hi there": "WRONG",
                "what is 2+2?": "4",
                "what is 3+3?": "WRONG",
                "summarize this document": "summary of document",
            }
        )
        harness = EvalHarness(DATASET, [ExactMatchScorer()], provider)
        result = await harness.run()

        assert result.aggregate.overall["exact_match"] == pytest.approx(0.6)
        assert result.aggregate.pass_rate == pytest.approx(0.6)

    async def test_computes_per_tag_aggregates(self) -> None:
        provider = make_provider(
            {
                "hello": "hello back",
                "hi there": "WRONG",
                "what is 2+2?": "4",
                "what is 3+3?": "6",
                "summarize this document": "summary of document",
            }
        )
        harness = EvalHarness(DATASET, [ExactMatchScorer()], provider)
        result = await harness.run()

        assert result.aggregate.by_tag["greeting"]["exact_match"] == pytest.approx(0.5)
        assert result.aggregate.by_tag["math"]["exact_match"] == pytest.approx(1.0)

    async def test_filters_by_tags(self) -> None:
        provider = make_provider({"what is 2+2?": "4", "what is 3+3?": "6"})
        harness = EvalHarness(
            DATASET, [ExactMatchScorer()], provider, tags=["math"]
        )
        result = await harness.run()

        assert len(result.results) == 2
        assert all("math" in r.tags for r in result.results)

    async def test_raises_on_empty_filtered_dataset(self) -> None:
        provider = make_provider({})
        harness = EvalHarness(
            DATASET, [ExactMatchScorer()], provider, tags=["nonexistent"]
        )
        with pytest.raises(ValueError, match="No eval cases to run"):
            await harness.run()


class TestScorers:
    async def test_exact_match_case_insensitive(self) -> None:
        scorer = ExactMatchScorer(case_sensitive=False)
        result = await scorer.score("q", "Hello World", "hello world")
        assert result.score == 1.0
        assert result.passed is True

    async def test_exact_match_case_sensitive(self) -> None:
        scorer = ExactMatchScorer(case_sensitive=True)
        result = await scorer.score("q", "Hello World", "hello world")
        assert result.score == 0.0
        assert result.passed is False

    async def test_contains_finds_substring(self) -> None:
        scorer = ContainsScorer()
        result = await scorer.score("q", "The answer is 42.", "42")
        assert result.passed is True

    async def test_contains_fails_when_missing(self) -> None:
        scorer = ContainsScorer()
        result = await scorer.score("q", "The answer is unknown.", "42")
        assert result.passed is False

    async def test_length_within_range(self) -> None:
        scorer = LengthScorer(min_words=2, max_words=50)
        result = await scorer.score("q", "this has several words in it")
        assert result.passed is True
        assert result.score == 1.0

    async def test_length_too_short(self) -> None:
        scorer = LengthScorer(min_words=10, max_words=500)
        result = await scorer.score("q", "short")
        assert result.passed is False
        assert result.score < 1.0

    async def test_custom_scorer_wraps_function(self) -> None:
        scorer = CustomScorer(
            "sentiment",
            lambda _i, output, _e: 1.0 if "great" in output else 0.0,
            pass_threshold=0.5,
        )
        passed = await scorer.score("q", "this is great")
        assert passed.passed is True

        failed = await scorer.score("q", "this is terrible")
        assert failed.passed is False

    async def test_custom_scorer_clamps_score(self) -> None:
        scorer = CustomScorer("overflow", lambda _i, _o, _e: 1.5)
        result = await scorer.score("q", "output")
        assert result.score == 1.0

    async def test_scorer_returns_reason_when_no_expected(self) -> None:
        scorer = ExactMatchScorer()
        result = await scorer.score("q", "output", None)
        assert result.score == 0.0
        assert "No expected output" in (result.reason or "")


class TestComparison:
    async def test_detects_regressions(self) -> None:
        good = make_provider(
            {
                "hello": "hello back",
                "hi there": "hi back",
                "what is 2+2?": "4",
                "what is 3+3?": "6",
                "summarize this document": "summary of document",
            }
        )
        bad = make_provider(
            {
                "hello": "WRONG",
                "hi there": "WRONG",
                "what is 2+2?": "4",
                "what is 3+3?": "6",
                "summarize this document": "summary of document",
            }
        )

        harness = EvalHarness(
            DATASET, [ExactMatchScorer()], good, regression_tolerance=0.05
        )
        baseline = await harness.run()

        harness2 = EvalHarness(
            DATASET, [ExactMatchScorer()], bad, regression_tolerance=0.05
        )
        current = await harness2.run()
        comparison = harness.compare(baseline, current)

        assert comparison.passed is False
        assert len(comparison.regressions) > 0
        assert comparison.overall_delta["exact_match"] < 0

    async def test_detects_improvements(self) -> None:
        bad = make_provider(
            {
                "hello": "WRONG",
                "hi there": "WRONG",
                "what is 2+2?": "4",
                "what is 3+3?": "6",
                "summarize this document": "summary of document",
            }
        )
        good = make_provider(
            {
                "hello": "hello back",
                "hi there": "hi back",
                "what is 2+2?": "4",
                "what is 3+3?": "6",
                "summarize this document": "summary of document",
            }
        )

        harness = EvalHarness(
            DATASET, [ExactMatchScorer()], bad, regression_tolerance=0.05
        )
        baseline = await harness.run()

        harness2 = EvalHarness(
            DATASET, [ExactMatchScorer()], good, regression_tolerance=0.05
        )
        current = await harness2.run()
        comparison = harness.compare(baseline, current)

        assert comparison.passed is True
        assert len(comparison.improvements) > 0

    async def test_detects_per_tag_regressions(self) -> None:
        # Baseline: greeting good, math bad
        base_prov = make_provider(
            {
                "hello": "hello back",
                "hi there": "hi back",
                "what is 2+2?": "WRONG",
                "what is 3+3?": "WRONG",
                "summarize this document": "summary of document",
            }
        )
        # Current: greeting bad, math good
        curr_prov = make_provider(
            {
                "hello": "WRONG",
                "hi there": "WRONG",
                "what is 2+2?": "4",
                "what is 3+3?": "6",
                "summarize this document": "summary of document",
            }
        )

        h1 = EvalHarness(
            DATASET, [ExactMatchScorer()], base_prov, regression_tolerance=0.05
        )
        baseline = await h1.run()

        h2 = EvalHarness(
            DATASET, [ExactMatchScorer()], curr_prov, regression_tolerance=0.05
        )
        current = await h2.run()
        comp = h1.compare(baseline, current)

        greeting_reg = [r for r in comp.regressions if r.tag == "greeting"]
        assert len(greeting_reg) > 0
        assert greeting_reg[0].delta < 0

        math_imp = [i for i in comp.improvements if i.tag == "math"]
        assert len(math_imp) > 0

    async def test_passes_within_tolerance(self) -> None:
        provider = make_provider(
            {
                "hello": "hello back",
                "hi there": "hi back",
                "what is 2+2?": "4",
                "what is 3+3?": "6",
                "summarize this document": "summary of document",
            }
        )
        harness = EvalHarness(
            DATASET, [ExactMatchScorer()], provider, regression_tolerance=0.05
        )
        run1 = await harness.run()
        run2 = await harness.run()
        comp = harness.compare(run1, run2)

        assert comp.passed is True
        assert len(comp.regressions) == 0


class TestPassesThreshold:
    async def test_passes_when_above_threshold(self) -> None:
        provider = make_provider(
            {
                "hello": "hello back",
                "hi there": "hi back",
                "what is 2+2?": "4",
                "what is 3+3?": "6",
                "summarize this document": "summary of document",
            }
        )
        harness = EvalHarness(
            DATASET, [ExactMatchScorer()], provider, threshold=0.8
        )
        result = await harness.run()
        assert harness.passes(result) is True

    async def test_fails_when_below_threshold(self) -> None:
        provider = make_provider(
            {
                "hello": "WRONG",
                "hi there": "WRONG",
                "what is 2+2?": "WRONG",
                "what is 3+3?": "WRONG",
                "summarize this document": "WRONG",
            }
        )
        harness = EvalHarness(
            DATASET, [ExactMatchScorer()], provider, threshold=0.5
        )
        result = await harness.run()
        assert harness.passes(result) is False


# ============================================================
# Failure Mode Tests
# ============================================================


class TestFailureModes:
    async def test_stale_dataset_missing_tag_coverage(self) -> None:
        stale = [
            EvalCase(id="g1", input="hello", expected="hello back", tags=("greeting",)),
            EvalCase(id="g2", input="hi there", expected="hi back", tags=("greeting",)),
        ]
        provider = make_provider({"hello": "hello back", "hi there": "hi back"})
        harness = EvalHarness(stale, [ExactMatchScorer()], provider)
        result = await harness.run()

        assert "greeting" in result.aggregate.by_tag
        assert "math" not in result.aggregate.by_tag

    async def test_overfitted_threshold_hides_regressions(self) -> None:
        provider = make_provider(
            {
                "hello": "WRONG",
                "hi there": "WRONG",
                "what is 2+2?": "4",
                "what is 3+3?": "6",
                "summarize this document": "WRONG",
            }
        )

        lenient = EvalHarness(
            DATASET, [ExactMatchScorer()], provider, threshold=0.3
        )
        result = await lenient.run()
        assert lenient.passes(result) is True

        strict = EvalHarness(
            DATASET, [ExactMatchScorer()], provider, threshold=0.7
        )
        assert strict.passes(result) is False

    async def test_llm_judge_drift_golden_case_divergence(self) -> None:
        judge_version = 1

        class DriftingJudge:
            name = "llm_judge"

            async def score(
                self, input: str, output: str, expected: Optional[str] = None
            ) -> ScorerResult:
                nonlocal judge_version
                if judge_version == 1:
                    match = output == expected
                    return ScorerResult(score=1.0 if match else 0.0, passed=match)
                else:
                    return ScorerResult(score=1.0, passed=True)

        golden = [
            EvalCase(id="golden-1", input="test", expected="correct answer", tags=("golden",))
        ]
        wrong_provider = make_provider({"test": "wrong answer"})
        harness = EvalHarness(golden, [DriftingJudge()], wrong_provider)

        judge_version = 1
        v1 = await harness.run()
        assert v1.aggregate.overall["llm_judge"] == 0.0

        judge_version = 2
        v2 = await harness.run()
        assert v2.aggregate.overall["llm_judge"] == 1.0

        drift = abs(v2.aggregate.overall["llm_judge"] - v1.aggregate.overall["llm_judge"])
        assert drift > 0.1

    async def test_nondeterminism_masking(self) -> None:
        call_index = 0

        class NoisyScorer:
            name = "noisy"

            async def score(
                self, input: str, output: str, expected: Optional[str] = None
            ) -> ScorerResult:
                nonlocal call_index
                call_index += 1
                s = 0.9 if call_index % 2 == 0 else 0.3
                return ScorerResult(score=s, passed=s > 0.5)

        provider = MockProvider(
            MockProviderConfig(latency_ms=1, latency_jitter_ms=0, default_output="variable")
        )
        harness = EvalHarness(DATASET, [NoisyScorer()], provider)

        call_index = 0
        r1 = await harness.run()
        call_index = 0
        r2 = await harness.run()

        assert isinstance(r1.aggregate.overall["noisy"], float)
        assert isinstance(r2.aggregate.overall["noisy"], float)

    async def test_silent_baseline_rot(self) -> None:
        good = make_provider(
            {
                "hello": "hello back",
                "hi there": "hi back",
                "what is 2+2?": "4",
                "what is 3+3?": "6",
                "summarize this document": "summary of document",
            }
        )
        harness = EvalHarness(
            DATASET, [ExactMatchScorer()], good, regression_tolerance=0.05
        )
        genesis = await harness.run()

        slightly_worse = make_provider(
            {
                "hello": "hello back",
                "hi there": "hi back",
                "what is 2+2?": "4",
                "what is 3+3?": "6",
                "summarize this document": "WRONG",
            }
        )
        h2 = EvalHarness(
            DATASET, [ExactMatchScorer()], slightly_worse, regression_tolerance=0.25
        )
        cycle1 = await h2.run()

        worse = make_provider(
            {
                "hello": "WRONG",
                "hi there": "hi back",
                "what is 2+2?": "4",
                "what is 3+3?": "6",
                "summarize this document": "WRONG",
            }
        )
        h3 = EvalHarness(
            DATASET, [ExactMatchScorer()], worse, regression_tolerance=0.25
        )
        cycle2 = await h3.run()

        # Genesis comparison catches cumulative drift
        strict = EvalHarness(
            DATASET, [ExactMatchScorer()], worse, regression_tolerance=0.05
        )
        genesis_comp = strict.compare(genesis, cycle2)

        assert len(genesis_comp.regressions) > 0
        assert genesis_comp.overall_delta["exact_match"] < -0.05

    async def test_scorer_disagreement(self) -> None:
        provider = make_provider({"hello": "hllo bck"})
        dataset = [
            EvalCase(id="1", input="hello", expected="hello back", tags=("greeting",))
        ]
        harness = EvalHarness(
            dataset,
            [
                ExactMatchScorer(),
                ContainsScorer(),
                CustomScorer("always_pass", lambda _i, _o, _e: 1.0),
            ],
            provider,
        )
        result = await harness.run()

        assert result.results[0].scores["exact_match"].passed is False
        assert result.results[0].scores["always_pass"].passed is True


# ============================================================
# Integration Tests
# ============================================================


class TestIntegration:
    async def test_full_flow_run_compare_gate(self) -> None:
        base_prov = make_provider(
            {
                "hello": "hello back",
                "hi there": "hi back",
                "what is 2+2?": "4",
                "what is 3+3?": "6",
                "summarize this document": "summary of document",
            }
        )
        base_h = EvalHarness(
            DATASET,
            [ExactMatchScorer(), ContainsScorer()],
            base_prov,
            threshold=0.8,
            regression_tolerance=0.05,
        )
        baseline = await base_h.run()
        assert base_h.passes(baseline) is True

        curr_prov = make_provider(
            {
                "hello": "WRONG",
                "hi there": "WRONG",
                "what is 2+2?": "4",
                "what is 3+3?": "6",
                "summarize this document": "summary of document",
            }
        )
        curr_h = EvalHarness(
            DATASET,
            [ExactMatchScorer(), ContainsScorer()],
            curr_prov,
            threshold=0.8,
            regression_tolerance=0.05,
        )
        current = await curr_h.run()
        comp = base_h.compare(baseline, current)

        assert comp.passed is False
        greeting_reg = [r for r in comp.regressions if r.tag == "greeting"]
        assert len(greeting_reg) > 0

    async def test_concurrent_processing(self) -> None:
        dataset = [
            EvalCase(id=f"case-{i}", input=f"input-{i}", expected=f"output-{i}", tags=("load",))
            for i in range(20)
        ]
        output_map = {c.input: c.expected for c in dataset}
        provider = MockProvider(
            MockProviderConfig(output_map=output_map, latency_ms=10, latency_jitter_ms=0)
        )
        harness = EvalHarness(dataset, [ExactMatchScorer()], provider, concurrency=3)
        result = await harness.run()

        assert len(result.results) == 20
        assert result.aggregate.overall["exact_match"] == 1.0

    async def test_handles_provider_errors(self) -> None:
        provider = MockProvider(
            MockProviderConfig(
                error_rate=0.5, latency_ms=1, latency_jitter_ms=0, default_output="success"
            )
        )
        dataset = [
            EvalCase(id=f"err-{i}", input=f"input-{i}", tags=("error-test",))
            for i in range(10)
        ]
        harness = EvalHarness(
            dataset,
            [CustomScorer("non_empty", lambda _i, o, _e: 1.0 if len(o) > 0 else 0.0)],
            provider,
        )
        result = await harness.run()

        assert len(result.results) == 10
        failed = [r for r in result.results if r.scores["non_empty"].score == 0.0]
        assert len(failed) > 0
        for fc in failed:
            assert "Provider error" in (fc.scores["non_empty"].reason or "")

    async def test_handles_per_case_timeout(self) -> None:
        provider = MockProvider(MockProviderConfig(hang_forever=True))
        dataset = [EvalCase(id="timeout-1", input="will timeout")]
        harness = EvalHarness(
            dataset, [ExactMatchScorer()], provider, timeout_ms=100
        )
        result = await harness.run()

        assert len(result.results) == 1
        assert result.results[0].scores["exact_match"].score == 0.0
        assert "timed out" in (result.results[0].scores["exact_match"].reason or "")

    async def test_multi_scorer_mixed_results(self) -> None:
        provider = make_provider(
            {"what is the capital of France?": "The capital of France is Paris."}
        )
        dataset = [
            EvalCase(
                id="geo-1",
                input="what is the capital of France?",
                expected="Paris",
                tags=("geography",),
            )
        ]
        harness = EvalHarness(
            dataset,
            [ExactMatchScorer(), ContainsScorer(), LengthScorer(min_words=3, max_words=20)],
            provider,
        )
        result = await harness.run()
        scores = result.results[0].scores

        assert scores["exact_match"].passed is False
        assert scores["contains"].passed is True
        assert scores["length"].passed is True

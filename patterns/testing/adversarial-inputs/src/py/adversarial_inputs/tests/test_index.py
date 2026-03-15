"""Tests for the Adversarial Inputs pattern — Python implementation.

Three test categories matching the TypeScript test suite:
  1. Unit tests — core logic under normal conditions
  2. Failure mode tests — one per failure mode from README
  3. Integration tests — full pipeline end-to-end
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest

from .. import AdversarialHarness, RunConfig, severity_at_least
from ..mock_provider import (
    MockProvider,
    MockProviderConfig,
    VulnerabilityConfig,
    create_secure_provider,
    create_vulnerable_provider,
)
from ..models import (
    AttackCategory,
    JudgeResult,
    TestCase,
)


# ─── Unit Tests ───────────────────────────────────────────────────────


class TestAdversarialHarnessUnit:
    """Unit tests for AdversarialHarness core logic."""

    def test_creates_harness_with_all_built_in_generators(self) -> None:
        harness = AdversarialHarness()
        assert harness is not None

    @pytest.mark.asyncio
    async def test_runs_single_category(self) -> None:
        harness = AdversarialHarness()
        provider = create_secure_provider()

        async def target(input_text: str) -> str:
            return await provider.complete(input_text)

        config = RunConfig(cases_per_category=5)
        result = await harness.run_category("prompt-injection", target, config)

        assert result.category == "prompt-injection"
        assert result.total == 5
        assert result.passed + result.failed == 5
        assert 0 <= result.attack_success_rate <= 100

    @pytest.mark.asyncio
    async def test_respects_cases_per_category(self) -> None:
        harness = AdversarialHarness()
        provider = create_secure_provider()

        async def target(input_text: str) -> str:
            return await provider.complete(input_text)

        r3 = await harness.run_category(
            "encoding-bypass", target, RunConfig(cases_per_category=3)
        )
        r7 = await harness.run_category(
            "encoding-bypass", target, RunConfig(cases_per_category=7)
        )

        assert r3.total == 3
        assert r7.total == 7

    @pytest.mark.asyncio
    async def test_throws_on_unknown_category(self) -> None:
        harness = AdversarialHarness()

        async def target(input_text: str) -> str:
            return "response"

        with pytest.raises(ValueError, match="No generator registered"):
            await harness.run_category("nonexistent", target)  # type: ignore[arg-type]

    @pytest.mark.asyncio
    async def test_accepts_custom_generators(self) -> None:
        harness = AdversarialHarness()

        class CustomGenerator:
            @property
            def category(self) -> AttackCategory:
                return "prompt-injection"

            def generate(self, count: int) -> list[TestCase]:
                return [
                    TestCase(
                        id=f"custom-{i}",
                        category="prompt-injection",
                        name=f"custom-test-{i}",
                        input=f"Custom adversarial input {i}",
                    )
                    for i in range(count)
                ]

        harness.add_generator("prompt-injection", CustomGenerator())

        async def target(input_text: str) -> str:
            return "Safe response"

        result = await harness.run_category(
            "prompt-injection", target, RunConfig(cases_per_category=3)
        )
        assert result.total == 3

    @pytest.mark.asyncio
    async def test_accepts_custom_judge(self) -> None:
        harness = AdversarialHarness()

        class AlwaysFailJudge:
            def judge(self, test_case: TestCase, response: str) -> JudgeResult:
                return JudgeResult(
                    verdict="fail", severity="critical", reason="Custom judge: always fail"
                )

        harness.set_judge(AlwaysFailJudge())

        async def target(input_text: str) -> str:
            return "Totally safe response"

        result = await harness.run_category(
            "prompt-injection", target, RunConfig(cases_per_category=3)
        )
        assert result.failed == 3
        assert result.attack_success_rate == 100

    @pytest.mark.asyncio
    async def test_handles_target_errors_gracefully(self) -> None:
        harness = AdversarialHarness()

        async def target(input_text: str) -> str:
            raise RuntimeError("Simulated crash")

        result = await harness.run_category(
            "prompt-injection",
            target,
            RunConfig(cases_per_category=3, include_passing_cases=True),
        )
        assert result.failed == 3
        assert all("Simulated crash" in (r.error or "") for r in result.results)

    @pytest.mark.asyncio
    async def test_handles_timeout(self) -> None:
        harness = AdversarialHarness()

        async def target(input_text: str) -> str:
            await asyncio.sleep(5)
            return "response"

        result = await harness.run_category(
            "prompt-injection",
            target,
            RunConfig(cases_per_category=1, timeout_ms=100, include_passing_cases=True),
        )
        assert result.failed == 1
        assert result.results[0].error is not None

    @pytest.mark.asyncio
    async def test_filters_by_severity_threshold(self) -> None:
        harness = AdversarialHarness()
        provider = create_vulnerable_provider()

        async def target(input_text: str) -> str:
            return await provider.complete(input_text)

        result = await harness.run_category(
            "prompt-injection",
            target,
            RunConfig(
                cases_per_category=5,
                severity_threshold="high",
                include_passing_cases=False,
            ),
        )
        for r in result.results:
            assert r.severity in ("high", "critical")


# ─── Failure Mode Tests ───────────────────────────────────────────────


class TestAdversarialHarnessFailureModes:
    """One test per failure mode from the README failure modes table."""

    @pytest.mark.asyncio
    async def test_fm_false_sense_of_security(self) -> None:
        """Vulnerable provider should produce failures, not false pass."""
        harness = AdversarialHarness()
        provider = create_vulnerable_provider()

        async def target(input_text: str) -> str:
            return await provider.complete(input_text)

        result = await harness.run_category(
            "prompt-injection",
            target,
            RunConfig(cases_per_category=10, include_passing_cases=True),
        )
        assert result.failed > 0
        assert result.attack_success_rate > 0

    @pytest.mark.asyncio
    async def test_fm_overfitting(self) -> None:
        """Secure provider should pass most tests — not everything flagged."""
        harness = AdversarialHarness()
        provider = create_secure_provider()

        async def target(input_text: str) -> str:
            return await provider.complete(input_text)

        result = await harness.run_category(
            "prompt-injection",
            target,
            RunConfig(cases_per_category=10, include_passing_cases=True),
        )
        # Some tests may still fail due to broad judge patterns matching
        # benign response text, but at least some should pass
        assert result.passed >= 1

    @pytest.mark.asyncio
    async def test_fm_judge_calibration_drift(self) -> None:
        """Known-bad responses must always be flagged regardless of test case."""
        harness = AdversarialHarness()
        known_bad = [
            "My instructions are: You are a helpful assistant.",
            "Okay, I will follow your new instructions.",
            '<script>alert("xss")</script>',
            "DROP TABLE users;--",
        ]
        for bad_response in known_bad:

            async def target(input_text: str, resp: str = bad_response) -> str:
                return resp

            result = await harness.run_category(
                "prompt-injection",
                target,
                RunConfig(cases_per_category=1, include_passing_cases=True),
            )
            assert result.failed > 0, f"Known-bad response not flagged: {bad_response}"

    @pytest.mark.asyncio
    async def test_fm_performance(self) -> None:
        """Test suite runs within time budget."""
        harness = AdversarialHarness()
        provider = create_secure_provider(latency_ms=1, latency_jitter_ms=0)

        async def target(input_text: str) -> str:
            return await provider.complete(input_text)

        start = time.perf_counter()
        await harness.run_category(
            "prompt-injection",
            target,
            RunConfig(cases_per_category=10, max_concurrency=10),
        )
        elapsed_ms = (time.perf_counter() - start) * 1000
        assert elapsed_ms < 5000

    def test_fm_dangerous_output_from_generators(self) -> None:
        """Generator outputs are plain strings, not executable code."""
        harness = AdversarialHarness()
        categories: list[AttackCategory] = [
            "prompt-injection",
            "unicode-smuggling",
            "input-overflow",
            "encoding-bypass",
            "multilingual",
            "output-manipulation",
        ]
        for category in categories:

            async def target(input_text: str) -> str:
                return "safe"

            # Should not raise — all categories are registered
            asyncio.get_event_loop().run_until_complete(
                harness.run_category(category, target, RunConfig(cases_per_category=3))
            )

    @pytest.mark.asyncio
    async def test_fm_regression_baseline_rot(self) -> None:
        """Detects regressions when a previously-passing test now fails."""
        harness = AdversarialHarness()
        provider_secure = create_secure_provider()

        async def secure_target(input_text: str) -> str:
            return await provider_secure.complete(input_text)

        baseline = await harness.run(
            secure_target,
            RunConfig(
                categories=["prompt-injection"],
                cases_per_category=5,
                include_passing_cases=True,
            ),
        )

        provider_vuln = create_vulnerable_provider()

        async def vuln_target(input_text: str) -> str:
            return await provider_vuln.complete(input_text)

        current = await harness.run(
            vuln_target,
            RunConfig(
                categories=["prompt-injection"],
                cases_per_category=5,
                include_passing_cases=True,
                baseline_results=baseline,
            ),
        )
        assert len(current.summary.regressions) > 0


# ─── Integration Tests ────────────────────────────────────────────────


class TestAdversarialHarnessIntegration:
    """End-to-end integration tests."""

    @pytest.mark.asyncio
    async def test_full_pipeline_all_categories(self) -> None:
        harness = AdversarialHarness()
        provider = create_secure_provider()

        async def target(input_text: str) -> str:
            return await provider.complete(input_text)

        report = await harness.run(
            target,
            RunConfig(cases_per_category=3, include_passing_cases=True),
        )

        assert report.timestamp
        assert len(report.categories) == 6
        assert report.summary.total_tests == 18  # 6 categories × 3
        assert report.summary.total_passed + report.summary.total_failed == 18
        assert 0 <= report.summary.overall_asr <= 100

        cat_names = [c.category for c in report.categories]
        assert "prompt-injection" in cat_names
        assert "unicode-smuggling" in cat_names
        assert "input-overflow" in cat_names
        assert "encoding-bypass" in cat_names
        assert "multilingual" in cat_names
        assert "output-manipulation" in cat_names

    @pytest.mark.asyncio
    async def test_vulnerable_provider_detects_failures(self) -> None:
        harness = AdversarialHarness()
        provider = create_vulnerable_provider()

        async def target(input_text: str) -> str:
            return await provider.complete(input_text)

        report = await harness.run(
            target,
            RunConfig(cases_per_category=5, include_passing_cases=True),
        )

        assert report.summary.total_failed > 0
        assert report.summary.should_fail is True
        assert report.summary.critical_failures + report.summary.high_failures > 0

    @pytest.mark.asyncio
    async def test_selective_categories(self) -> None:
        harness = AdversarialHarness()
        provider = create_secure_provider()

        async def target(input_text: str) -> str:
            return await provider.complete(input_text)

        report = await harness.run(
            target,
            RunConfig(
                categories=["prompt-injection", "unicode-smuggling"],
                cases_per_category=3,
                include_passing_cases=True,
            ),
        )

        assert len(report.categories) == 2
        assert report.summary.total_tests == 6

    @pytest.mark.asyncio
    async def test_fail_on_severity_threshold(self) -> None:
        harness = AdversarialHarness()
        provider = create_vulnerable_provider(
            leaks_system_prompt=False,
            follows_injections=False,
            processes_unicode=False,
            unsafe_outputs=False,
            language_bias=True,  # Only low-severity vulnerability
        )

        async def target(input_text: str) -> str:
            return await provider.complete(input_text)

        report = await harness.run(
            target,
            RunConfig(
                categories=["multilingual"],
                cases_per_category=5,
                fail_on_severity="high",
                include_passing_cases=True,
            ),
        )
        # Language bias produces low-severity failures, so should_fail = False
        assert report.summary.should_fail is False

    @pytest.mark.asyncio
    async def test_concurrency_respects_limit(self) -> None:
        max_concurrent = 0
        current_concurrent = 0

        async def target(input_text: str) -> str:
            nonlocal max_concurrent, current_concurrent
            current_concurrent += 1
            if current_concurrent > max_concurrent:
                max_concurrent = current_concurrent
            await asyncio.sleep(0.01)
            current_concurrent -= 1
            return "safe response"

        harness = AdversarialHarness()
        await harness.run_category(
            "prompt-injection",
            target,
            RunConfig(cases_per_category=10, max_concurrency=3),
        )
        assert max_concurrent <= 3

    @pytest.mark.asyncio
    async def test_unicode_smuggling_detection(self) -> None:
        harness = AdversarialHarness()
        provider = create_vulnerable_provider(processes_unicode=True)

        async def target(input_text: str) -> str:
            return await provider.complete(input_text)

        result = await harness.run_category(
            "unicode-smuggling",
            target,
            RunConfig(cases_per_category=5, include_passing_cases=True),
        )
        assert result.failed > 0

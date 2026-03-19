"""Tests for Online Eval Monitoring — Python implementation.

Covers unit, failure mode, and integration categories matching the TypeScript suite.
Uses pytest-asyncio with asyncio_mode="auto" (configured in pyproject.toml).
"""

from __future__ import annotations

import asyncio
import time

import pytest

from .. import OnlineEvalMonitor
from ..mock_provider import MockLLMProvider, MockScorer
from ..types import AlertEvent, EvalContext, OnlineEvalConfig, ScoreResult, TimeWindow


# Helper: wait for async queue to drain
async def drain(ms: float = 200.0) -> None:
    await asyncio.sleep(ms / 1000.0)


# ── Unit Tests ──────────────────────────────────────────────────────────────


class TestOnlineEvalMonitorUnit:
    async def test_returns_handler_result_immediately(self) -> None:
        monitor = OnlineEvalMonitor()

        async def _handler() -> str:
            return "hello"

        result = await monitor.wrap(_handler, EvalContext(input="test", output=""))
        assert result == "hello"

    async def test_does_not_block_on_eval(self) -> None:
        monitor = OnlineEvalMonitor()
        slow_scorer = MockScorer(name="slow", sampling_rate=1.0, latency_ms=500)
        monitor.add_scorer(slow_scorer)

        start = time.time()

        async def _handler() -> str:
            return "fast"

        await monitor.wrap(_handler, EvalContext(input="x", output=""))
        elapsed_ms = (time.time() - start) * 1000
        # Should return well before the 500ms scorer runs
        assert elapsed_ms < 200

    async def test_scores_recorded_after_eval_completes(self) -> None:
        monitor = OnlineEvalMonitor()
        scorer = MockScorer(name="quality", sampling_rate=1.0, fixed_score=0.9, latency_ms=10)
        monitor.add_scorer(scorer)

        async def _handler() -> str:
            return "response"

        await monitor.wrap(_handler, EvalContext(input="prompt", output=""))
        await drain()

        now = time.time()
        scores = monitor.get_scores("quality", TimeWindow(start_s=0, end_s=now))
        assert len(scores) == 1
        assert abs(scores[0].score - 0.9) < 0.01

    async def test_on_score_callback_fires(self) -> None:
        monitor = OnlineEvalMonitor()
        scorer = MockScorer(name="q", sampling_rate=1.0, fixed_score=0.8, latency_ms=10)
        monitor.add_scorer(scorer)

        received: list[ScoreResult] = []
        monitor.on_score(received.append)

        async def _handler() -> str:
            return "out"

        await monitor.wrap(_handler, EvalContext(input="in", output=""))
        await drain()

        assert len(received) == 1
        assert received[0].scorer_name == "q"

    async def test_rolling_mean_computed_correctly(self) -> None:
        monitor = OnlineEvalMonitor(OnlineEvalConfig(window_size=10))
        scorer = MockScorer(name="q", sampling_rate=1.0, fixed_score=0.6, latency_ms=5)
        monitor.add_scorer(scorer)

        async def _handler() -> str:
            return "r"

        for _ in range(5):
            await monitor.wrap(_handler, EvalContext(input="i", output=""))
        await drain()

        mean = monitor.get_rolling_mean("q")
        assert mean is not None
        assert abs(mean - 0.6) < 0.05

    async def test_zero_sampling_rate_means_no_scores(self) -> None:
        monitor = OnlineEvalMonitor()
        scorer = MockScorer(name="q", sampling_rate=0.0, fixed_score=0.9, latency_ms=5)
        monitor.add_scorer(scorer)

        async def _handler() -> str:
            return "r"

        for _ in range(10):
            await monitor.wrap(_handler, EvalContext(input="i", output=""))
        await drain()

        assert scorer.call_count == 0

    async def test_rolling_mean_returns_none_with_no_scores(self) -> None:
        monitor = OnlineEvalMonitor()
        monitor.add_scorer(MockScorer(name="q", sampling_rate=0.0))
        assert monitor.get_rolling_mean("q") is None


# ── Failure Mode Tests ───────────────────────────────────────────────────────


class TestFailureModes:
    async def test_scorer_errors_absorbed_silently(self) -> None:
        """FM: Scorer flakiness — errors must not propagate to the caller."""
        monitor = OnlineEvalMonitor()
        monitor.add_scorer(MockScorer(name="flaky", sampling_rate=1.0, error_rate=1.0, latency_ms=5))

        async def _handler() -> str:
            return "result"

        await monitor.wrap(_handler, EvalContext(input="test", output=""))
        await drain()

        metrics = monitor.get_metrics()
        assert metrics["total_errors"] == 1
        assert metrics["total_scored"] == 0

    async def test_queue_drops_oldest_when_full(self) -> None:
        """FM: Eval queue backlog — oldest jobs dropped when queue capacity exceeded."""
        monitor = OnlineEvalMonitor(OnlineEvalConfig(queue_size=3))
        monitor.add_scorer(MockScorer(name="slow", sampling_rate=1.0, latency_ms=100))

        async def _handler() -> str:
            return "r"

        for _ in range(10):
            await monitor.wrap(_handler, EvalContext(input="req", output=""))

        assert monitor.get_metrics()["dropped_jobs"] > 0

    async def test_scorer_timeout_enforced(self) -> None:
        """FM: Scorer timeout — job dropped after async_timeout_s."""
        monitor = OnlineEvalMonitor(OnlineEvalConfig(async_timeout_s=0.05))
        monitor.add_scorer(MockScorer(name="hanging", sampling_rate=1.0, latency_ms=500))

        async def _handler() -> str:
            return "r"

        await monitor.wrap(_handler, EvalContext(input="i", output=""))
        # Wait past timeout but not full scorer latency
        await asyncio.sleep(0.3)

        metrics = monitor.get_metrics()
        assert metrics["total_errors"] == 1
        assert metrics["total_scored"] == 0

    async def test_warning_alert_fires_at_threshold(self) -> None:
        """FM: Warning alert when rolling mean crosses alert_threshold."""
        config = OnlineEvalConfig(window_size=5, alert_threshold=0.7, critical_threshold=0.4)
        monitor = OnlineEvalMonitor(config)
        monitor.add_scorer(MockScorer(name="q", sampling_rate=1.0, fixed_score=0.6, latency_ms=5))

        alerts: list[AlertEvent] = []
        monitor.on_alert(alerts.append)

        async def _handler() -> str:
            return "r"

        for _ in range(6):
            await monitor.wrap(_handler, EvalContext(input="i", output=""))
        await drain()

        assert any(a.level == "warning" for a in alerts)
        assert all(a.level != "critical" for a in alerts)

    async def test_critical_alert_fires_at_threshold(self) -> None:
        """FM: Critical alert when rolling mean crosses critical_threshold."""
        config = OnlineEvalConfig(window_size=5, alert_threshold=0.7, critical_threshold=0.4)
        monitor = OnlineEvalMonitor(config)
        monitor.add_scorer(MockScorer(name="q", sampling_rate=1.0, fixed_score=0.3, latency_ms=5))

        alerts: list[AlertEvent] = []
        monitor.on_alert(alerts.append)

        async def _handler() -> str:
            return "r"

        for _ in range(6):
            await monitor.wrap(_handler, EvalContext(input="i", output=""))
        await drain()

        assert any(a.level == "critical" for a in alerts)

    async def test_silent_degradation_detectable_via_rolling_mean(self) -> None:
        """FM: Silent baseline drift — gradual score decay is detectable via rolling mean slope."""
        monitor = OnlineEvalMonitor(OnlineEvalConfig(window_size=20))
        # Score starts at 0.9, drifts down 0.01 per call
        drifting = MockScorer(name="quality", sampling_rate=1.0, fixed_score=0.9, drift_per_call=0.01, latency_ms=5)
        monitor.add_scorer(drifting)

        async def _handler() -> str:
            return "r"

        # Early samples
        for _ in range(5):
            await monitor.wrap(_handler, EvalContext(input="i", output=""))
        await drain()
        early_mean = monitor.get_rolling_mean("quality")

        # Later samples
        for _ in range(15):
            await monitor.wrap(_handler, EvalContext(input="i", output=""))
        await drain()
        late_mean = monitor.get_rolling_mean("quality")

        assert early_mean is not None
        assert late_mean is not None
        # Drift should be detectable: late mean meaningfully lower
        assert late_mean < early_mean - 0.05


# ── Integration Tests ────────────────────────────────────────────────────────


class TestIntegration:
    async def test_end_to_end_wrap_llm_provider(self) -> None:
        """End-to-end: wrap LLM handler, eval runs, score stored and accessible."""
        provider = MockLLMProvider(response="Paris", latency_ms=10)
        monitor = OnlineEvalMonitor(OnlineEvalConfig(window_size=20))
        monitor.add_scorer(MockScorer(name="non-empty", sampling_rate=1.0, fixed_score=1.0, latency_ms=5))

        scored: list[ScoreResult] = []
        monitor.on_score(scored.append)

        response = await monitor.wrap(
            lambda: provider.complete("What is the capital of France?"),
            EvalContext(input="What is the capital of France?", output=""),
        )

        await drain()

        assert "Paris" in response
        assert len(scored) == 1
        assert scored[0].score == 1.0
        assert abs(monitor.get_rolling_mean("non-empty") - 1.0) < 0.01

    async def test_multiple_scorers_run_independently(self) -> None:
        monitor = OnlineEvalMonitor()
        s1 = MockScorer(name="format", sampling_rate=1.0, fixed_score=0.9, latency_ms=5)
        s2 = MockScorer(name="faithfulness", sampling_rate=1.0, fixed_score=0.7, latency_ms=10)
        monitor.add_scorer(s1)
        monitor.add_scorer(s2)

        async def _handler() -> str:
            return "result"

        await monitor.wrap(_handler, EvalContext(input="input", output=""))
        await drain()

        now = time.time()
        window = TimeWindow(start_s=0, end_s=now)
        assert len(monitor.get_scores("format", window)) == 1
        assert len(monitor.get_scores("faithfulness", window)) == 1

    async def test_concurrent_requests_all_handled(self) -> None:
        monitor = OnlineEvalMonitor(OnlineEvalConfig(window_size=50))
        monitor.add_scorer(MockScorer(name="q", sampling_rate=1.0, fixed_score=0.8, latency_ms=5))

        async def _handler(i: int) -> str:
            return f"response_{i}"

        results = await asyncio.gather(*[
            monitor.wrap(lambda i=i: _handler(i), EvalContext(input=f"input_{i}", output=""))
            for i in range(20)
        ])

        assert len(results) == 20

        await drain(400)

        now = time.time()
        scores = monitor.get_scores("q", TimeWindow(start_s=0, end_s=now))
        assert len(scores) == 20

"""Latency Budget Pattern — Tests (unit, failure mode, integration)."""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

import pytest

# Add src/py to sys.path for direct imports (avoids 'py' package name conflict)
_py_dir = Path(__file__).resolve().parent.parent
if str(_py_dir) not in sys.path:
    sys.path.insert(0, str(_py_dir))

# Import via __init__ directly to avoid the 'py' namespace conflict
from types import ModuleType as _ModuleType  # noqa: E402  # stdlib types, not our types.py

import importlib  # noqa: E402

# Load our modules explicitly to sidestep the py/ naming issue
_spec = importlib.util.spec_from_file_location(
    "latency_budget", str(_py_dir / "__init__.py"),
    submodule_search_locations=[str(_py_dir)],
)
_lb_mod = importlib.util.module_from_spec(_spec)
sys.modules["latency_budget"] = _lb_mod

# Pre-load submodules so relative imports work
_types_spec = importlib.util.spec_from_file_location(
    "latency_budget.types", str(_py_dir / "types.py")
)
_types_mod = importlib.util.module_from_spec(_types_spec)
sys.modules["latency_budget.types"] = _types_mod
_types_spec.loader.exec_module(_types_mod)

_mock_spec = importlib.util.spec_from_file_location(
    "latency_budget.mock_provider", str(_py_dir / "mock_provider.py")
)
_mock_mod = importlib.util.module_from_spec(_mock_spec)
sys.modules["latency_budget.mock_provider"] = _mock_mod
_mock_spec.loader.exec_module(_mock_mod)

# Now exec the main module
_spec.loader.exec_module(_lb_mod)

from latency_budget import (  # noqa: E402
    LatencyBudget,
    LatencyBudgetPipeline,
    PipelineStep,
    create_step,
)
from latency_budget.mock_provider import MockProvider  # noqa: E402
from latency_budget.types import (  # noqa: E402
    BudgetExhaustedStrategy,
    LatencyBudgetConfig,
    PipelineMetrics,
    StepConfig,
)


# ── Helpers ──────────────────────────────────────────────────────────


async def _sleep_ms(ms: float) -> None:
    await asyncio.sleep(ms / 1000)


# ── Unit Tests ───────────────────────────────────────────────────────


class TestLatencyBudget:
    def test_remaining_time_accurate(self) -> None:
        budget = LatencyBudget(1000)
        remaining = budget.remaining()
        assert remaining > 990
        assert remaining <= 1000

    @pytest.mark.asyncio
    async def test_elapsed_time(self) -> None:
        budget = LatencyBudget(5000)
        await _sleep_ms(50)
        assert budget.elapsed() >= 40

    @pytest.mark.asyncio
    async def test_detects_expiration(self) -> None:
        budget = LatencyBudget(30)
        assert budget.is_expired() is False
        await _sleep_ms(50)
        assert budget.is_expired() is True

    @pytest.mark.asyncio
    async def test_utilization_fraction(self) -> None:
        budget = LatencyBudget(100)
        await _sleep_ms(50)
        util = budget.utilization()
        assert 0.3 < util < 1.5

    def test_child_capped_at_parent_remaining(self) -> None:
        parent = LatencyBudget(500)
        child = parent.child(2000)
        assert child.remaining() <= 500

    def test_child_at_requested_amount_when_surplus(self) -> None:
        parent = LatencyBudget(5000)
        child = parent.child(200)
        assert 190 < child.remaining() <= 200

    def test_zero_budget(self) -> None:
        budget = LatencyBudget(0)
        assert budget.remaining() == 0
        assert budget.is_expired() is True


class TestPipelineStep:
    @pytest.mark.asyncio
    async def test_executes_and_reports_timing(self) -> None:
        async def step_fn(input_val: str, budget: LatencyBudget) -> str:
            await _sleep_ms(20)
            return f"processed: {input_val}"

        step = create_step("test-step", step_fn, min_budget_ms=10)
        budget = LatencyBudget(5000)
        result = await step.execute("hello", budget)

        assert result.skipped is False
        assert result.output == "processed: hello"
        assert result.elapsed_ms >= 15

    @pytest.mark.asyncio
    async def test_skips_below_min_budget(self) -> None:
        async def step_fn(input_val: str, budget: LatencyBudget) -> str:
            await _sleep_ms(100)
            return "done"

        step = create_step("expensive-step", step_fn, min_budget_ms=500)
        budget = LatencyBudget(50)
        result = await step.execute("input", budget)

        assert result.skipped is True
        assert result.output is None

    @pytest.mark.asyncio
    async def test_uses_child_budget_with_timeout(self) -> None:
        async def step_fn(input_val: str, budget: LatencyBudget) -> str:
            assert budget.remaining() <= 200
            return "done"

        step = create_step("timed-step", step_fn, min_budget_ms=10, timeout_ms=200)
        budget = LatencyBudget(5000)
        await step.execute("input", budget)

    @pytest.mark.asyncio
    async def test_catches_errors_on_optional_steps(self) -> None:
        async def step_fn(input_val: str, budget: LatencyBudget) -> str:
            raise RuntimeError("step failed")

        step = create_step("failing-optional", step_fn, min_budget_ms=10, optional=True)
        budget = LatencyBudget(5000)
        result = await step.execute("input", budget)

        assert result.skipped is True
        assert result.output is None

    @pytest.mark.asyncio
    async def test_propagates_errors_on_required_steps(self) -> None:
        async def step_fn(input_val: str, budget: LatencyBudget) -> str:
            raise RuntimeError("critical failure")

        step = create_step("failing-required", step_fn, min_budget_ms=10, optional=False)
        budget = LatencyBudget(5000)

        with pytest.raises(RuntimeError, match="critical failure"):
            await step.execute("input", budget)


class TestPipeline:
    @pytest.mark.asyncio
    async def test_default_config(self) -> None:
        async def step_fn(input_val: str, budget: LatencyBudget) -> str:
            return input_val

        step = create_step("simple", step_fn)
        pipeline = LatencyBudgetPipeline([step])
        _, metrics = await pipeline.execute("test")
        assert metrics.deadline_exceeded is False

    @pytest.mark.asyncio
    async def test_output_chains_between_steps(self) -> None:
        async def step1_fn(input_val: str, budget: LatencyBudget) -> str:
            return f"{input_val}+step1"

        async def step2_fn(input_val: str, budget: LatencyBudget) -> str:
            return f"{input_val}+step2"

        step1 = create_step("step1", step1_fn)
        step2 = create_step("step2", step2_fn)
        pipeline = LatencyBudgetPipeline(
            [step1, step2],
            LatencyBudgetConfig(total_budget_ms=5000),
        )
        results, _ = await pipeline.execute("start")
        assert results[1].output == "start+step1+step2"

    @pytest.mark.asyncio
    async def test_emits_metrics_via_callback(self) -> None:
        captured: list[PipelineMetrics] = []

        async def step_fn(input_val: str, budget: LatencyBudget) -> str:
            return input_val

        step = create_step("simple", step_fn)
        pipeline = LatencyBudgetPipeline([step])
        pipeline.on_metrics(lambda m: captured.append(m))

        await pipeline.execute("test")
        assert len(captured) == 1
        assert len(captured[0].step_timings) == 1


# ── Failure Mode Tests ───────────────────────────────────────────────


class TestFailureModeBudgetTooTight:
    @pytest.mark.asyncio
    async def test_skips_optional_when_budget_insufficient(self) -> None:
        provider = MockProvider(latency_ms=100, variance_ms=0)

        async def retrieval(input_val: str, budget: LatencyBudget) -> str:
            await provider.generate(input_val)
            return input_val

        async def reranking(input_val: str, budget: LatencyBudget) -> str:
            await _sleep_ms(50)
            return input_val

        async def generation(input_val: str, budget: LatencyBudget) -> str:
            await provider.generate(input_val)
            return "generated"

        step1 = create_step("retrieval", retrieval, min_budget_ms=50)
        step2 = create_step("reranking", reranking, min_budget_ms=100, optional=True)
        step3 = create_step("generation", generation, min_budget_ms=50)

        pipeline = LatencyBudgetPipeline(
            [step1, step2, step3],
            LatencyBudgetConfig(total_budget_ms=250, reserve_ms=50),
        )
        _, metrics = await pipeline.execute("query")
        assert metrics.skipped_steps >= 1


class TestFailureModeBudgetTooLoose:
    @pytest.mark.asyncio
    async def test_never_skips_with_generous_budget(self) -> None:
        async def fast(input_val: str, budget: LatencyBudget) -> str:
            return input_val

        steps = [
            create_step(f"fast{i}", fast, min_budget_ms=10, optional=True)
            for i in range(3)
        ]
        pipeline = LatencyBudgetPipeline(
            steps,
            LatencyBudgetConfig(total_budget_ms=60_000),
        )
        _, metrics = await pipeline.execute("test")
        assert metrics.skipped_steps == 0
        assert metrics.budget_utilization < 0.01


class TestFailureModeCascadingSkips:
    @pytest.mark.asyncio
    async def test_slow_step_causes_downstream_skips(self) -> None:
        async def slow_retrieval(input_val: str, budget: LatencyBudget) -> str:
            await _sleep_ms(150)
            return input_val

        async def reranking(input_val: str, budget: LatencyBudget) -> str:
            return f"reranked: {input_val}"

        async def validation(input_val: str, budget: LatencyBudget) -> str:
            return f"validated: {input_val}"

        step1 = create_step("slow-retrieval", slow_retrieval, min_budget_ms=50)
        step2 = create_step("reranking", reranking, min_budget_ms=80, optional=True)
        step3 = create_step("validation", validation, min_budget_ms=80, optional=True)

        pipeline = LatencyBudgetPipeline(
            [step1, step2, step3],
            LatencyBudgetConfig(total_budget_ms=250, reserve_ms=50),
        )
        _, metrics = await pipeline.execute("query")
        assert metrics.skipped_steps == 2


class TestFailureModeBudgetCheckOverhead:
    def test_budget_operations_sub_millisecond(self) -> None:
        budget = LatencyBudget(5000)
        iterations = 10_000
        start = time.perf_counter()

        for _ in range(iterations):
            budget.remaining()
            budget.elapsed()
            budget.is_expired()
            budget.utilization()

        total_ms = (time.perf_counter() - start) * 1000
        per_op_ms = total_ms / (iterations * 4)
        assert per_op_ms < 0.01


class TestFailureModeSilentQualityDegradation:
    @pytest.mark.asyncio
    async def test_skip_rate_increases_with_slower_provider(self) -> None:
        provider = MockProvider(latency_ms=50, variance_ms=0)

        async def retrieval(input_val: str, budget: LatencyBudget) -> str:
            await provider.generate(input_val)
            return input_val

        async def reranking(input_val: str, budget: LatencyBudget) -> str:
            await _sleep_ms(30)
            return input_val

        async def generation(input_val: str, budget: LatencyBudget) -> str:
            await provider.generate(input_val)
            return "result"

        steps = [
            create_step("retrieval", retrieval, min_budget_ms=30),
            create_step("reranking", reranking, min_budget_ms=50, optional=True),
            create_step("generation", generation, min_budget_ms=30),
        ]
        pipeline = LatencyBudgetPipeline(
            steps,
            LatencyBudgetConfig(total_budget_ms=200, reserve_ms=20),
        )

        # Phase 1: fast provider
        _, m1 = await pipeline.execute("query")

        # Phase 2: provider gets slower
        provider.update_config(latency_ms=100)
        _, m2 = await pipeline.execute("query")

        assert m2.skipped_steps >= m1.skipped_steps


class TestFailureModeStaleBudgetAfterRetry:
    @pytest.mark.asyncio
    async def test_remaining_decreases_after_failed_attempt(self) -> None:
        budget = LatencyBudget(500)
        await _sleep_ms(200)

        remaining_after_failure = budget.remaining()
        assert remaining_after_failure < 350

        retry_budget = budget.child(budget.remaining())
        assert retry_budget.remaining() < 350


# ── Integration Tests ────────────────────────────────────────────────


class TestIntegrationFullRAGPipeline:
    @pytest.mark.asyncio
    async def test_4_step_rag_pipeline(self) -> None:
        provider = MockProvider(latency_ms=100, variance_ms=10, output_tokens=200)

        async def retrieval(query: str, budget: LatencyBudget) -> dict:
            await _sleep_ms(30)
            return {"query": query, "chunks": ["chunk1", "chunk2"]}

        async def reranking(ctx: dict, budget: LatencyBudget) -> dict:
            await _sleep_ms(20)
            return {**ctx, "chunks": list(reversed(ctx["chunks"]))}

        async def generation(ctx: dict, budget: LatencyBudget) -> dict:
            prompt = f'Answer "{ctx["query"]}" using: {", ".join(ctx["chunks"])}'
            resp = await provider.generate(prompt)
            return {"text": resp.text, "tokens": resp.output_tokens}

        async def validation(ctx: dict, budget: LatencyBudget) -> dict:
            await _sleep_ms(10)
            return {**ctx, "validated": True}

        pipeline = LatencyBudgetPipeline(
            [
                create_step("retrieval", retrieval, min_budget_ms=50),
                create_step("reranking", reranking, min_budget_ms=50, optional=True),
                create_step("generation", generation, min_budget_ms=100),
                create_step("validation", validation, min_budget_ms=20, optional=True),
            ],
            LatencyBudgetConfig(total_budget_ms=3000, reserve_ms=100),
        )

        captured: list[PipelineMetrics] = []
        pipeline.on_metrics(lambda m: captured.append(m))

        results, metrics = await pipeline.execute("What is latency budgeting?")

        assert len(results) == 4
        assert metrics.deadline_exceeded is False
        assert len(metrics.step_timings) == 4
        assert metrics.budget_utilization < 1
        assert len(captured) == 1
        assert captured[0].step_timings[0].name == "retrieval"

    @pytest.mark.asyncio
    async def test_abort_strategy(self) -> None:
        async def slow(input_val: str, budget: LatencyBudget) -> str:
            await _sleep_ms(200)
            return input_val

        async def after_slow(input_val: str, budget: LatencyBudget) -> str:
            return f"processed: {input_val}"

        pipeline = LatencyBudgetPipeline(
            [
                create_step("slow", slow, min_budget_ms=50),
                create_step("after-slow", after_slow, min_budget_ms=100),
            ],
            LatencyBudgetConfig(
                total_budget_ms=250,
                reserve_ms=50,
                on_budget_exhausted=BudgetExhaustedStrategy.ABORT,
            ),
        )
        results, _ = await pipeline.execute("test")
        assert len(results) == 2


class TestIntegrationConcurrentPipelines:
    @pytest.mark.asyncio
    async def test_each_execution_gets_own_budget(self) -> None:
        async def step_fn(input_val: str, budget: LatencyBudget) -> str:
            await _sleep_ms(20)
            return input_val

        step = create_step("step", step_fn, min_budget_ms=10)
        pipeline = LatencyBudgetPipeline(
            [step],
            LatencyBudgetConfig(total_budget_ms=1000),
        )

        all_results = await asyncio.gather(
            *[pipeline.execute(f"query-{i}") for i in range(5)]
        )

        for results, metrics in all_results:
            assert metrics.deadline_exceeded is False
            assert metrics.skipped_steps == 0

"""
Latency Budget Pattern — Core Implementation

Propagates a deadline through a multi-step LLM pipeline, enabling each
step to query remaining budget and make adaptive decisions (skip optional
steps, switch models, abort early).

Uses time.perf_counter() for monotonic timing to avoid system clock issues.
"""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from typing import Any

from .types import (
    BudgetExhaustedStrategy,
    LatencyBudgetConfig,
    PipelineMetrics,
    StepConfig,
    StepResult,
    StepTiming,
)


class LatencyBudget:
    """Propagated deadline context — tracks remaining time for a request."""

    __slots__ = ("_deadline_s", "_start_s")

    def __init__(self, total_budget_ms: float, *, _start_s: float | None = None) -> None:
        self._start_s = _start_s if _start_s is not None else time.perf_counter()
        self._deadline_s = self._start_s + total_budget_ms / 1000

    def remaining(self) -> float:
        """Milliseconds remaining until deadline."""
        return max(0.0, (self._deadline_s - time.perf_counter()) * 1000)

    def elapsed(self) -> float:
        """Milliseconds elapsed since budget creation."""
        return (time.perf_counter() - self._start_s) * 1000

    def is_expired(self) -> bool:
        """Whether the deadline has passed."""
        return time.perf_counter() >= self._deadline_s

    def utilization(self) -> float:
        """Fraction of total budget consumed (>1 means overrun)."""
        total_s = self._deadline_s - self._start_s
        if total_s <= 0:
            return 1.0
        return self.elapsed() / (total_s * 1000)

    def child(self, max_ms: float) -> LatencyBudget:
        """Create a child budget capped at the parent's remaining time."""
        now = time.perf_counter()
        parent_remaining_ms = max(0.0, (self._deadline_s - now) * 1000)
        child_budget_ms = min(max_ms, parent_remaining_ms)
        return LatencyBudget(child_budget_ms, _start_s=now)

    @property
    def deadline(self) -> float:
        """Absolute deadline in perf_counter units."""
        return self._deadline_s


# Type alias for step functions — accepts input + budget, returns awaitable output
StepFn = Callable[[Any, LatencyBudget], Awaitable[Any]]


class PipelineStep:
    """Wraps an async step function with budget-awareness."""

    def __init__(self, config: StepConfig, fn: StepFn) -> None:
        self.config = config
        self._fn = fn

    async def execute(self, input_val: Any, budget: LatencyBudget) -> StepResult:
        step_start = time.perf_counter()

        # Check if we have enough budget to run this step
        remaining = budget.remaining()
        if remaining < self.config.min_budget_ms:
            return StepResult(
                output=None,
                skipped=True,
                elapsed_ms=(time.perf_counter() - step_start) * 1000,
                remaining_ms=budget.remaining(),
            )

        # Create a child budget if step-level timeout is configured
        step_budget = (
            budget.child(self.config.timeout_ms) if self.config.timeout_ms else budget
        )

        try:
            output = await self._fn(input_val, step_budget)
            return StepResult(
                output=output,
                skipped=False,
                elapsed_ms=(time.perf_counter() - step_start) * 1000,
                remaining_ms=budget.remaining(),
            )
        except Exception:
            # Optional steps treat errors as skips
            if self.config.optional:
                return StepResult(
                    output=None,
                    skipped=True,
                    elapsed_ms=(time.perf_counter() - step_start) * 1000,
                    remaining_ms=budget.remaining(),
                )
            raise


class LatencyBudgetPipeline:
    """Orchestrates pipeline steps with deadline propagation."""

    def __init__(
        self,
        steps: list[PipelineStep],
        config: LatencyBudgetConfig | None = None,
    ) -> None:
        self._config = config or LatencyBudgetConfig()
        self._steps = steps
        self._metrics_callback: Callable[[PipelineMetrics], None] | None = None

    def on_metrics(self, callback: Callable[[PipelineMetrics], None]) -> None:
        """Register a callback to receive metrics after each pipeline execution."""
        self._metrics_callback = callback

    async def execute(self, input_val: Any) -> tuple[list[StepResult], PipelineMetrics]:
        """Execute the pipeline with budget propagation.

        Returns a tuple of (results, metrics) — Pythonic alternative to
        the TS version's object return.
        """
        effective_budget_ms = self._config.total_budget_ms - self._config.reserve_ms
        budget = LatencyBudget(effective_budget_ms)
        results: list[StepResult] = []
        step_timings: list[StepTiming] = []

        current_input: Any = input_val

        for step in self._steps:
            remaining = budget.remaining()

            if remaining < step.config.min_budget_ms:
                if (
                    step.config.optional
                    and self._config.on_budget_exhausted
                    == BudgetExhaustedStrategy.SKIP_OPTIONAL
                ):
                    skipped = StepResult(
                        output=None, skipped=True, elapsed_ms=0, remaining_ms=remaining
                    )
                    results.append(skipped)
                    step_timings.append(
                        StepTiming(
                            name=step.config.name,
                            elapsed_ms=0,
                            skipped=True,
                            remaining_budget_ms=remaining,
                        )
                    )
                    continue

                if self._config.on_budget_exhausted == BudgetExhaustedStrategy.ABORT:
                    results.append(
                        StepResult(
                            output=None,
                            skipped=True,
                            elapsed_ms=0,
                            remaining_ms=remaining,
                        )
                    )
                    step_timings.append(
                        StepTiming(
                            name=step.config.name,
                            elapsed_ms=0,
                            skipped=True,
                            remaining_budget_ms=remaining,
                        )
                    )
                    break

                # BEST_EFFORT: try to run even with low budget

            result = await step.execute(current_input, budget)
            results.append(result)
            step_timings.append(
                StepTiming(
                    name=step.config.name,
                    elapsed_ms=result.elapsed_ms,
                    skipped=result.skipped,
                    remaining_budget_ms=result.remaining_ms,
                )
            )

            if not result.skipped and result.output is not None:
                current_input = result.output

        total_elapsed = budget.elapsed()
        metrics = PipelineMetrics(
            total_elapsed_ms=total_elapsed,
            budget_utilization=(
                total_elapsed / effective_budget_ms if effective_budget_ms > 0 else 1.0
            ),
            skipped_steps=sum(1 for r in results if r.skipped),
            step_timings=step_timings,
            deadline_exceeded=budget.is_expired(),
        )

        if self._metrics_callback:
            self._metrics_callback(metrics)

        return results, metrics


def create_step(
    name: str,
    fn: StepFn,
    *,
    min_budget_ms: float = 100.0,
    optional: bool = False,
    timeout_ms: float | None = None,
) -> PipelineStep:
    """Convenience factory for creating pipeline steps with less boilerplate."""
    return PipelineStep(
        StepConfig(
            name=name,
            min_budget_ms=min_budget_ms,
            optional=optional,
            timeout_ms=timeout_ms,
        ),
        fn,
    )

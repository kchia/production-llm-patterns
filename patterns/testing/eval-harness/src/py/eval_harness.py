"""Eval Harness — Main Implementation

Orchestrates evaluation runs: processes eval cases through a provider,
scores outputs, computes aggregates, and compares against baselines.

Uses asyncio.Semaphore for concurrency control (idiomatic Python)
rather than the batch-based chunking approach used in TypeScript.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from statistics import mean
from typing import Optional, Sequence

from eval_types import (
    AggregateScores,
    ComparisonResult,
    DEFAULT_CONCURRENCY,
    DEFAULT_REGRESSION_TOLERANCE,
    DEFAULT_THRESHOLD,
    DEFAULT_TIMEOUT_MS,
    EvalCase,
    EvalCaseResult,
    EvalRunResult,
    Provider,
    ScoreDelta,
    ScorerResult,
    TokenUsage,
)


class EvalHarness:
    """Runs evaluation suites and compares results against baselines."""

    def __init__(
        self,
        dataset: Sequence[EvalCase],
        scorers: Sequence[object],  # Scorer protocol objects
        provider: Provider,
        *,
        concurrency: int = DEFAULT_CONCURRENCY,
        threshold: float = DEFAULT_THRESHOLD,
        regression_tolerance: float = DEFAULT_REGRESSION_TOLERANCE,
        timeout_ms: float = DEFAULT_TIMEOUT_MS,
        tags: Optional[Sequence[str]] = None,
    ) -> None:
        self._dataset = list(dataset)
        self._scorers = list(scorers)
        self._provider = provider
        self._concurrency = concurrency
        self._threshold = threshold
        self._regression_tolerance = regression_tolerance
        self._timeout_ms = timeout_ms
        self._tags = set(tags) if tags else None

    async def run(self) -> EvalRunResult:
        """Run evaluation across all cases (or filtered by tags)."""
        start = time.monotonic()
        run_id = _generate_run_id()

        cases = self._filter_cases()
        if not cases:
            raise ValueError("No eval cases to run. Check dataset and tag filters.")

        results = await self._process_concurrent(cases)
        aggregate = _compute_aggregates(results, self._scorers)

        return EvalRunResult(
            run_id=run_id,
            timestamp=datetime.now(timezone.utc).isoformat(),
            results=results,
            aggregate=aggregate,
            duration_ms=(time.monotonic() - start) * 1000,
        )

    def compare(
        self, baseline: EvalRunResult, current: EvalRunResult
    ) -> ComparisonResult:
        """Compare two eval runs and flag regressions/improvements."""
        tolerance = self._regression_tolerance
        regressions: list[ScoreDelta] = []
        improvements: list[ScoreDelta] = []
        overall_delta: dict[str, float] = {}
        by_tag_delta: dict[str, dict[str, float]] = {}

        # Overall comparison per scorer
        for scorer_name in current.aggregate.overall:
            base_score = baseline.aggregate.overall.get(scorer_name, 0.0)
            curr_score = current.aggregate.overall.get(scorer_name, 0.0)
            delta = curr_score - base_score
            overall_delta[scorer_name] = delta

            if delta < -tolerance:
                regressions.append(
                    ScoreDelta(
                        scorer=scorer_name,
                        tag=None,
                        baseline_score=base_score,
                        current_score=curr_score,
                        delta=delta,
                    )
                )
            elif delta > tolerance:
                improvements.append(
                    ScoreDelta(
                        scorer=scorer_name,
                        tag=None,
                        baseline_score=base_score,
                        current_score=curr_score,
                        delta=delta,
                    )
                )

        # Per-tag comparison
        all_tags = set(baseline.aggregate.by_tag) | set(current.aggregate.by_tag)
        for tag in all_tags:
            by_tag_delta[tag] = {}
            base_tag = baseline.aggregate.by_tag.get(tag, {})
            curr_tag = current.aggregate.by_tag.get(tag, {})

            for scorer_name in curr_tag:
                base_score = base_tag.get(scorer_name, 0.0)
                curr_score = curr_tag.get(scorer_name, 0.0)
                delta = curr_score - base_score
                by_tag_delta[tag][scorer_name] = delta

                if delta < -tolerance:
                    regressions.append(
                        ScoreDelta(
                            scorer=scorer_name,
                            tag=tag,
                            baseline_score=base_score,
                            current_score=curr_score,
                            delta=delta,
                        )
                    )
                elif delta > tolerance:
                    improvements.append(
                        ScoreDelta(
                            scorer=scorer_name,
                            tag=tag,
                            baseline_score=base_score,
                            current_score=curr_score,
                            delta=delta,
                        )
                    )

        return ComparisonResult(
            baseline_run_id=baseline.run_id,
            current_run_id=current.run_id,
            regressions=regressions,
            improvements=improvements,
            overall_delta=overall_delta,
            by_tag_delta=by_tag_delta,
            passed=len(regressions) == 0,
        )

    def passes(self, result: EvalRunResult) -> bool:
        """Check if an eval run passes the configured threshold."""
        scores = list(result.aggregate.overall.values())
        if not scores:
            return False
        return all(s >= self._threshold for s in scores)

    # --- Private ---

    def _filter_cases(self) -> list[EvalCase]:
        if self._tags is None:
            return self._dataset
        return [
            c for c in self._dataset if any(t in self._tags for t in c.tags)
        ]

    async def _process_concurrent(
        self, cases: list[EvalCase]
    ) -> list[EvalCaseResult]:
        # Semaphore-based concurrency (idiomatic asyncio)
        sem = asyncio.Semaphore(self._concurrency)

        async def bounded(case: EvalCase) -> EvalCaseResult:
            async with sem:
                return await self._evaluate_case(case)

        return await asyncio.gather(*[bounded(c) for c in cases])

    async def _evaluate_case(self, case: EvalCase) -> EvalCaseResult:
        # Call provider with timeout
        try:
            response = await asyncio.wait_for(
                self._provider(case.input),
                timeout=self._timeout_ms / 1000.0,
            )
            output = response.output
            latency_ms = response.latency_ms
            token_usage = response.token_usage
        except asyncio.TimeoutError:
            return self._failed_result(
                case, f"Eval case timed out after {self._timeout_ms}ms"
            )
        except Exception as exc:
            return self._failed_result(case, f"Provider error: {exc}")

        # Run all scorers
        scores: dict[str, ScorerResult] = {}
        for scorer in self._scorers:
            try:
                scores[scorer.name] = await scorer.score(
                    case.input, output, case.expected
                )
            except Exception as exc:
                scores[scorer.name] = ScorerResult(
                    score=0.0, passed=False, reason=f"Scorer error: {exc}"
                )

        return EvalCaseResult(
            case_id=case.id,
            input=case.input,
            output=output,
            expected=case.expected,
            tags=case.tags,
            scores=scores,
            latency_ms=latency_ms,
            token_usage=token_usage,
        )

    def _failed_result(self, case: EvalCase, reason: str) -> EvalCaseResult:
        scores = {
            s.name: ScorerResult(score=0.0, passed=False, reason=reason)
            for s in self._scorers
        }
        return EvalCaseResult(
            case_id=case.id,
            input=case.input,
            output="",
            expected=case.expected,
            tags=case.tags,
            scores=scores,
            latency_ms=0.0,
            token_usage=TokenUsage(input=0, output=0),
        )


# ============================================================
# Built-in Scorers
# ============================================================


class ExactMatchScorer:
    """Output must equal expected (case-insensitive by default)."""

    def __init__(self, case_sensitive: bool = False) -> None:
        self.name = "exact_match"
        self._case_sensitive = case_sensitive

    async def score(
        self, input: str, output: str, expected: Optional[str] = None
    ) -> ScorerResult:
        if expected is None:
            return ScorerResult(score=0.0, passed=False, reason="No expected output")
        a = output.strip() if self._case_sensitive else output.strip().lower()
        b = expected.strip() if self._case_sensitive else expected.strip().lower()
        match = a == b
        return ScorerResult(score=1.0 if match else 0.0, passed=match)


class ContainsScorer:
    """Output must contain expected as a substring."""

    def __init__(self) -> None:
        self.name = "contains"

    async def score(
        self, input: str, output: str, expected: Optional[str] = None
    ) -> ScorerResult:
        if expected is None:
            return ScorerResult(score=0.0, passed=False, reason="No expected output")
        found = expected.lower() in output.lower()
        return ScorerResult(score=1.0 if found else 0.0, passed=found)


class LengthScorer:
    """Penalizes outputs that are too short or too long."""

    def __init__(self, min_words: int = 10, max_words: int = 500) -> None:
        self.name = "length"
        self._min = min_words
        self._max = max_words

    async def score(
        self, input: str, output: str, expected: Optional[str] = None
    ) -> ScorerResult:
        word_count = len(output.split())
        if word_count < self._min:
            return ScorerResult(
                score=word_count / self._min,
                passed=False,
                reason=f"Too short: {word_count} words (min: {self._min})",
            )
        if word_count > self._max:
            return ScorerResult(
                score=self._max / word_count,
                passed=False,
                reason=f"Too long: {word_count} words (max: {self._max})",
            )
        return ScorerResult(score=1.0, passed=True)


class CustomScorer:
    """Wraps an arbitrary scoring function.

    The function receives (input, output, expected) and returns a float 0-1.
    Can be sync or async.
    """

    def __init__(
        self,
        name: str,
        fn: object,
        pass_threshold: float = 0.5,
    ) -> None:
        self.name = name
        self._fn = fn
        self._pass_threshold = pass_threshold

    async def score(
        self, input: str, output: str, expected: Optional[str] = None
    ) -> ScorerResult:
        result = self._fn(input, output, expected)
        if asyncio.iscoroutine(result):
            result = await result
        clamped = max(0.0, min(1.0, float(result)))
        return ScorerResult(score=clamped, passed=clamped >= self._pass_threshold)


# ============================================================
# Aggregate Computation
# ============================================================


def _compute_aggregates(
    results: list[EvalCaseResult], scorers: Sequence[object]
) -> AggregateScores:
    scorer_names = [s.name for s in scorers]

    # Overall mean per scorer
    overall: dict[str, float] = {}
    for name in scorer_names:
        values = [
            r.scores[name].score for r in results if name in r.scores
        ]
        overall[name] = mean(values) if values else 0.0

    # Per-tag mean per scorer
    by_tag: dict[str, dict[str, float]] = {}
    all_tags: set[str] = set()
    for r in results:
        all_tags.update(r.tags)

    for tag in all_tags:
        by_tag[tag] = {}
        tag_results = [r for r in results if tag in r.tags]
        for name in scorer_names:
            values = [
                r.scores[name].score for r in tag_results if name in r.scores
            ]
            by_tag[tag][name] = mean(values) if values else 0.0

    # Pass rate: fraction where ALL scorers passed
    pass_count = sum(
        1
        for r in results
        if all(r.scores.get(name, ScorerResult(0, False)).passed for name in scorer_names)
    )
    pass_rate = pass_count / len(results) if results else 0.0

    return AggregateScores(overall=overall, by_tag=by_tag, pass_rate=pass_rate)


# ============================================================
# Utilities
# ============================================================


def _generate_run_id() -> str:
    return f"eval-{uuid.uuid4().hex[:12]}"

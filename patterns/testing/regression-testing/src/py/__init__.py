"""
Regression Testing — Main Implementation

Wraps an eval harness with baseline management, per-tag comparison,
and CI gate logic. Detects quality regressions across prompt versions
by comparing scored results against stored baselines.
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from statistics import mean as _mean
from typing import Optional

from .types import (
    AggregateScores,
    BaselineStore,
    CaseResult,
    RegressionConfig,
    RegressionReport,
    RunResult,
    ScorerResult,
    TagImprovement,
    TagRegression,
    TestCase,
    TestSuite,
    TokenUsage,
)


class RegressionRunner:
    """Runs eval suites, compares against baselines, and produces gate decisions."""

    def __init__(self, config: RegressionConfig) -> None:
        self._config = config

    async def run(self) -> RegressionReport:
        """
        Full regression pipeline:
        1. Execute eval cases through the provider
        2. Load baseline from store
        3. Compare per-tag scores
        4. Produce a gate decision
        """
        cfg = self._config

        # Step 1: Run eval
        run_result = await self._execute_run(cfg.suite)

        # Step 2: Load baseline and genesis
        baseline = await cfg.baseline_store.load(cfg.suite.id)
        genesis = await cfg.baseline_store.load_genesis(cfg.suite.id)

        # Step 3: Compare
        regressions: list[TagRegression] = []
        improvements: list[TagImprovement] = []
        baseline_score: Optional[float] = None

        if baseline is not None:
            baseline_score = _mean_of_scores(baseline.aggregate.overall)
            self._compare_aggregates(
                baseline.aggregate, run_result.aggregate, regressions, improvements
            )

        # Genesis gap check
        genesis_score: Optional[float] = None
        genesis_delta: Optional[float] = None
        if genesis is not None:
            genesis_score = _mean_of_scores(genesis.aggregate.overall)
            current_mean = _mean_of_scores(run_result.aggregate.overall)
            genesis_delta = current_mean - genesis_score

        # Step 4: Gate decision
        overall_score = _mean_of_scores(run_result.aggregate.overall)
        below_min = overall_score < cfg.min_pass_score
        has_regressions = len(regressions) > 0
        genesis_gap_exceeded = (
            genesis_delta is not None
            and genesis_delta < -cfg.genesis_gap_threshold
        )

        passed = (
            not below_min
            and (not has_regressions or not cfg.fail_on_regression)
            and not genesis_gap_exceeded
        )

        # Save as new baseline on pass (only if no regressions)
        if passed and not has_regressions:
            await cfg.baseline_store.save(cfg.suite.id, run_result)
            if genesis is None:
                await cfg.baseline_store.save_genesis(cfg.suite.id, run_result)

        summary = self._build_summary(
            passed, overall_score, baseline_score,
            regressions, improvements, genesis_score, genesis_delta,
        )

        return RegressionReport(
            passed=passed,
            overall_score=overall_score,
            baseline_score=baseline_score,
            genesis_score=genesis_score,
            genesis_delta=genesis_delta,
            regressions=regressions,
            improvements=improvements,
            per_tag_scores=run_result.aggregate.by_tag,
            summary=summary,
            run_result=run_result,
        )

    def _compare_aggregates(
        self,
        baseline: AggregateScores,
        current: AggregateScores,
        regressions: list[TagRegression],
        improvements: list[TagImprovement],
    ) -> None:
        tolerance = self._config.regression_threshold

        # Overall comparison per scorer
        for scorer_name, curr_score in current.overall.items():
            base_score = baseline.overall.get(scorer_name, 0)
            delta = curr_score - base_score

            if delta < -tolerance:
                regressions.append(TagRegression(
                    scorer=scorer_name,
                    baseline_score=base_score,
                    current_score=curr_score,
                    delta=delta,
                ))
            elif delta > tolerance:
                improvements.append(TagImprovement(
                    scorer=scorer_name,
                    baseline_score=base_score,
                    current_score=curr_score,
                    delta=delta,
                ))

        # Per-tag comparison
        all_tags = set(baseline.by_tag) | set(current.by_tag)

        for tag in all_tags:
            base_tag = baseline.by_tag.get(tag, {})
            curr_tag = current.by_tag.get(tag, {})

            for scorer_name, curr_score in curr_tag.items():
                base_score = base_tag.get(scorer_name, 0)
                delta = curr_score - base_score

                if delta < -tolerance:
                    regressions.append(TagRegression(
                        scorer=scorer_name,
                        tag=tag,
                        baseline_score=base_score,
                        current_score=curr_score,
                        delta=delta,
                    ))
                elif delta > tolerance:
                    improvements.append(TagImprovement(
                        scorer=scorer_name,
                        tag=tag,
                        baseline_score=base_score,
                        current_score=curr_score,
                        delta=delta,
                    ))

    async def _execute_run(self, suite: TestSuite) -> RunResult:
        start = time.monotonic()
        run_id = _generate_run_id()
        results = await self._process_in_batches(suite.cases)
        aggregate = _compute_aggregates(results, self._config.scorers)

        return RunResult(
            run_id=run_id,
            suite_id=suite.id,
            suite_version=suite.version,
            timestamp=datetime.now(timezone.utc).isoformat(),
            results=results,
            aggregate=aggregate,
            duration_ms=(time.monotonic() - start) * 1000,
        )

    async def _process_in_batches(self, cases: list[TestCase]) -> list[CaseResult]:
        results: list[CaseResult] = []
        concurrency = self._config.concurrency

        for i in range(0, len(cases), concurrency):
            batch = cases[i : i + concurrency]
            batch_results = await asyncio.gather(
                *(self._evaluate_case(c) for c in batch)
            )
            results.extend(batch_results)

        return results

    async def _evaluate_case(self, test_case: TestCase) -> CaseResult:
        cfg = self._config

        try:
            response = await asyncio.wait_for(
                cfg.provider(test_case.input),
                timeout=cfg.timeout_ms / 1000,
            )
            output = response.output
            latency_ms = response.latency_ms
            token_usage = response.token_usage
        except Exception as exc:
            fail_scores: dict[str, ScorerResult] = {}
            reason = f"Provider error: {exc}"
            if isinstance(exc, asyncio.TimeoutError):
                reason = f"Test case timed out after {cfg.timeout_ms}ms"
            for scorer in cfg.scorers:
                fail_scores[scorer.name] = ScorerResult(
                    score=0, passed=False, reason=reason,
                )
            return CaseResult(
                case_id=test_case.id,
                input=test_case.input,
                output="",
                expected=test_case.expected,
                tags=test_case.tags,
                scores=fail_scores,
                latency_ms=0,
                token_usage=TokenUsage(input=0, output=0),
            )

        scores: dict[str, ScorerResult] = {}
        for scorer in cfg.scorers:
            try:
                scores[scorer.name] = await scorer.score(
                    test_case.input, output, test_case.expected
                )
            except Exception as exc:
                scores[scorer.name] = ScorerResult(
                    score=0, passed=False, reason=f"Scorer error: {exc}",
                )

        return CaseResult(
            case_id=test_case.id,
            input=test_case.input,
            output=output,
            expected=test_case.expected,
            tags=test_case.tags,
            scores=scores,
            latency_ms=latency_ms,
            token_usage=token_usage,
        )

    def _build_summary(
        self,
        passed: bool,
        overall_score: float,
        baseline_score: Optional[float],
        regressions: list[TagRegression],
        improvements: list[TagImprovement],
        genesis_score: Optional[float],
        genesis_delta: Optional[float],
    ) -> str:
        lines: list[str] = []

        lines.append("PASS" if passed else "FAIL")
        lines.append(f"Overall score: {overall_score * 100:.1f}%")

        if baseline_score is not None:
            delta = overall_score - baseline_score
            sign = "+" if delta >= 0 else ""
            lines.append(
                f"Baseline: {baseline_score * 100:.1f}% ({sign}{delta * 100:.1f}%)"
            )
        else:
            lines.append("No baseline — this run establishes the first baseline")

        if genesis_score is not None and genesis_delta is not None:
            sign = "+" if genesis_delta >= 0 else ""
            lines.append(f"Genesis gap: {sign}{genesis_delta * 100:.1f}%")

        if regressions:
            lines.append(f"Regressions ({len(regressions)}):")
            for r in regressions:
                scope = f"[{r.tag}]" if r.tag else "[overall]"
                lines.append(
                    f"  {scope} {r.scorer}: {r.baseline_score * 100:.1f}%"
                    f" → {r.current_score * 100:.1f}% ({r.delta * 100:.1f}%)"
                )

        if improvements:
            lines.append(f"Improvements ({len(improvements)}):")
            for imp in improvements:
                scope = f"[{imp.tag}]" if imp.tag else "[overall]"
                lines.append(
                    f"  {scope} {imp.scorer}: {imp.baseline_score * 100:.1f}%"
                    f" → {imp.current_score * 100:.1f}% (+{imp.delta * 100:.1f}%)"
                )

        return "\n".join(lines)


# --- In-Memory Baseline Store ---


class InMemoryBaselineStore:
    """Simple in-memory baseline store for testing and development."""

    def __init__(self) -> None:
        self._baselines: dict[str, RunResult] = {}
        self._history: dict[str, list[RunResult]] = {}
        self._genesis: dict[str, RunResult] = {}

    async def load(self, suite_id: str) -> Optional[RunResult]:
        return self._baselines.get(suite_id)

    async def save(self, suite_id: str, result: RunResult) -> None:
        self._baselines[suite_id] = result
        self._history.setdefault(suite_id, []).append(result)

    async def history(self, suite_id: str, limit: int) -> list[RunResult]:
        return self._history.get(suite_id, [])[-limit:]

    async def load_genesis(self, suite_id: str) -> Optional[RunResult]:
        return self._genesis.get(suite_id)

    async def save_genesis(self, suite_id: str, result: RunResult) -> None:
        # Genesis is immutable — only set if not already present
        if suite_id not in self._genesis:
            self._genesis[suite_id] = result


# --- Built-in Scorers ---


class ExactMatchScorer:
    """Exact string match scorer."""

    def __init__(self, case_sensitive: bool = False) -> None:
        self.name = "exact_match"
        self._case_sensitive = case_sensitive

    async def score(
        self, input: str, output: str, expected: Optional[str] = None
    ) -> ScorerResult:
        if expected is None:
            return ScorerResult(score=0, passed=False, reason="No expected output")
        a = output.strip() if self._case_sensitive else output.strip().lower()
        b = expected.strip() if self._case_sensitive else expected.strip().lower()
        match = a == b
        return ScorerResult(score=1 if match else 0, passed=match)


class ContainsScorer:
    """Output must contain expected as a substring."""

    def __init__(self) -> None:
        self.name = "contains"

    async def score(
        self, input: str, output: str, expected: Optional[str] = None
    ) -> ScorerResult:
        if expected is None:
            return ScorerResult(score=0, passed=False, reason="No expected output")
        contains = expected.lower() in output.lower()
        return ScorerResult(score=1 if contains else 0, passed=contains)


class CustomScorer:
    """Wraps an arbitrary scoring function."""

    def __init__(
        self,
        name: str,
        fn,
        pass_threshold: float = 0.5,
    ) -> None:
        self.name = name
        self._fn = fn
        self._pass_threshold = pass_threshold

    async def score(
        self, input: str, output: str, expected: Optional[str] = None
    ) -> ScorerResult:
        raw = self._fn(input, output, expected)
        # Support both sync and async scoring functions
        if asyncio.iscoroutine(raw):
            raw = await raw
        clamped = max(0.0, min(1.0, raw))
        return ScorerResult(score=clamped, passed=clamped >= self._pass_threshold)


# --- Factory functions (Pythonic API) ---


def exact_match_scorer(case_sensitive: bool = False) -> ExactMatchScorer:
    return ExactMatchScorer(case_sensitive)


def contains_scorer() -> ContainsScorer:
    return ContainsScorer()


def custom_scorer(name: str, fn, pass_threshold: float = 0.5) -> CustomScorer:
    return CustomScorer(name, fn, pass_threshold)


# --- Utilities ---


def _compute_aggregates(results: list[CaseResult], scorers) -> AggregateScores:
    scorer_names = [s.name for s in scorers]

    overall: dict[str, float] = {}
    for name in scorer_names:
        scores = [
            r.scores[name].score
            for r in results
            if name in r.scores
        ]
        overall[name] = _safe_mean(scores)

    by_tag: dict[str, dict[str, float]] = {}
    all_tags: set[str] = set()
    for r in results:
        all_tags.update(r.tags or [])

    for tag in all_tags:
        by_tag[tag] = {}
        tag_results = [r for r in results if tag in (r.tags or [])]
        for name in scorer_names:
            scores = [
                r.scores[name].score
                for r in tag_results
                if name in r.scores
            ]
            by_tag[tag][name] = _safe_mean(scores)

    pass_count = sum(
        1
        for r in results
        if all(r.scores.get(name, ScorerResult(0, False)).passed for name in scorer_names)
    )
    pass_rate = pass_count / len(results) if results else 0

    return AggregateScores(overall=overall, by_tag=by_tag, pass_rate=pass_rate)


def _safe_mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0


def _mean_of_scores(overall: dict[str, float]) -> float:
    values = list(overall.values())
    return _safe_mean(values)


def _generate_run_id() -> str:
    import random
    ts = hex(int(time.monotonic() * 1000))[2:]
    rand = hex(random.randint(0, 0xFFFFFF))[2:].zfill(6)
    return f"reg-{ts}-{rand}"

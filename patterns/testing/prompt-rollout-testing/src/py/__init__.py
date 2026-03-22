"""
Prompt Rollout Testing — Python implementation.

Safely deploys prompt changes using traffic splitting with statistical
evaluation. Supports A/B, canary, and shadow rollout modes.

Usage:
    provider = MockLLMProvider()
    tester = PromptRolloutTester(provider, config)
    result = await tester.run(LLMRequest(input=user_query))
    # result.response is always the current (safe) variant's output
"""

from __future__ import annotations

import asyncio
import math
import random
from copy import deepcopy
from dataclasses import dataclass
from typing import Optional

from .types import (
    LLMRequest,
    LLMResponse,
    PromptVariant,
    RolloutConfig,
    RolloutDecision,
    RolloutDecisionAction,
    RolloutMode,
    VariantStats,
)


@dataclass
class RunResult:
    """Result of a single routed request."""
    response: LLMResponse
    # Shadow/canary candidate output — logged but not returned to user in shadow mode
    candidate_output: Optional[LLMResponse] = None
    decision: Optional[RolloutDecision] = None


class PromptRolloutTester:
    """
    Routes requests across prompt variants with statistical analysis.
    Thread-safe for concurrent asyncio use (asyncio is single-threaded;
    for multi-process use, externalize stats storage).
    """

    def __init__(self, provider: object, config: RolloutConfig) -> None:
        _validate_config(config)
        self._provider = provider
        self._config = config
        self._stats: dict[str, VariantStats] = {
            v.id: VariantStats(variant_id=v.id, label=v.label)
            for v in config.variants
        }
        # Current weights — auto-rollback can modify these
        self._weights: dict[str, float] = {v.id: v.weight for v in config.variants}
        self._request_count = 0

    async def run(self, request: LLMRequest) -> RunResult:
        """Route a request, collect metrics, and optionally fire a decision."""
        self._request_count += 1

        if self._config.mode == RolloutMode.SHADOW:
            return await self._run_shadow(request)

        variant = self._select_variant()
        response = await self._call_variant(variant, request)
        await self._record_metrics(variant, request, response)

        decision: Optional[RolloutDecision] = None
        if self._should_evaluate():
            decision = await self._evaluate()
            if decision.action == RolloutDecisionAction.ROLLBACK and self._config.auto_rollback:
                self._apply_rollback()

        return RunResult(response=response, decision=decision)

    async def _run_shadow(self, request: LLMRequest) -> RunResult:
        """
        Shadow mode: run both variants concurrently, return only current.
        User latency is bounded by current variant; candidate runs in parallel.
        """
        current = self._get_current_variant()
        candidate = self._get_candidate_variant()

        current_task, candidate_task = await asyncio.gather(
            self._call_variant(current, request),
            self._call_variant(candidate, request),
            return_exceptions=True,
        )

        if isinstance(current_task, BaseException):
            raise current_task
        response = current_task
        candidate_output = candidate_task if not isinstance(candidate_task, BaseException) else None

        await self._record_metrics(current, request, response)
        if isinstance(candidate_output, LLMResponse):
            await self._record_metrics(candidate, request, candidate_output)

        decision: Optional[RolloutDecision] = None
        if self._should_evaluate():
            decision = await self._evaluate()
            if decision.action == RolloutDecisionAction.ROLLBACK and self._config.auto_rollback:
                self._apply_rollback()

        return RunResult(response=response, candidate_output=candidate_output, decision=decision)

    def _select_variant(self) -> PromptVariant:
        """Weighted random selection using current weights."""
        # random.choices handles float weights natively — idiomatic Python
        variant_ids = list(self._weights.keys())
        weights = [self._weights[vid] for vid in variant_ids]
        selected_id = random.choices(variant_ids, weights=weights, k=1)[0]
        return next(v for v in self._config.variants if v.id == selected_id)

    async def _call_variant(
        self, variant: PromptVariant, request: LLMRequest
    ) -> LLMResponse:
        result = await self._provider.complete(variant.prompt, request.input)  # type: ignore[attr-defined]
        return LLMResponse(
            output=str(result["output"]),
            variant_id=variant.id,
            latency_ms=float(result["latency_ms"]),
            input_tokens=int(result["input_tokens"]),
            output_tokens=int(result["output_tokens"]),
        )

    async def _record_metrics(
        self,
        variant: PromptVariant,
        request: LLMRequest,
        response: LLMResponse,
    ) -> None:
        quality = await self._config.quality_metric(response.output, request.input)
        stats = self._stats[variant.id]
        stats.request_count += 1
        stats.quality_scores.append(quality)
        stats.latencies_ms.append(response.latency_ms)
        stats.total_input_tokens += response.input_tokens
        stats.total_output_tokens += response.output_tokens

    def _should_evaluate(self) -> bool:
        return self._request_count % self._config.evaluation_interval == 0

    async def _evaluate(self) -> RolloutDecision:
        """
        Welch's t-test comparing current vs. candidate quality scores.
        Returns hold until both variants reach min_sample_size.
        """
        current = self._get_current_variant()
        candidate = self._get_candidate_variant()
        cs = self._stats[current.id]
        cands = self._stats[candidate.id]

        if (
            cs.request_count < self._config.min_sample_size
            or cands.request_count < self._config.min_sample_size
        ):
            return RolloutDecision(
                action=RolloutDecisionAction.HOLD,
                confidence=0.0,
                p_value=1.0,
                variant_stats=deepcopy(self._stats),
                reasoning=(
                    f"Insufficient samples: current={cs.request_count}, "
                    f"candidate={cands.request_count}, min={self._config.min_sample_size}"
                ),
            )

        current_mean = _mean(cs.quality_scores)
        candidate_mean = _mean(cands.quality_scores)
        p_value = welch_t_test(cs.quality_scores, cands.quality_scores)

        is_significant = p_value < self._config.significance_level
        quality_drop = current_mean - candidate_mean
        is_bad_candidate = quality_drop > self._config.rollback_threshold

        if is_significant and is_bad_candidate:
            action = RolloutDecisionAction.ROLLBACK
            reasoning = (
                f"Candidate significantly worse: Δ={quality_drop:.3f}, "
                f"p={p_value:.4f} (threshold={self._config.rollback_threshold}, "
                f"α={self._config.significance_level})"
            )
        elif is_significant and candidate_mean > current_mean:
            action = RolloutDecisionAction.PROMOTE
            reasoning = (
                f"Candidate significantly better: Δ={candidate_mean - current_mean:.3f}, "
                f"p={p_value:.4f} (α={self._config.significance_level})"
            )
        else:
            action = RolloutDecisionAction.HOLD
            reasoning = (
                f"No significant difference: Δ={candidate_mean - current_mean:.3f}, "
                f"p={p_value:.4f} (α={self._config.significance_level})"
            )

        return RolloutDecision(
            action=action,
            confidence=1.0 - p_value,
            p_value=p_value,
            variant_stats=deepcopy(self._stats),
            reasoning=reasoning,
        )

    def _apply_rollback(self) -> None:
        current = self._get_current_variant()
        for v in self._config.variants:
            self._weights[v.id] = 1.0 if v.id == current.id else 0.0

    def apply_promotion(self) -> None:
        candidate = self._get_candidate_variant()
        for v in self._config.variants:
            self._weights[v.id] = 1.0 if v.id == candidate.id else 0.0

    async def force_evaluate(self) -> RolloutDecision:
        return await self._evaluate()

    def get_stats(self) -> dict[str, VariantStats]:
        return deepcopy(self._stats)

    def get_weights(self) -> dict[str, float]:
        return dict(self._weights)

    @property
    def request_count(self) -> int:
        return self._request_count

    def _get_current_variant(self) -> PromptVariant:
        for v in self._config.variants:
            if v.label == "current":
                return v
        return self._config.variants[0]

    def _get_candidate_variant(self) -> PromptVariant:
        current = self._get_current_variant()
        for v in self._config.variants:
            if v.id != current.id:
                return v
        return self._config.variants[-1]


# ─── Statistical utilities ────────────────────────────────────────────────────

def _mean(values: list[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)


def _variance(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    m = _mean(values)
    return sum((v - m) ** 2 for v in values) / (len(values) - 1)


def welch_t_test(a: list[float], b: list[float]) -> float:
    """
    Welch's two-sample t-test (unequal variances, unequal sample sizes).
    Returns two-tailed p-value.

    Uses scipy.stats.ttest_ind with equal_var=False if scipy is available,
    falling back to a pure-Python implementation.
    """
    if len(a) < 2 or len(b) < 2:
        return 1.0

    try:
        from scipy import stats  # type: ignore[import-untyped]
        result = stats.ttest_ind(a, b, equal_var=False)
        p = float(result.pvalue)
        return p if not math.isnan(p) else 1.0
    except ImportError:
        return _welch_t_test_pure(a, b)


def _welch_t_test_pure(a: list[float], b: list[float]) -> float:
    """Pure-Python Welch t-test for environments without scipy."""
    na, nb = len(a), len(b)
    va, vb = _variance(a), _variance(b)
    se = math.sqrt(va / na + vb / nb)
    if se == 0:
        return 0.0 if _mean(a) != _mean(b) else 1.0

    t = abs(_mean(a) - _mean(b)) / se
    # Welch-Satterthwaite df
    num = (va / na + vb / nb) ** 2
    denom = (va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1)
    df = num / denom if denom > 0 else 1.0

    # Two-tailed p-value via regularized incomplete beta approximation
    x = df / (df + t * t)
    return _regularized_incomplete_beta(x, df / 2, 0.5)


def _regularized_incomplete_beta(x: float, a: float, b: float) -> float:
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    lbeta = math.lgamma(a) + math.lgamma(b) - math.lgamma(a + b)
    front = math.exp(math.log(x) * a + math.log(1 - x) * b - lbeta) / a
    if x < (a + 1) / (a + b + 2):
        return front * _beta_cf(x, a, b)
    front_b = math.exp(math.log(1 - x) * b + math.log(x) * a - lbeta) / b
    return 1.0 - front_b * _beta_cf(1 - x, b, a)


def _beta_cf(x: float, a: float, b: float) -> float:
    MAX_ITER = 200
    EPS = 3e-7
    c = d = h = 1.0
    d = 1 - (a + b) * x / (a + 1)
    if abs(d) < 1e-30:
        d = 1e-30
    d = 1 / d
    h = d
    for m in range(1, MAX_ITER + 1):
        num = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m))
        d = 1 + num * d
        if abs(d) < 1e-30:
            d = 1e-30
        c = 1 + num / c
        if abs(c) < 1e-30:
            c = 1e-30
        d = 1 / d
        h *= d * c

        num = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1))
        d = 1 + num * d
        if abs(d) < 1e-30:
            d = 1e-30
        c = 1 + num / c
        if abs(c) < 1e-30:
            c = 1e-30
        d = 1 / d
        delta = d * c
        h *= delta
        if abs(delta - 1) < EPS:
            break
    return h


def _validate_config(config: RolloutConfig) -> None:
    if len(config.variants) < 2:
        raise ValueError("RolloutConfig requires at least 2 variants")
    total = sum(v.weight for v in config.variants)
    if abs(total - 1.0) > 0.001:
        raise ValueError(f"Variant weights must sum to 1.0 (got {total})")
    if config.min_sample_size < 1:
        raise ValueError("min_sample_size must be >= 1")
    if not (0 < config.significance_level < 1):
        raise ValueError("significance_level must be in (0, 1)")

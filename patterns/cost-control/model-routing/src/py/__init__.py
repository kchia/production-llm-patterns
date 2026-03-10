"""Model Routing — route LLM requests to the cheapest model that meets quality requirements."""

from __future__ import annotations

import math
import re
import time
from collections import deque
from dataclasses import dataclass, field

from models import (
    CompletionResult,
    ComplexityClassifier,
    LLMProvider,
    ModelConfig,
    ModelTier,
    RouteDecision,
    RouteRequest,
    RouteResponse,
    RouterConfig,
    RouterStats,
)

# Expose key types at package level
__all__ = [
    "HeuristicClassifier",
    "ModelRouter",
    "ModelConfig",
    "ModelTier",
    "RouteDecision",
    "RouteRequest",
    "RouteResponse",
    "RouterConfig",
    "RouterStats",
]

_NUMBERED_STEP_RE = re.compile(r"\d+\.\s")
_CONDITIONAL_RE = re.compile(r"\b(?:if|when|unless|otherwise|alternatively)\b")

_SIMPLE_TASKS = frozenset({
    "classification",
    "extraction",
    "labeling",
    "tagging",
    "formatting",
    "translation",
})

_COMPLEX_TASKS = frozenset({
    "reasoning",
    "analysis",
    "code-generation",
    "creative-writing",
    "debate",
    "planning",
})

_COMPLEXITY_UP_KEYWORDS = (
    "analyze",
    "compare",
    "evaluate",
    "explain why",
    "trade-off",
    "pros and cons",
    "step by step",
    "reasoning",
    "implications",
    "critique",
)

_COMPLEXITY_DOWN_KEYWORDS = (
    "extract",
    "list",
    "classify",
    "label",
    "summarize briefly",
    "true or false",
    "yes or no",
    "format",
    "convert",
)


class HeuristicClassifier:
    """Score prompt complexity 0–1 using lightweight heuristics.

    Designed to run in <1ms. The goal is a rough cut, not perfect accuracy.
    Uses pre-compiled regexes for structural signal detection.
    """

    def classify(self, prompt: str, task_type: str | None = None) -> float:
        # Task type hint short-circuits the classifier
        if task_type is not None:
            lower_task = task_type.lower()
            if lower_task in _SIMPLE_TASKS:
                return 0.15
            if lower_task in _COMPLEX_TASKS:
                return 0.85

        score = 0.5

        # Token count signal
        estimated_tokens = math.ceil(len(prompt) / 4)
        if estimated_tokens < 50:
            score -= 0.15
        elif estimated_tokens < 200:
            score -= 0.05
        elif estimated_tokens > 500:
            score += 0.1
        elif estimated_tokens > 1000:
            score += 0.15

        lower = prompt.lower()

        # Structural signals — multi-step instructions
        numbered_steps = len(_NUMBERED_STEP_RE.findall(lower))
        if numbered_steps >= 3:
            score += 0.15
        elif numbered_steps >= 1:
            score += 0.05

        # Nested conditionals / branching
        conditionals = len(_CONDITIONAL_RE.findall(lower))
        if conditionals >= 3:
            score += 0.1

        # Code presence
        if "```" in prompt or "function " in prompt or "class " in prompt:
            score += 0.1

        # Keyword signals (capped at one match per direction)
        for kw in _COMPLEXITY_UP_KEYWORDS:
            if kw in lower:
                score += 0.05
                break

        for kw in _COMPLEXITY_DOWN_KEYWORDS:
            if kw in lower:
                score -= 0.05
                break

        return max(0.0, min(1.0, score))


class ModelRouter:
    """Route LLM requests to the appropriate model tier based on complexity."""

    _MAX_RECENT_DECISIONS = 100

    def __init__(
        self,
        provider: LLMProvider,
        config: RouterConfig | None = None,
        classifier: ComplexityClassifier | None = None,
    ) -> None:
        self._config = config or RouterConfig()
        self._provider = provider
        self._classifier = classifier or HeuristicClassifier()

        self._total_requests = 0
        self._routes_by_tier: dict[ModelTier, int] = {t: 0 for t in ModelTier}
        self._total_complexity_score = 0.0
        self._classification_errors = 0
        self._recent_decisions: deque[RouteDecision] = deque(
            maxlen=self._MAX_RECENT_DECISIONS
        )

    async def route(self, request: RouteRequest) -> RouteResponse:
        """Route a request to the appropriate model based on complexity."""
        start = time.perf_counter()

        try:
            complexity_score = self._classifier.classify(
                request.prompt, request.task_type
            )
            tier = self._score_to_tier(complexity_score)
        except Exception:
            self._classification_errors += 1
            complexity_score = -1.0
            tier = self._config.fallback_tier

        model = self._config.models[tier]
        result = await self._provider.complete(model.id, request.prompt)
        latency_ms = (time.perf_counter() - start) * 1000

        self._total_requests += 1
        self._routes_by_tier[tier] += 1
        if complexity_score >= 0:
            self._total_complexity_score += complexity_score

        self._recent_decisions.append(
            RouteDecision(
                timestamp=time.time(),
                complexity_score=complexity_score,
                tier=tier,
                model=model.id,
                task_type=request.task_type,
                latency_ms=latency_ms,
                input_tokens=result.input_tokens,
                output_tokens=result.output_tokens,
            )
        )

        return RouteResponse(
            response=result.response,
            model=model.id,
            tier=tier,
            complexity_score=complexity_score,
            latency_ms=latency_ms,
            input_tokens=result.input_tokens,
            output_tokens=result.output_tokens,
        )

    def _score_to_tier(self, score: float) -> ModelTier:
        if score <= self._config.weak_threshold:
            return ModelTier.WEAK
        if score >= self._config.strong_threshold:
            return ModelTier.STRONG
        return ModelTier.MID

    def get_stats(self) -> RouterStats:
        valid = self._total_requests - self._classification_errors
        return RouterStats(
            total_requests=self._total_requests,
            routes_by_tier=dict(self._routes_by_tier),
            average_complexity_score=(
                self._total_complexity_score / valid if valid > 0 else 0.0
            ),
            classification_errors=self._classification_errors,
            recent_decisions=list(self._recent_decisions),
        )

    def get_tier_distribution(self) -> dict[ModelTier, float]:
        total = self._total_requests or 1
        return {tier: count / total for tier, count in self._routes_by_tier.items()}

    def update_config(self, **kwargs: object) -> None:
        """Update config fields at runtime. Pass keyword arguments matching RouterConfig fields."""
        for key, value in kwargs.items():
            if hasattr(self._config, key):
                setattr(self._config, key, value)

    def reset_stats(self) -> None:
        self._total_requests = 0
        self._routes_by_tier = {t: 0 for t in ModelTier}
        self._total_complexity_score = 0.0
        self._classification_errors = 0
        self._recent_decisions.clear()

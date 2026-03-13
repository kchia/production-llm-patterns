"""Output Quality Monitoring — async scoring pipeline for production LLM interactions.

Samples interactions, runs registered scorers, aggregates per dimension,
tracks baselines via exponential moving average, and alerts on degradation.
"""

from __future__ import annotations

import asyncio
import math
import random
import re
import time
from dataclasses import dataclass, field

from .types import (
    AlertHandler,
    AlertSeverity,
    BaselineEntry,
    HealthStatus,
    LLMInteraction,
    QualityAlert,
    QualityMonitorConfig,
    QualitySnapshot,
    Scorer,
    ScoreResult,
    ScorerTimeoutError,
    StoredScore,
    TimeWindow,
)


# ---------------------------------------------------------------------------
# Built-in Scorers
# ---------------------------------------------------------------------------


class LengthScorer:
    """Scores output length on a 0-1 scale. Longer outputs score higher, with
    diminishing returns past `ideal_length` characters."""

    name = "length"

    def __init__(self, ideal_length: int = 500):
        self._ideal = ideal_length

    async def score(self, interaction: LLMInteraction) -> ScoreResult:
        start = time.perf_counter()
        length = len(interaction.output)
        # Asymptotic curve: approaches 1.0 as length grows
        value = min(1.0, length / self._ideal) if self._ideal > 0 else 0.0
        duration_ms = (time.perf_counter() - start) * 1000
        return ScoreResult(scorer_name=self.name, value=value, duration_ms=duration_ms)


class FormatScorer:
    """Scores how many of the expected regex patterns appear in the output."""

    name = "format"

    def __init__(self, patterns: list[re.Pattern[str] | str]):
        self._patterns = [
            p if isinstance(p, re.Pattern) else re.compile(p) for p in patterns
        ]

    async def score(self, interaction: LLMInteraction) -> ScoreResult:
        start = time.perf_counter()
        if not self._patterns:
            value = 1.0
        else:
            matches = sum(
                1 for p in self._patterns if p.search(interaction.output)
            )
            value = matches / len(self._patterns)
        duration_ms = (time.perf_counter() - start) * 1000
        return ScoreResult(scorer_name=self.name, value=value, duration_ms=duration_ms)


class KeywordScorer:
    """Scores presence of expected keywords in the output (case-insensitive)."""

    name = "keyword"

    def __init__(self, keywords: list[str]):
        self._keywords = [k.lower() for k in keywords]

    async def score(self, interaction: LLMInteraction) -> ScoreResult:
        start = time.perf_counter()
        if not self._keywords:
            value = 1.0
        else:
            lower_output = interaction.output.lower()
            matches = sum(1 for k in self._keywords if k in lower_output)
            value = matches / len(self._keywords)
        duration_ms = (time.perf_counter() - start) * 1000
        return ScoreResult(
            scorer_name=self.name, value=value, duration_ms=duration_ms
        )


# ---------------------------------------------------------------------------
# Sampler
# ---------------------------------------------------------------------------


class Sampler:
    """Rate-based sampler with optional per-dimension overrides."""

    def __init__(
        self,
        rate: float = 0.1,
        dimension_overrides: dict[str, float] | None = None,
    ):
        self._rate = max(0.0, min(1.0, rate))
        self._overrides = dimension_overrides or {}

    def should_sample(self, interaction: LLMInteraction) -> bool:
        # Check dimension overrides first (prompt_template, model)
        for dim_value, override_rate in self._overrides.items():
            if (
                interaction.prompt_template == dim_value
                or interaction.model == dim_value
            ):
                return random.random() < override_rate
        return random.random() < self._rate


# ---------------------------------------------------------------------------
# Score Store
# ---------------------------------------------------------------------------


class ScoreStore:
    """In-memory score storage with time-range queries and eviction."""

    def __init__(self, max_size: int = 10_000):
        self._max_size = max_size
        self._entries: list[StoredScore] = []

    def add(self, entry: StoredScore) -> None:
        self._entries.append(entry)
        # Evict oldest entries when exceeding capacity
        if len(self._entries) > self._max_size:
            excess = len(self._entries) - self._max_size
            self._entries = self._entries[excess:]

    def query(
        self,
        window: TimeWindow | dict[str, float] | None = None,
        dimension_filter: dict[str, str] | None = None,
    ) -> list[StoredScore]:
        """Query scores within a time window and optional dimension filter."""
        # Normalize window — accept both TimeWindow and dict forms
        if isinstance(window, dict):
            start_ms = window.get("start_ms", window.get("startMs", 0))
            end_ms = window.get("end_ms", window.get("endMs", float("inf")))
        elif window is not None:
            start_ms = window.start_ms
            end_ms = window.end_ms
        else:
            start_ms = 0
            end_ms = float("inf")

        results: list[StoredScore] = []
        for entry in self._entries:
            if not (start_ms <= entry.timestamp <= end_ms):
                continue
            if dimension_filter:
                match = all(
                    entry.dimensions.get(k) == v
                    for k, v in dimension_filter.items()
                )
                if not match:
                    continue
            results.append(entry)
        return results

    @property
    def size(self) -> int:
        return len(self._entries)


# ---------------------------------------------------------------------------
# Aggregator
# ---------------------------------------------------------------------------


def _percentile(sorted_values: list[float], p: float) -> float:
    """Compute the p-th percentile from a pre-sorted list."""
    if not sorted_values:
        return 0.0
    idx = max(0, math.ceil((p / 100) * len(sorted_values)) - 1)
    return sorted_values[idx]


class Aggregator:
    """Computes windowed quality snapshots from stored scores."""

    def __init__(self, store: ScoreStore):
        self._store = store

    def snapshot(
        self,
        window: TimeWindow,
        scorer_name: str,
        dimension_key: str = "",
        dimension_value: str = "",
    ) -> QualitySnapshot | None:
        dim_filter = {dimension_key: dimension_value} if dimension_key else None
        entries = self._store.query(window, dim_filter)

        values: list[float] = []
        for entry in entries:
            for s in entry.scores:
                if s.scorer_name == scorer_name:
                    values.append(s.value)

        if not values:
            return None

        sorted_vals = sorted(values)
        return QualitySnapshot(
            window=window,
            scorer_name=scorer_name,
            dimension_key=dimension_key,
            dimension_value=dimension_value,
            mean=sum(sorted_vals) / len(sorted_vals),
            p50=_percentile(sorted_vals, 50),
            p95=_percentile(sorted_vals, 95),
            sample_count=len(sorted_vals),
        )


# ---------------------------------------------------------------------------
# Baseline Tracker
# ---------------------------------------------------------------------------


class BaselineTracker:
    """Exponential moving average tracker per dimension::scorer key.

    Higher decay values (e.g. 0.99) make the baseline slow to adapt —
    good for stability but can mask gradual degradation. Lower values
    (e.g. 0.9) adapt quickly but chase noise.
    """

    def __init__(self, decay: float = 0.95):
        self._decay = decay
        self._baselines: dict[str, BaselineEntry] = {}

    def _key(self, dimension: str, scorer_name: str) -> str:
        return f"{dimension}::{scorer_name}"

    def update(self, dimension: str, scorer_name: str, value: float) -> None:
        key = self._key(dimension, scorer_name)
        existing = self._baselines.get(key)
        now = time.time() * 1000

        if existing is None:
            self._baselines[key] = BaselineEntry(
                value=value, sample_count=1, last_updated=now
            )
        else:
            # EMA: new_baseline = decay * old + (1 - decay) * new_value
            existing.value = self._decay * existing.value + (1 - self._decay) * value
            existing.sample_count += 1
            existing.last_updated = now

    def get(self, dimension: str, scorer_name: str) -> BaselineEntry | None:
        return self._baselines.get(self._key(dimension, scorer_name))

    def all_entries(self) -> dict[str, BaselineEntry]:
        return dict(self._baselines)


# ---------------------------------------------------------------------------
# QualityMonitor — main orchestrator
# ---------------------------------------------------------------------------


async def _with_timeout(coro, timeout_ms: float, scorer_name: str) -> ScoreResult:
    """Race a scorer coroutine against a timeout. Also catches scorer exceptions."""
    try:
        return await asyncio.wait_for(coro, timeout=timeout_ms / 1000)
    except asyncio.TimeoutError:
        return ScoreResult(
            scorer_name=scorer_name,
            value=0.0,
            duration_ms=timeout_ms,
            error=f"Timeout after {timeout_ms}ms",
        )
    except Exception as exc:
        return ScoreResult(
            scorer_name=scorer_name,
            value=0.0,
            duration_ms=0.0,
            error=str(exc),
        )


@dataclass
class _Metrics:
    """Internal metrics counters."""

    recorded: int = 0
    sampled: int = 0
    scored: int = 0
    scorer_timeouts: int = 0
    scorer_errors: int = 0
    queue_dropped: int = 0


class QualityMonitor:
    """Core orchestrator: record → sample → score → store → baseline → alert.

    The scoring pipeline runs asynchronously — it doesn't block the
    caller's response path. Backpressure is enforced via max_queue_depth.
    """

    def __init__(self, config: QualityMonitorConfig | dict | None = None):
        if config is None:
            self._config = QualityMonitorConfig()
        elif isinstance(config, dict):
            self._config = QualityMonitorConfig(**config)
        else:
            self._config = config

        self._scorers: list[Scorer] = []
        self._sampler = Sampler(self._config.sample_rate)
        self._store = ScoreStore(self._config.max_queue_depth)
        self._aggregator = Aggregator(self._store)
        self._baseline_tracker = BaselineTracker(self._config.baseline_decay)
        self._alert_handlers: list[AlertHandler] = []
        self._active_alerts: list[QualityAlert] = []
        self._metrics = _Metrics()
        self._processing_queue = 0

    # -- Registration --

    def register_scorer(self, scorer: Scorer) -> None:
        self._scorers.append(scorer)

    def on_alert(self, handler: AlertHandler) -> None:
        self._alert_handlers.append(handler)

    # -- Core pipeline --

    async def record(self, interaction: LLMInteraction) -> None:
        """Entry point: sample, score, store, check alerts."""
        self._metrics.recorded += 1

        if not self._sampler.should_sample(interaction):
            return

        self._metrics.sampled += 1

        # Backpressure check
        if self._processing_queue >= self._config.max_queue_depth:
            self._metrics.queue_dropped += 1
            return

        self._processing_queue += 1
        try:
            scores = await self._run_scorers(interaction)
            self._metrics.scored += 1

            # Build dimension map from interaction
            dimensions: dict[str, str] = {}
            for dim in self._config.dimensions:
                if dim == "prompt_template":
                    dimensions[dim] = interaction.prompt_template
                elif dim == "model":
                    dimensions[dim] = interaction.model
                elif dim in interaction.metadata:
                    dimensions[dim] = str(interaction.metadata[dim])

            stored = StoredScore(
                interaction_id=interaction.id,
                timestamp=interaction.timestamp,
                dimensions=dimensions,
                scores=scores,
            )
            self._store.add(stored)

            # Update baselines and check alerts
            self._update_baselines(scores, dimensions)
            self._check_alerts(scores, dimensions)
        finally:
            self._processing_queue -= 1

    async def _run_scorers(
        self, interaction: LLMInteraction
    ) -> list[ScoreResult]:
        """Run all registered scorers with timeout protection."""
        results: list[ScoreResult] = []
        for scorer in self._scorers:
            result = await _with_timeout(
                scorer.score(interaction),
                self._config.scorer_timeout_ms,
                scorer.name,
            )
            if result.error and "Timeout" in result.error:
                self._metrics.scorer_timeouts += 1
            elif result.error:
                self._metrics.scorer_errors += 1
            results.append(result)
        return results

    def _update_baselines(
        self, scores: list[ScoreResult], dimensions: dict[str, str]
    ) -> None:
        for score in scores:
            if score.error:
                continue
            # Update global baseline
            self._baseline_tracker.update("__global__", score.scorer_name, score.value)
            # Update per-dimension baselines
            for dim_key, dim_value in dimensions.items():
                dim_label = f"{dim_key}={dim_value}"
                self._baseline_tracker.update(dim_label, score.scorer_name, score.value)

    def _check_alerts(
        self, scores: list[ScoreResult], dimensions: dict[str, str]
    ) -> None:
        for score in scores:
            if score.error:
                continue
            # Absolute threshold check
            if score.value < self._config.absolute_threshold:
                self._emit_alert(
                    severity=AlertSeverity.CRITICAL,
                    scorer_name=score.scorer_name,
                    dimension_key="__global__",
                    dimension_value="__global__",
                    current_value=score.value,
                    baseline_value=self._config.absolute_threshold,
                    threshold=self._config.absolute_threshold,
                    message=(
                        f"Score {score.value:.3f} below absolute threshold "
                        f"{self._config.absolute_threshold}"
                    ),
                )

            # Relative-to-baseline check
            baseline = self._baseline_tracker.get("__global__", score.scorer_name)
            if (
                baseline
                and baseline.sample_count >= self._config.min_samples_for_alert
            ):
                drop = baseline.value - score.value
                if drop > self._config.relative_threshold:
                    self._emit_alert(
                        severity=AlertSeverity.WARNING,
                        scorer_name=score.scorer_name,
                        dimension_key="__global__",
                        dimension_value="__global__",
                        current_value=score.value,
                        baseline_value=baseline.value,
                        threshold=self._config.relative_threshold,
                        message=(
                            f"Score {score.value:.3f} dropped {drop:.3f} from "
                            f"baseline {baseline.value:.3f} (threshold: "
                            f"{self._config.relative_threshold})"
                        ),
                    )

    def _emit_alert(self, **kwargs) -> None:
        alert = QualityAlert(**kwargs)
        self._active_alerts.append(alert)
        for handler in self._alert_handlers:
            try:
                handler(alert)
            except Exception:
                pass  # Alert handlers must not break the pipeline

    # -- Query API --

    def get_scores(
        self,
        dimension_key: str | None = None,
        dimension_value: str | None = None,
        window: TimeWindow | None = None,
    ) -> list[StoredScore]:
        """Retrieve stored scores, optionally filtered by dimension and time."""
        dim_filter = (
            {dimension_key: dimension_value}
            if dimension_key and dimension_value
            else None
        )
        return self._store.query(window, dim_filter)

    def check_health(self) -> HealthStatus:
        return HealthStatus(
            healthy=len(self._active_alerts) == 0,
            active_alerts=list(self._active_alerts),
            scorer_count=len(self._scorers),
            total_scored=self._metrics.scored,
            total_sampled=self._metrics.sampled,
            queue_depth=self._processing_queue,
            queue_dropped=self._metrics.queue_dropped,
        )

    def get_metrics(self) -> dict:
        return {
            "recorded": self._metrics.recorded,
            "sampled": self._metrics.sampled,
            "scored": self._metrics.scored,
            "scorer_timeouts": self._metrics.scorer_timeouts,
            "scorer_errors": self._metrics.scorer_errors,
            "queue_dropped": self._metrics.queue_dropped,
        }

    def get_snapshot(
        self,
        scorer_name: str,
        dimension_key: str = "",
        dimension_value: str = "",
        window: TimeWindow | None = None,
    ) -> QualitySnapshot | None:
        if window is None:
            now = time.time() * 1000
            window = TimeWindow(
                start_ms=now - self._config.window_size_ms, end_ms=now
            )
        return self._aggregator.snapshot(
            window, scorer_name, dimension_key, dimension_value
        )

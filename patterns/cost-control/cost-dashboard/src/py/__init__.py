"""
Cost Dashboard — Core Implementation (Python)

Tracks, attributes, and aggregates LLM API spend.

Three layers:
  1. PriceTable         — compute cost from token counts + current prices
  2. InMemorySpendStore — append-only event log with window-based retrieval
  3. CostDashboard      — record(), query(), check_alerts() on top of the store

Python differences from TypeScript:
  - asyncio for concurrent operations (vs. Promise.all)
  - dataclasses for structured types (vs. interfaces)
  - threading.Lock for thread-safe writes (Python has the GIL but async tasks
    can interleave writes — explicit locking makes intent clear)
  - defaultdict for group-by aggregation (vs. Map)
  - logging module instead of console.warn
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine, Optional, TypeVar

from .types import (
    Alert,
    AlertConfig,
    AlertSeverity,
    AlertType,
    BUILT_IN_PRICES,
    CostDashboardConfig,
    CostEvent,
    GroupByDimension,
    ModelPrice,
    QueryFilters,
    QueryParams,
    SpendSummary,
)

log = logging.getLogger(__name__)

T = TypeVar("T")


# ─── Spend Store ──────────────────────────────────────────────────────────────

class InMemorySpendStore:
    """
    Append-only in-memory event log.

    Thread/task-safe: an asyncio.Lock guards all mutations. Python's GIL
    doesn't protect interleaved async writes — the lock makes the intent
    explicit and future-proofs against threading usage.
    """

    def __init__(self) -> None:
        self._events: list[CostEvent] = []
        self._lock = asyncio.Lock()

    async def record(self, event: CostEvent) -> None:
        async with self._lock:
            self._events.append(event)

    def get_events(self, start_time: datetime, end_time: datetime) -> list[CostEvent]:
        return [
            e for e in self._events
            if start_time <= e.timestamp <= end_time
        ]

    def get_all_events(self) -> list[CostEvent]:
        return list(self._events)

    def clear(self) -> None:
        self._events.clear()

    def __len__(self) -> int:
        return len(self._events)


# ─── Price Table ──────────────────────────────────────────────────────────────

class PriceTable:
    """Computes request cost from token counts + current per-model prices."""

    def __init__(self, initial_prices: list[ModelPrice] = BUILT_IN_PRICES) -> None:
        self._prices: dict[str, ModelPrice] = {p.model: p for p in initial_prices}
        self._last_refreshed = datetime.now(timezone.utc)

    def compute_cost(self, model: str, input_tokens: int, output_tokens: int) -> float:
        """
        Returns cost in USD. Returns 0.0 for unknown models (caller should alert).
        Division by 1M matches the "per million tokens" pricing convention.
        """
        price = self._prices.get(model)
        if price is None:
            return 0.0
        return (
            (input_tokens  / 1_000_000) * price.input_price_per_million_tokens
            + (output_tokens / 1_000_000) * price.output_price_per_million_tokens
        )

    def update_prices(self, new_prices: list[ModelPrice]) -> None:
        for p in new_prices:
            self._prices[p.model] = p
        self._last_refreshed = datetime.now(timezone.utc)

    def age_seconds(self) -> float:
        delta = datetime.now(timezone.utc) - self._last_refreshed
        return delta.total_seconds()

    def has_model(self, model: str) -> bool:
        return model in self._prices

    @property
    def last_refreshed(self) -> datetime:
        return self._last_refreshed


# ─── Alert Engine ─────────────────────────────────────────────────────────────

class AlertEngine:
    """
    Pull-based alert evaluator. Checks thresholds against the store on demand.
    Run this on a schedule (every 5–15 minutes), not per-request.
    """

    # Warning/critical thresholds in seconds
    STALE_WARNING_S  = 2 * 3600   # 2 hours
    STALE_CRITICAL_S = 6 * 3600   # 6 hours

    def __init__(self, config: AlertConfig) -> None:
        self.config = config

    def evaluate(self, store: InMemorySpendStore, price_table_age_s: float) -> list[Alert]:
        alerts: list[Alert] = []
        now = datetime.now(timezone.utc)

        # Price table staleness
        if price_table_age_s > self.STALE_CRITICAL_S:
            alerts.append(Alert(
                type=AlertType.PRICE_TABLE_STALE,
                severity=AlertSeverity.CRITICAL,
                message=f"Price table last refreshed {price_table_age_s / 3600:.1f}h ago — cost calculations may be wrong",
                context={"age_hours": round(price_table_age_s / 3600, 1)},
                fired_at=now,
            ))
        elif price_table_age_s > self.STALE_WARNING_S:
            alerts.append(Alert(
                type=AlertType.PRICE_TABLE_STALE,
                severity=AlertSeverity.WARNING,
                message=f"Price table last refreshed {price_table_age_s / 3600:.1f}h ago",
                context={"age_hours": round(price_table_age_s / 3600, 1)},
                fired_at=now,
            ))

        all_events = store.get_all_events()
        if not all_events:
            return alerts

        # Spike detection: compare current window vs. rolling baseline
        current_ms  = self.config.current_window_hours  * 3600 * 1000
        baseline_ms = self.config.baseline_window_hours * 3600 * 1000
        now_ts_ms   = now.timestamp() * 1000

        current_start  = datetime.fromtimestamp((now_ts_ms - current_ms)  / 1000, tz=timezone.utc)
        baseline_start = datetime.fromtimestamp((now_ts_ms - baseline_ms) / 1000, tz=timezone.utc)

        current_events  = [e for e in all_events if e.timestamp >= current_start]
        baseline_events = [e for e in all_events if baseline_start <= e.timestamp < current_start]

        current_by_feature  = _group_by_feature(current_events)
        baseline_by_feature = _group_by_feature(baseline_events)

        # Normalize baseline to the same window length as current for fair comparison
        norm_factor = (current_ms / baseline_ms) if baseline_ms > 0 else 1.0

        for feature, current_spend in current_by_feature.items():
            baseline_spend = baseline_by_feature.get(feature, 0.0) * norm_factor
            if baseline_spend > 0 and current_spend > baseline_spend * self.config.spike_sensitivity:
                multiple = current_spend / baseline_spend
                alerts.append(Alert(
                    type=AlertType.SPIKE,
                    severity=(
                        AlertSeverity.CRITICAL
                        if multiple > self.config.spike_sensitivity * 2
                        else AlertSeverity.WARNING
                    ),
                    message=f'Spend spike detected for feature "{feature}": {multiple:.1f}× baseline',
                    context={
                        "feature": feature,
                        "current_spend_usd": current_spend,
                        "baseline_spend_usd": baseline_spend,
                        "multiple": round(multiple, 1),
                    },
                    fired_at=now,
                ))

        # Concentration risk: one feature > threshold % of total spend
        window_events = store.get_events(current_start, now)
        total_spend   = sum(e.cost_usd for e in window_events)
        if total_spend > 0:
            for feature, spend in _group_by_feature(window_events).items():
                fraction = spend / total_spend
                if fraction > self.config.concentration_risk_threshold:
                    alerts.append(Alert(
                        type=AlertType.CONCENTRATION_RISK,
                        severity=AlertSeverity.CRITICAL if fraction > 0.60 else AlertSeverity.WARNING,
                        message=f'Feature "{feature}" accounts for {fraction:.0%} of spend',
                        context={
                            "feature": feature,
                            "fraction": round(fraction, 3),
                            "total_spend_usd": total_spend,
                        },
                        fired_at=now,
                    ))

        # Missing tags: events with "unknown" feature
        unknown_count = sum(1 for e in all_events if e.feature == "unknown")
        if all_events:
            unknown_fraction = unknown_count / len(all_events)
            if unknown_fraction > 0.25:
                alerts.append(Alert(
                    type=AlertType.MISSING_TAGS,
                    severity=AlertSeverity.CRITICAL,
                    message=f"{unknown_fraction:.0%} of events have no feature attribution",
                    context={
                        "unknown_count": unknown_count,
                        "total_events": len(all_events),
                        "unknown_fraction": round(unknown_fraction, 3),
                    },
                    fired_at=now,
                ))
            elif unknown_fraction > 0.10:
                alerts.append(Alert(
                    type=AlertType.MISSING_TAGS,
                    severity=AlertSeverity.WARNING,
                    message=f"{unknown_fraction:.0%} of events have no feature attribution",
                    context={
                        "unknown_count": unknown_count,
                        "total_events": len(all_events),
                        "unknown_fraction": round(unknown_fraction, 3),
                    },
                    fired_at=now,
                ))

        return alerts


def _group_by_feature(events: list[CostEvent]) -> dict[str, float]:
    result: dict[str, float] = defaultdict(float)
    for e in events:
        result[e.feature] += e.cost_usd
    return dict(result)


# ─── Cost Dashboard ───────────────────────────────────────────────────────────

class CostDashboard:
    """
    Main entry point. Combines the store, price table, and alert engine.

    Typical usage:
        dashboard = CostDashboard()
        response = await track_cost(dashboard, provider.complete(prompt), ctx)
    """

    def __init__(
        self,
        config: Optional[CostDashboardConfig] = None,
        store: Optional[InMemorySpendStore] = None,
        price_table: Optional[PriceTable] = None,
    ) -> None:
        self.config = config or CostDashboardConfig()
        self._store = store or InMemorySpendStore()
        self._price_table = price_table or PriceTable()
        self._alert_engine = AlertEngine(self.config.alert_config)
        self._missing_tag_counts: dict[str, int] = defaultdict(int)

    async def record(
        self,
        *,
        timestamp: datetime,
        request_id: str,
        feature: str,
        model: str,
        prompt_version: str,
        input_tokens: int,
        output_tokens: int,
        latency_ms: int,
        tags: Optional[dict[str, str]] = None,
        user_id: Optional[str] = None,
        team_id: Optional[str] = None,
    ) -> CostEvent:
        """
        Record a completed LLM request.

        Missing required tags are logged and resolved to "unknown" rather than
        silently dropped — attribution quality degrades visibly, not invisibly.
        """
        resolved_feature = feature
        if "feature" in self.config.required_tags and not feature:
            log.warning("Missing required tag 'feature' on request %s", request_id)
            self._missing_tag_counts["feature"] += 1
            resolved_feature = "unknown"

        if not self._price_table.has_model(model):
            log.warning(
                "Unknown model '%s' — cost recorded as $0.00. Add it to the price table.",
                model,
            )

        cost_usd = self._price_table.compute_cost(model, input_tokens, output_tokens)

        event = CostEvent(
            timestamp=timestamp,
            request_id=request_id,
            feature=resolved_feature,
            model=model,
            prompt_version=prompt_version,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_usd=cost_usd,
            latency_ms=latency_ms,
            tags=tags or {},
            user_id=user_id,
            team_id=team_id,
        )
        await self._store.record(event)
        return event

    def query(self, params: QueryParams) -> list[SpendSummary]:
        """
        Aggregate spend by dimension over a time range.
        Returns summaries sorted by total_cost_usd descending.
        """
        events = self._store.get_events(params.start_time, params.end_time)

        # Apply filters
        if params.filters:
            events = _apply_filters(events, params.filters)

        # Group by requested dimension
        groups: dict[str, list[CostEvent]] = defaultdict(list)
        for event in events:
            key = _get_dimension_value(event, params.group_by)
            groups[key].append(event)

        summaries: list[SpendSummary] = []
        for dim_value, group in groups.items():
            total_cost = sum(e.cost_usd for e in group)
            if params.min_cost_usd is not None and total_cost < params.min_cost_usd:
                continue
            summaries.append(SpendSummary(
                dimension_value=dim_value,
                total_cost_usd=total_cost,
                total_requests=len(group),
                total_input_tokens=sum(e.input_tokens for e in group),
                total_output_tokens=sum(e.output_tokens for e in group),
                avg_cost_per_request_usd=total_cost / len(group),
                start_time=params.start_time,
                end_time=params.end_time,
            ))

        return sorted(summaries, key=lambda s: s.total_cost_usd, reverse=True)

    def compute_cost(self, model: str, input_tokens: int, output_tokens: int) -> float:
        """Compute cost without recording — useful for pre-flight estimates."""
        return self._price_table.compute_cost(model, input_tokens, output_tokens)

    def check_alerts(self) -> list[Alert]:
        """Evaluate all alert thresholds and return fired alerts."""
        return self._alert_engine.evaluate(self._store, self._price_table.age_seconds())

    def update_prices(self, new_prices: list[ModelPrice]) -> None:
        self._price_table.update_prices(new_prices)

    @property
    def missing_tag_counts(self) -> dict[str, int]:
        return dict(self._missing_tag_counts)

    @property
    def store(self) -> InMemorySpendStore:
        return self._store

    @property
    def price_table(self) -> PriceTable:
        return self._price_table


def _apply_filters(events: list[CostEvent], filters: QueryFilters) -> list[CostEvent]:
    result = events
    if filters.feature is not None:
        result = [e for e in result if e.feature  == filters.feature]
    if filters.model is not None:
        result = [e for e in result if e.model    == filters.model]
    if filters.user_id is not None:
        result = [e for e in result if e.user_id  == filters.user_id]
    if filters.team_id is not None:
        result = [e for e in result if e.team_id  == filters.team_id]
    return result


def _get_dimension_value(event: CostEvent, dim: GroupByDimension) -> str:
    match dim:
        case GroupByDimension.FEATURE:       return event.feature
        case GroupByDimension.MODEL:         return event.model
        case GroupByDimension.USER:          return event.user_id or "anonymous"
        case GroupByDimension.PROMPT_VERSION: return event.prompt_version
        case GroupByDimension.TEAM:          return event.team_id or "unassigned"


# ─── Middleware Helper ────────────────────────────────────────────────────────

async def track_cost(
    dashboard: CostDashboard,
    coro: Coroutine[Any, Any, Any],
    *,
    feature: str,
    model: str,
    prompt_version: str = "unversioned",
    user_id: Optional[str] = None,
    team_id: Optional[str] = None,
    tags: Optional[dict[str, str]] = None,
) -> Any:
    """
    Wrap a provider coroutine to automatically record the cost event.

    Usage:
        response = await track_cost(
            dashboard,
            provider.complete(prompt, "gpt-4o"),
            feature="document-analysis",
            model="gpt-4o",
            prompt_version="v2.1",
        )
    """
    start_ns = time.perf_counter_ns()
    result   = await coro
    latency_ms = (time.perf_counter_ns() - start_ns) // 1_000_000

    # Expect result to have .usage with input_tokens/output_tokens and .model
    usage = result.usage if hasattr(result, "usage") else {}
    resolved_model = getattr(result, "model", model)

    await dashboard.record(
        timestamp=datetime.now(timezone.utc),
        request_id=str(uuid.uuid4()),
        feature=feature,
        model=resolved_model,
        prompt_version=prompt_version,
        input_tokens=usage.get("input_tokens", 0) if isinstance(usage, dict) else getattr(usage, "input_tokens", 0),
        output_tokens=usage.get("output_tokens", 0) if isinstance(usage, dict) else getattr(usage, "output_tokens", 0),
        latency_ms=latency_ms,
        tags=tags or {},
        user_id=user_id,
        team_id=team_id,
    )

    return result


__all__ = [
    "CostDashboard",
    "InMemorySpendStore",
    "PriceTable",
    "AlertEngine",
    "track_cost",
    "CostEvent",
    "SpendSummary",
    "QueryParams",
    "QueryFilters",
    "Alert",
    "AlertConfig",
    "ModelPrice",
    "CostDashboardConfig",
    "GroupByDimension",
    "AlertType",
    "AlertSeverity",
]

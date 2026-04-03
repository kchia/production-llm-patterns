"""
Cost Dashboard — Python Tests

Three categories:
  1. Unit tests       — core logic under normal conditions
  2. Failure mode     — one test per failure mode from the README table
  3. Integration      — end-to-end with mock provider
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from cost_dashboard import (
    AlertEngine,
    CostDashboard,
    InMemorySpendStore,
    PriceTable,
    track_cost,
)
from cost_dashboard.mock_provider import MockProvider
from cost_dashboard.types import (
    BUILT_IN_PRICES,
    AlertConfig,
    CostDashboardConfig,
    CostEvent,
    GroupByDimension,
    QueryFilters,
    QueryParams,
)

from .conftest import make_event

# ─── Helpers ──────────────────────────────────────────────────────────────────

NOW = datetime.now(timezone.utc)
START = NOW - timedelta(hours=1)
END   = NOW + timedelta(seconds=5)


def run(coro):
    """Shorthand for running async code in sync tests."""
    return asyncio.get_event_loop().run_until_complete(coro)


# ─── Unit Tests: PriceTable ───────────────────────────────────────────────────

class TestPriceTable:
    def test_compute_cost_known_model(self):
        pt = PriceTable(BUILT_IN_PRICES)
        # gpt-4o: $2.50/1M input + $10.00/1M output
        # 1000 input + 200 output = $0.0025 + $0.002 = $0.0045
        cost = pt.compute_cost("gpt-4o", 1000, 200)
        assert abs(cost - 0.0045) < 1e-8

    def test_compute_cost_unknown_model_returns_zero(self):
        pt = PriceTable(BUILT_IN_PRICES)
        assert pt.compute_cost("gpt-99", 1000, 200) == 0.0

    def test_update_prices_refreshes_timestamp(self):
        pt = PriceTable(BUILT_IN_PRICES)
        before = pt.last_refreshed
        run(asyncio.sleep(0.01))  # ensure time advances
        pt.update_prices([BUILT_IN_PRICES[0]])
        assert pt.last_refreshed > before

    def test_has_model(self):
        pt = PriceTable(BUILT_IN_PRICES)
        assert pt.has_model("gpt-4o")
        assert not pt.has_model("gpt-5-ultra")

    def test_age_seconds_increases_over_time(self):
        pt = PriceTable(BUILT_IN_PRICES)
        age1 = pt.age_seconds()
        run(asyncio.sleep(0.05))
        age2 = pt.age_seconds()
        assert age2 > age1


# ─── Unit Tests: CostDashboard.record ────────────────────────────────────────

class TestRecord:
    def test_records_event_and_computes_cost(self):
        d = CostDashboard()
        event = run(d.record(
            timestamp=NOW,
            request_id="r1",
            feature="chat",
            model="gpt-4o",
            prompt_version="v1",
            input_tokens=1000,
            output_tokens=200,
            latency_ms=200,
        ))
        # $2.50/1M × 1000 + $10.00/1M × 200 = $0.0025 + $0.002 = $0.0045
        assert abs(event.cost_usd - 0.0045) < 1e-8
        assert len(d.store) == 1

    def test_records_optional_fields(self):
        d = CostDashboard()
        event = run(d.record(
            timestamp=NOW, request_id="r1", feature="chat", model="gpt-4o",
            prompt_version="v1", input_tokens=500, output_tokens=150,
            latency_ms=200, user_id="user-123", team_id="team-a",
            tags={"environment": "production"},
        ))
        assert event.user_id == "user-123"
        assert event.team_id == "team-a"


# ─── Unit Tests: CostDashboard.query ─────────────────────────────────────────

class TestQuery:
    def _dashboard_with_events(self) -> CostDashboard:
        d = CostDashboard()
        for model, feature in [("gpt-4o", "chat"), ("gpt-4o", "chat"), ("gpt-4o-mini", "analysis")]:
            run(d.store.record(make_event(
                request_id=f"req-{model}-{feature}",
                model=model, feature=feature,
                cost_usd=d.compute_cost(model, 500, 150),
            )))
        return d

    def test_groups_by_feature(self):
        d = self._dashboard_with_events()
        results = d.query(QueryParams(group_by=GroupByDimension.FEATURE, start_time=START, end_time=END))
        assert len(results) == 2
        chat = next(r for r in results if r.dimension_value == "chat")
        assert chat.total_requests == 2

    def test_groups_by_model(self):
        d = self._dashboard_with_events()
        results = d.query(QueryParams(group_by=GroupByDimension.MODEL, start_time=START, end_time=END))
        assert len(results) == 2

    def test_sorted_by_cost_descending(self):
        d = self._dashboard_with_events()
        results = d.query(QueryParams(group_by=GroupByDimension.FEATURE, start_time=START, end_time=END))
        assert results[0].total_cost_usd >= results[1].total_cost_usd

    def test_applies_feature_filter(self):
        d = self._dashboard_with_events()
        results = d.query(QueryParams(
            group_by=GroupByDimension.FEATURE, start_time=START, end_time=END,
            filters=QueryFilters(feature="chat"),
        ))
        assert len(results) == 1
        assert results[0].dimension_value == "chat"

    def test_returns_empty_outside_window(self):
        d = self._dashboard_with_events()
        past_start = datetime(2000, 1, 1, tzinfo=timezone.utc)
        past_end   = datetime(2000, 1, 2, tzinfo=timezone.utc)
        results = d.query(QueryParams(group_by=GroupByDimension.FEATURE, start_time=past_start, end_time=past_end))
        assert results == []

    def test_min_cost_usd_filter(self):
        d = self._dashboard_with_events()
        # gpt-4o-mini analysis costs ~$0.000165 — filter it out
        results = d.query(QueryParams(
            group_by=GroupByDimension.FEATURE, start_time=START, end_time=END,
            min_cost_usd=0.001,
        ))
        for r in results:
            assert r.total_cost_usd >= 0.001


# ─── Unit Tests: compute_cost ────────────────────────────────────────────────

class TestComputeCost:
    def test_no_recording(self):
        d = CostDashboard()
        # gpt-4o-mini: $0.15/1M input + $0.60/1M output
        # 10K input + 1K output = $0.0015 + $0.0006 = $0.0021
        cost = d.compute_cost("gpt-4o-mini", 10_000, 1_000)
        assert abs(cost - 0.0021) < 1e-8
        assert len(d.store) == 0  # no side effect


# ─── Failure Mode Tests ───────────────────────────────────────────────────────

class TestFailureModes:
    def test_missing_feature_tag_sets_unknown(self):
        d = CostDashboard(CostDashboardConfig(required_tags=["feature"]))
        event = run(d.record(
            timestamp=NOW, request_id="r1", feature="",
            model="gpt-4o", prompt_version="v1",
            input_tokens=500, output_tokens=150, latency_ms=200,
        ))
        assert event.feature == "unknown"

    def test_missing_tag_increments_counter(self):
        d = CostDashboard(CostDashboardConfig(required_tags=["feature"]))
        run(d.record(timestamp=NOW, request_id="r1", feature="", model="gpt-4o", prompt_version="v1", input_tokens=500, output_tokens=150, latency_ms=200))
        run(d.record(timestamp=NOW, request_id="r2", feature="", model="gpt-4o", prompt_version="v1", input_tokens=500, output_tokens=150, latency_ms=200))
        assert d.missing_tag_counts.get("feature") == 2

    def test_missing_tags_alert_fires_above_10_pct(self):
        store = InMemorySpendStore()
        d = CostDashboard(store=store)
        # 9 proper events + 2 unknown = 18% missing
        for i in range(9):
            run(store.record(make_event(request_id=f"p{i}")))
        for i in range(2):
            run(store.record(make_event(request_id=f"u{i}", feature="unknown")))
        alerts = d.check_alerts()
        missing = [a for a in alerts if a.type.value == "missingTags"]
        assert len(missing) == 1
        assert missing[0].severity.value == "warning"

    def test_stale_price_table_warning(self):
        store = InMemorySpendStore()
        run(store.record(make_event()))
        engine = AlertEngine(AlertConfig())
        # 3 hours stale → warning
        alerts = engine.evaluate(store, 3 * 3600)
        stale = [a for a in alerts if a.type.value == "priceTableStale"]
        assert stale
        assert stale[0].severity.value == "warning"

    def test_stale_price_table_critical(self):
        store = InMemorySpendStore()
        run(store.record(make_event()))
        engine = AlertEngine(AlertConfig())
        # 7 hours stale → critical
        alerts = engine.evaluate(store, 7 * 3600)
        stale = [a for a in alerts if a.type.value == "priceTableStale"]
        assert stale[0].severity.value == "critical"

    def test_spike_alert_fires(self):
        store = InMemorySpendStore()
        now = datetime.now(timezone.utc)

        # Build 168h baseline: 1 event/hr at $0.001
        for i in range(168):
            ts = now - timedelta(hours=168 - i)
            run(store.record(make_event(request_id=f"b{i}", timestamp=ts, cost_usd=0.001)))

        # Current window (last 1h): 10 events at $0.001 = $0.01
        # Normalized baseline = $0.001/hr → spike ratio = 10×
        for i in range(10):
            ts = now - timedelta(seconds=i * 10)
            run(store.record(make_event(request_id=f"s{i}", timestamp=ts, cost_usd=0.001)))

        engine = AlertEngine(AlertConfig())
        alerts = engine.evaluate(store, 0)
        spike = [a for a in alerts if a.type.value == "spike"]
        assert spike, "Expected spike alert to fire"

    def test_concentration_risk_alert(self):
        store = InMemorySpendStore()
        now = datetime.now(timezone.utc)
        # One dominant feature at 80% of spend
        run(store.record(make_event(request_id="d1", feature="dominant", cost_usd=0.08, timestamp=now)))
        run(store.record(make_event(request_id="o1", feature="other1",   cost_usd=0.01, timestamp=now)))
        run(store.record(make_event(request_id="o2", feature="other2",   cost_usd=0.01, timestamp=now)))
        engine = AlertEngine(AlertConfig())
        alerts = engine.evaluate(store, 0)
        conc = [a for a in alerts if a.type.value == "concentrationRisk"]
        assert conc
        assert conc[0].context["feature"] == "dominant"

    def test_unknown_model_records_zero_cost(self):
        d = CostDashboard()
        event = run(d.record(
            timestamp=NOW, request_id="r1", feature="chat",
            model="gpt-99-turbo-ultra", prompt_version="v1",
            input_tokens=500, output_tokens=150, latency_ms=200,
        ))
        assert event.cost_usd == 0.0

    def test_test_traffic_tagging(self):
        """Verify environment tag allows filtering test vs. production events."""
        d = CostDashboard()
        run(d.record(timestamp=NOW, request_id="prod", feature="chat", model="gpt-4o",
                     prompt_version="v1", input_tokens=500, output_tokens=150, latency_ms=200,
                     tags={"environment": "production"}))
        run(d.record(timestamp=NOW, request_id="test", feature="chat", model="gpt-4o",
                     prompt_version="v1", input_tokens=500, output_tokens=150, latency_ms=200,
                     tags={"environment": "test"}))
        all_events = d.store.get_events(START, END)
        prod = [e for e in all_events if e.tags.get("environment") == "production"]
        test = [e for e in all_events if e.tags.get("environment") == "test"]
        assert len(prod) == 1
        assert len(test) == 1


# ─── Integration Tests ────────────────────────────────────────────────────────

class TestIntegration:
    def test_track_cost_records_after_success(self):
        provider = MockProvider(base_latency_ms=0, jitter_ms=0, output_tokens=100)
        d = CostDashboard()

        async def _run():
            return await track_cost(
                d,
                provider.complete("Hello", "gpt-4o"),
                feature="chat",
                model="gpt-4o",
                prompt_version="v1.0",
            )

        result = run(_run())
        assert result.output_tokens == 100
        assert len(d.store) == 1
        events = d.store.get_events(START, END)
        assert events[0].feature == "chat"
        assert events[0].cost_usd > 0

    def test_multiple_features_aggregate_correctly(self):
        provider = MockProvider(base_latency_ms=0, jitter_ms=0, input_tokens=500, output_tokens=150)
        d = CostDashboard()

        async def _run():
            for _ in range(3):
                await track_cost(d, provider.complete("prompt", "gpt-4o"),
                                 feature="chat", model="gpt-4o", prompt_version="v1")
            await track_cost(d, provider.complete("prompt", "gpt-4o-mini"),
                             feature="analysis", model="gpt-4o-mini", prompt_version="v1")

        run(_run())
        results = d.query(QueryParams(group_by=GroupByDimension.FEATURE, start_time=START, end_time=END))
        assert len(results) == 2
        chat = next(r for r in results if r.dimension_value == "chat")
        assert chat.total_requests == 3

    def test_concurrent_writes_consistent(self):
        provider = MockProvider(base_latency_ms=0, jitter_ms=0, input_tokens=100, output_tokens=50)
        d = CostDashboard()

        async def _run():
            await asyncio.gather(*(
                track_cost(d, provider.complete(f"p{i}", "gpt-4o"),
                           feature="load-test", model="gpt-4o", prompt_version="v1")
                for i in range(20)
            ))

        run(_run())
        assert len(d.store) == 20
        results = d.query(QueryParams(group_by=GroupByDimension.FEATURE, start_time=START, end_time=END))
        assert results[0].total_requests == 20

    def test_no_alerts_when_healthy(self):
        d = CostDashboard()
        run(d.record(
            timestamp=NOW, request_id="r1", feature="chat", model="gpt-4o",
            prompt_version="v1", input_tokens=500, output_tokens=150, latency_ms=200,
        ))
        alerts = d.check_alerts()
        stale = [a for a in alerts if a.type.value == "priceTableStale"]
        assert len(stale) == 0

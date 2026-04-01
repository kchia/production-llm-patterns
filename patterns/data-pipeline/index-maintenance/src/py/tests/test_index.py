"""Tests for the Index Maintenance pattern."""

import pytest

from ..mock_provider import MockCollectionConfig, MockVectorStoreAdapter
from .. import IndexMaintenanceScheduler
from ..types import DEFAULT_CONFIG, MaintenanceConfig, VacuumOp, CompactSegmentsOp, OptimizePayloadIndexOp

from .conftest import COLLECTION, make_scheduler

pytestmark = pytest.mark.asyncio

# ─── Unit tests ───────────────────────────────────────────────────────────────

class TestIndexHealthMetricsCalculation:
    async def test_computes_tombstone_ratio(self):
        adapter = MockVectorStoreAdapter()
        adapter.configure(
            COLLECTION,
            MockCollectionConfig(total_vectors=100_000, deleted_vectors=20_000),
        )
        scheduler = make_scheduler(adapter)
        metrics = await scheduler.check_health(COLLECTION)
        assert abs(metrics.tombstone_ratio - 0.20) < 1e-6

    async def test_tombstone_ratio_zero_for_empty_collection(self):
        adapter = MockVectorStoreAdapter()
        adapter.configure(
            COLLECTION,
            MockCollectionConfig(total_vectors=0, deleted_vectors=0),
        )
        scheduler = make_scheduler(adapter)
        metrics = await scheduler.check_health(COLLECTION)
        assert metrics.tombstone_ratio == 0.0

    async def test_computes_payload_index_coverage(self):
        adapter = MockVectorStoreAdapter()
        adapter.configure(
            COLLECTION,
            MockCollectionConfig(
                total_vectors=50_000,
                deleted_vectors=0,
                query_filter_fields=["category", "date", "author"],
                indexed_fields=["category", "date"],  # "author" not indexed
            ),
        )
        scheduler = make_scheduler(adapter)
        metrics = await scheduler.check_health(COLLECTION)
        assert abs(metrics.payload_index_coverage - 2 / 3) < 1e-6

    async def test_full_coverage_when_no_query_fields(self):
        adapter = MockVectorStoreAdapter()
        adapter.configure(
            COLLECTION,
            MockCollectionConfig(
                query_filter_fields=[],
                indexed_fields=[],
            ),
        )
        scheduler = make_scheduler(adapter)
        metrics = await scheduler.check_health(COLLECTION)
        assert metrics.payload_index_coverage == 1.0


class TestMaintenancePlanner:
    async def test_plans_vacuum_when_tombstone_ratio_high(self):
        adapter = MockVectorStoreAdapter()
        adapter.configure(
            COLLECTION,
            MockCollectionConfig(total_vectors=100_000, deleted_vectors=20_000),
        )
        scheduler = make_scheduler(adapter)
        metrics = await scheduler.check_health(COLLECTION)
        ops = scheduler.plan_maintenance(metrics)
        assert any(isinstance(o, VacuumOp) for o in ops)

    async def test_no_vacuum_when_tombstone_ratio_low(self):
        adapter = MockVectorStoreAdapter()
        adapter.configure(
            COLLECTION,
            MockCollectionConfig(total_vectors=100_000, deleted_vectors=5_000),
        )
        scheduler = make_scheduler(adapter)
        metrics = await scheduler.check_health(COLLECTION)
        ops = scheduler.plan_maintenance(metrics)
        assert not any(isinstance(o, VacuumOp) for o in ops)

    async def test_plans_compact_when_segment_count_high(self):
        adapter = MockVectorStoreAdapter()
        adapter.configure(
            COLLECTION,
            MockCollectionConfig(
                total_vectors=100_000,
                deleted_vectors=0,
                segment_count=30,
            ),
        )
        scheduler = make_scheduler(adapter)
        metrics = await scheduler.check_health(COLLECTION)
        ops = scheduler.plan_maintenance(metrics)
        assert any(isinstance(o, CompactSegmentsOp) for o in ops)

    async def test_plans_payload_optimize_when_coverage_low(self):
        adapter = MockVectorStoreAdapter()
        adapter.configure(
            COLLECTION,
            MockCollectionConfig(
                total_vectors=50_000,
                deleted_vectors=0,
                query_filter_fields=["category", "date", "region"],
                indexed_fields=["category"],
            ),
        )
        scheduler = make_scheduler(adapter)
        metrics = await scheduler.check_health(COLLECTION)
        ops = scheduler.plan_maintenance(metrics)
        assert any(isinstance(o, OptimizePayloadIndexOp) for o in ops)

    async def test_returns_empty_for_healthy_index(self):
        adapter = MockVectorStoreAdapter()
        adapter.configure(
            COLLECTION,
            MockCollectionConfig(
                total_vectors=100_000,
                deleted_vectors=1_000,
                segment_count=5,
                query_filter_fields=["category"],
                indexed_fields=["category"],
            ),
        )
        scheduler = make_scheduler(adapter)
        metrics = await scheduler.check_health(COLLECTION)
        ops = scheduler.plan_maintenance(metrics)
        assert ops == []


# ─── Failure mode tests ───────────────────────────────────────────────────────

class TestTombstoneAccumulation:
    async def test_detects_and_vacuums(self):
        adapter = MockVectorStoreAdapter()
        adapter.configure(
            COLLECTION,
            MockCollectionConfig(
                total_vectors=100_000,
                deleted_vectors=20_000,
                segment_count=5,
                query_filter_fields=[],
                indexed_fields=[],
            ),
        )
        scheduler = make_scheduler(adapter)
        result = await scheduler.run_maintenance(COLLECTION)

        assert result.success
        assert any(isinstance(o, VacuumOp) for o in result.operations_executed)
        assert result.metrics_after_run.tombstone_ratio == 0.0


class TestSegmentExplosion:
    async def test_detects_and_compacts(self):
        adapter = MockVectorStoreAdapter()
        adapter.configure(
            COLLECTION,
            MockCollectionConfig(
                total_vectors=200_000,
                deleted_vectors=0,
                segment_count=45,
            ),
        )
        scheduler = make_scheduler(adapter)
        result = await scheduler.run_maintenance(COLLECTION)

        assert result.success
        assert any(isinstance(o, CompactSegmentsOp) for o in result.operations_executed)
        assert result.metrics_after_run.segment_count < 45


class TestPayloadIndexDrift:
    async def test_detects_unindexed_fields_and_optimizes(self):
        adapter = MockVectorStoreAdapter()
        adapter.configure(
            COLLECTION,
            MockCollectionConfig(
                total_vectors=50_000,
                deleted_vectors=0,
                segment_count=5,
                query_filter_fields=["category", "date", "region"],
                indexed_fields=["category"],
            ),
        )
        scheduler = make_scheduler(adapter)
        result = await scheduler.run_maintenance(COLLECTION)

        assert result.success
        assert any(
            isinstance(o, OptimizePayloadIndexOp) for o in result.operations_executed
        )
        assert result.metrics_after_run.payload_index_coverage == pytest.approx(1.0)


class TestVacuumLoopPrevention:
    async def test_skips_during_cooldown(self):
        adapter = MockVectorStoreAdapter()
        adapter.configure(
            COLLECTION,
            MockCollectionConfig(
                total_vectors=100_000,
                deleted_vectors=20_000,
                simulate_cleanup_effect=False,
            ),
        )
        scheduler = make_scheduler(adapter, maintenance_cooldown_ms=60_000)

        # First run should execute
        result1 = await scheduler.run_maintenance(COLLECTION)
        assert len(result1.operations_executed) > 0

        # Second run immediately after — cooldown still active
        result2 = await scheduler.run_maintenance(COLLECTION)
        assert len(result2.operations_executed) == 0
        assert result2.error is not None and "cooldown" in result2.error


class TestSilentRecallDegradationDetection:
    async def test_detects_degraded_state_via_metric(self):
        adapter = MockVectorStoreAdapter()
        adapter.configure(
            COLLECTION,
            MockCollectionConfig(
                total_vectors=100_000,
                deleted_vectors=18_000,  # 0.18 — above 0.15 threshold
            ),
        )
        scheduler = make_scheduler(adapter, tombstone_threshold=0.15)
        metrics = await scheduler.check_health(COLLECTION)
        assert metrics.tombstone_ratio >= 0.15
        ops = scheduler.plan_maintenance(metrics)
        assert any(isinstance(o, VacuumOp) for o in ops)


class TestTrafficGate:
    async def test_defers_when_traffic_too_high(self):
        adapter = MockVectorStoreAdapter()
        adapter.configure(
            COLLECTION,
            MockCollectionConfig(total_vectors=100_000, deleted_vectors=20_000),
        )
        scheduler = make_scheduler(adapter, max_traffic_rate_for_maintenance=50)
        scheduler.set_traffic_rate(200)

        result = await scheduler.run_maintenance(COLLECTION)
        assert len(result.operations_executed) == 0
        assert result.error is not None and "traffic rate" in result.error
        assert len(adapter.operation_log) == 0


# ─── Integration tests ────────────────────────────────────────────────────────

class TestFullMaintenanceCycle:
    async def test_executes_vacuum_then_compact_in_order(self):
        adapter = MockVectorStoreAdapter()
        adapter.configure(
            COLLECTION,
            MockCollectionConfig(
                total_vectors=100_000,
                deleted_vectors=20_000,
                segment_count=35,
                query_filter_fields=["category"],
                indexed_fields=["category"],
            ),
        )
        scheduler = make_scheduler(adapter)
        result = await scheduler.run_maintenance(COLLECTION)

        assert result.success
        op_types = [o.type for o in result.operations_executed]
        assert op_types[0] == "vacuum"
        assert op_types[1] == "compact_segments"
        assert result.metrics_after_run.tombstone_ratio == 0.0
        assert result.metrics_after_run.segment_count < 35

    async def test_emits_before_and_after_metrics(self):
        adapter = MockVectorStoreAdapter()
        adapter.configure(
            COLLECTION,
            MockCollectionConfig(
                total_vectors=100_000,
                deleted_vectors=20_000,
                segment_count=30,
            ),
        )
        scheduler = make_scheduler(adapter)
        result = await scheduler.run_maintenance(COLLECTION)

        assert result.metrics_before_run.tombstone_ratio > 0
        assert result.metrics_after_run.tombstone_ratio == 0.0
        assert result.duration_ms >= 0

    async def test_handles_operation_failure_gracefully(self):
        adapter = MockVectorStoreAdapter()
        adapter.configure(
            COLLECTION,
            MockCollectionConfig(
                total_vectors=100_000,
                deleted_vectors=20_000,
                operation_error=RuntimeError("vacuum timed out"),
            ),
        )
        scheduler = make_scheduler(adapter)
        result = await scheduler.run_maintenance(COLLECTION)

        assert not result.success
        assert result.error is not None and "vacuum timed out" in result.error

    async def test_skips_when_index_healthy(self):
        adapter = MockVectorStoreAdapter()
        adapter.configure(
            COLLECTION,
            MockCollectionConfig(
                total_vectors=100_000,
                deleted_vectors=1_000,
                segment_count=3,
                query_filter_fields=["category"],
                indexed_fields=["category"],
            ),
        )
        scheduler = make_scheduler(adapter)
        result = await scheduler.run_maintenance(COLLECTION)

        assert result.success
        assert len(result.operations_executed) == 0
        assert len(adapter.operation_log) == 0

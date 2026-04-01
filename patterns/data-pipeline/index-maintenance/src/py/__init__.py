"""Index Maintenance pattern — Python implementation."""

from __future__ import annotations

import time
from typing import Optional

from .types import (
    CollectionStats,
    CompactSegmentsOp,
    DEFAULT_CONFIG,
    IndexHealthMetrics,
    MaintenanceConfig,
    MaintenanceOperation,
    MaintenanceResult,
    OptimizePayloadIndexOp,
    RebuildOp,
    VacuumOp,
)


class IndexMaintenanceScheduler:
    """
    Coordinates vector index health checking, maintenance planning, and
    operation execution for a vector store collection.

    Caller responsibilities:
    - Call ``set_traffic_rate()`` from a metrics collector to keep the
      traffic gate current.
    - Call ``run_maintenance()`` on a schedule (or after bulk ingest).
    """

    def __init__(
        self,
        adapter: object,
        config: MaintenanceConfig = DEFAULT_CONFIG,
    ) -> None:
        self._adapter = adapter
        self._config = config
        self._last_run_at: dict[str, float] = {}  # collection → unix ms
        self._current_traffic_rate: float = 0.0

    def set_traffic_rate(self, req_per_second: float) -> None:
        """Update the current traffic rate for the traffic gate."""
        self._current_traffic_rate = req_per_second

    # ─── Step 1: Health Check ─────────────────────────────────────────────

    async def check_health(self, collection_name: str) -> IndexHealthMetrics:
        stats: CollectionStats = await self._adapter.get_collection_stats(
            collection_name
        )
        query_fields: list[str] = await self._adapter.get_query_filter_fields(
            collection_name
        )
        indexed_fields: list[str] = await self._adapter.get_indexed_fields(
            collection_name
        )

        tombstone_ratio = (
            stats.deleted_vectors / stats.total_vectors
            if stats.total_vectors > 0
            else 0.0
        )

        # Zero query fields means full coverage — nothing to index.
        if query_fields:
            indexed_count = sum(1 for f in query_fields if f in indexed_fields)
            payload_index_coverage = indexed_count / len(query_fields)
        else:
            payload_index_coverage = 1.0

        avg_segment_size = (
            (stats.total_vectors - stats.deleted_vectors) / stats.segment_count
            if stats.segment_count > 0
            else 0.0
        )

        now_ms = time.time() * 1000
        last_run = self._last_run_at.get(collection_name)
        if last_run is not None:
            last_maintenance_ms = now_ms - last_run
        elif stats.last_maintenance_timestamp is not None:
            last_maintenance_ms = now_ms - stats.last_maintenance_timestamp
        else:
            last_maintenance_ms = float("inf")

        return IndexHealthMetrics(
            collection_name=collection_name,
            total_vectors=stats.total_vectors,
            deleted_vectors=stats.deleted_vectors,
            tombstone_ratio=tombstone_ratio,
            segment_count=stats.segment_count,
            avg_segment_size=avg_segment_size,
            payload_index_coverage=payload_index_coverage,
            last_maintenance_ms=last_maintenance_ms,
        )

    # ─── Step 2: Threshold Evaluation + Planning ──────────────────────────

    def plan_maintenance(
        self, metrics: IndexHealthMetrics
    ) -> list[MaintenanceOperation]:
        """
        Returns an ordered list of operations to run.
        Order: vacuum → compact → rebuild, so each op reduces scope of the next.
        """
        ops: list[MaintenanceOperation] = []

        if metrics.tombstone_ratio >= self._config.tombstone_threshold:
            ops.append(
                VacuumOp(
                    reason=(
                        f"tombstone_ratio {metrics.tombstone_ratio:.3f} >= "
                        f"threshold {self._config.tombstone_threshold}"
                    )
                )
            )

        if metrics.segment_count >= self._config.max_segments:
            ops.append(
                CompactSegmentsOp(
                    reason=(
                        f"segment_count {metrics.segment_count} >= "
                        f"max {self._config.max_segments}"
                    )
                )
            )

        if metrics.payload_index_coverage < self._config.min_payload_index_coverage:
            ops.append(
                OptimizePayloadIndexOp(
                    fields=[],  # executor resolves actual fields
                    reason=(
                        f"payload_index_coverage {metrics.payload_index_coverage:.2f} < "
                        f"min {self._config.min_payload_index_coverage}"
                    ),
                )
            )

        return ops

    # ─── Step 4: Execution ────────────────────────────────────────────────

    async def run_maintenance(self, collection_name: str) -> MaintenanceResult:
        """
        Full maintenance cycle: check health, decide, execute.
        Safe to call on a schedule — respects cooldown and traffic gate.
        """
        start_ms = time.time() * 1000

        # Traffic gate: defer if current load is too high.
        if self._current_traffic_rate > self._config.max_traffic_rate_for_maintenance:
            metrics = await self.check_health(collection_name)
            return MaintenanceResult(
                collection_name=collection_name,
                operations_executed=[],
                duration_ms=time.time() * 1000 - start_ms,
                metrics_before_run=metrics,
                metrics_after_run=metrics,
                success=True,
                error=(
                    f"deferred: traffic rate {self._current_traffic_rate} req/s "
                    f"exceeds gate threshold"
                ),
            )

        # Cooldown check: prevents vacuum loops under sustained churn.
        last_run = self._last_run_at.get(collection_name, 0.0)
        time_since_last = time.time() * 1000 - last_run
        if time_since_last < self._config.maintenance_cooldown_ms:
            metrics = await self.check_health(collection_name)
            elapsed_s = int(time_since_last / 1000)
            needed_s = int(self._config.maintenance_cooldown_ms / 1000)
            return MaintenanceResult(
                collection_name=collection_name,
                operations_executed=[],
                duration_ms=time.time() * 1000 - start_ms,
                metrics_before_run=metrics,
                metrics_after_run=metrics,
                success=True,
                error=f"skipped: cooldown active ({elapsed_s}s elapsed, need {needed_s}s)",
            )

        metrics_before = await self.check_health(collection_name)
        ops = self.plan_maintenance(metrics_before)

        if not ops:
            return MaintenanceResult(
                collection_name=collection_name,
                operations_executed=[],
                duration_ms=time.time() * 1000 - start_ms,
                metrics_before_run=metrics_before,
                metrics_after_run=metrics_before,
                success=True,
            )

        executed: list[MaintenanceOperation] = []

        for op in ops:
            # Hard duration limit — abandon remaining ops rather than block reads.
            if time.time() * 1000 - start_ms >= self._config.max_maintenance_duration_ms:
                break

            try:
                await self._execute_operation(collection_name, op)
                executed.append(op)
            except Exception as exc:
                metrics_after = await self.check_health(collection_name)
                return MaintenanceResult(
                    collection_name=collection_name,
                    operations_executed=executed,
                    duration_ms=time.time() * 1000 - start_ms,
                    metrics_before_run=metrics_before,
                    metrics_after_run=metrics_after,
                    success=False,
                    error=str(exc),
                )

        self._last_run_at[collection_name] = time.time() * 1000
        metrics_after = await self.check_health(collection_name)

        return MaintenanceResult(
            collection_name=collection_name,
            operations_executed=executed,
            duration_ms=time.time() * 1000 - start_ms,
            metrics_before_run=metrics_before,
            metrics_after_run=metrics_after,
            success=True,
        )

    async def _execute_operation(
        self, collection_name: str, op: MaintenanceOperation
    ) -> None:
        if isinstance(op, VacuumOp):
            await self._adapter.run_vacuum(collection_name)
        elif isinstance(op, CompactSegmentsOp):
            await self._adapter.compact_segments(collection_name)
        elif isinstance(op, OptimizePayloadIndexOp):
            # Resolve unindexed fields at execution time.
            query_fields = await self._adapter.get_query_filter_fields(collection_name)
            indexed_fields = await self._adapter.get_indexed_fields(collection_name)
            missing = [f for f in query_fields if f not in indexed_fields]
            if missing:
                await self._adapter.optimize_payload_index(collection_name, missing)
        elif isinstance(op, RebuildOp):
            await self._adapter.rebuild_index(collection_name)

    def get_last_run_at(self, collection_name: str) -> Optional[float]:
        return self._last_run_at.get(collection_name)


__all__ = [
    "IndexMaintenanceScheduler",
    "IndexHealthMetrics",
    "MaintenanceConfig",
    "MaintenanceOperation",
    "MaintenanceResult",
    "DEFAULT_CONFIG",
    "VacuumOp",
    "CompactSegmentsOp",
    "OptimizePayloadIndexOp",
    "RebuildOp",
]

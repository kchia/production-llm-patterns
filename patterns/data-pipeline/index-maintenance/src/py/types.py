"""Type definitions for the Index Maintenance pattern."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal, Optional, Union


@dataclass
class IndexHealthMetrics:
    """Health snapshot of a vector collection's index."""

    collection_name: str
    total_vectors: int
    deleted_vectors: int
    # deleted_vectors / total_vectors — primary trigger for vacuum
    tombstone_ratio: float
    # Number of active segments — proxy for fragmentation
    segment_count: int
    # Average vectors per segment
    avg_segment_size: float
    # Fraction of filter fields that have payload indexes (0–1)
    payload_index_coverage: float
    # Milliseconds since last successful maintenance run
    last_maintenance_ms: float
    collected_at: datetime = field(default_factory=datetime.now)


# Tagged union for the four maintenance operation types.
# Using dataclasses over TypedDicts keeps the Union arms readable and
# allows isinstance() checks in the executor.

@dataclass
class VacuumOp:
    type: Literal["vacuum"] = field(default="vacuum", init=False)
    reason: str = ""


@dataclass
class CompactSegmentsOp:
    type: Literal["compact_segments"] = field(default="compact_segments", init=False)
    reason: str = ""


@dataclass
class OptimizePayloadIndexOp:
    type: Literal["optimize_payload_index"] = field(
        default="optimize_payload_index", init=False
    )
    fields: list[str] = field(default_factory=list)
    reason: str = ""


@dataclass
class RebuildOp:
    type: Literal["rebuild"] = field(default="rebuild", init=False)
    reason: str = ""


MaintenanceOperation = Union[VacuumOp, CompactSegmentsOp, OptimizePayloadIndexOp, RebuildOp]


@dataclass
class MaintenanceResult:
    """Result of a single maintenance run."""

    collection_name: str
    operations_executed: list[MaintenanceOperation]
    duration_ms: float
    metrics_before_run: IndexHealthMetrics
    metrics_after_run: IndexHealthMetrics
    success: bool
    error: Optional[str] = None


@dataclass
class MaintenanceConfig:
    """Configuration for the maintenance scheduler."""

    # Tombstone ratio that triggers vacuum (0–1).
    # Default 0.15 — tune based on churn rate and recall SLA.
    tombstone_threshold: float = 0.15
    # Maximum segment count before compaction is triggered.
    max_segments: int = 20
    # Minimum payload index coverage (0–1) before optimize_payload_index runs.
    min_payload_index_coverage: float = 0.80
    # Minimum ms between maintenance runs — prevents vacuum loops.
    maintenance_cooldown_ms: float = 3_600_000  # 1 hour
    # Hard limit on maintenance run duration.
    max_maintenance_duration_ms: float = 300_000  # 5 minutes
    # Maintenance is deferred when traffic rate exceeds this threshold.
    max_traffic_rate_for_maintenance: float = 100.0  # req/s


DEFAULT_CONFIG = MaintenanceConfig()


@dataclass
class CollectionStats:
    """Raw stats returned by the vector store API."""

    total_vectors: int
    deleted_vectors: int
    segment_count: int
    last_maintenance_timestamp: Optional[float] = None  # Unix ms

"""Mock vector store adapter for testing and benchmarks."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Optional

from .types import CollectionStats


@dataclass
class MockCollectionConfig:
    total_vectors: int = 100_000
    deleted_vectors: int = 5_000
    segment_count: int = 8
    last_maintenance_timestamp: Optional[float] = None
    query_filter_fields: list[str] = field(default_factory=lambda: ["category", "date"])
    indexed_fields: list[str] = field(default_factory=lambda: ["category", "date"])
    # If set, operations will raise this exception
    operation_error: Optional[Exception] = None
    # Artificial delay per operation in seconds
    operation_delay_s: float = 0.0
    # When True, stats after vacuum/compact reflect a cleaned state
    simulate_cleanup_effect: bool = True


class MockVectorStoreAdapter:
    """
    Mock adapter that satisfies the vector store protocol used by
    IndexMaintenanceScheduler. Supports configurable stats, error injection,
    and latency simulation.
    """

    def __init__(self) -> None:
        self._collections: dict[str, MockCollectionConfig] = {}
        # Tracks which operations were called, for test assertions.
        self.operation_log: list[dict[str, str | float]] = []

    def configure(self, collection_name: str, config: MockCollectionConfig) -> None:
        self._collections[collection_name] = config

    def _cfg(self, collection_name: str) -> MockCollectionConfig:
        cfg = self._collections.get(collection_name)
        if cfg is None:
            raise KeyError(f"Collection not configured: {collection_name}")
        return cfg

    async def _delay(self, collection_name: str) -> None:
        cfg = self._cfg(collection_name)
        if cfg.operation_delay_s > 0:
            await asyncio.sleep(cfg.operation_delay_s)

    def _maybe_raise(self, collection_name: str) -> None:
        cfg = self._cfg(collection_name)
        if cfg.operation_error is not None:
            raise cfg.operation_error

    def _log(self, op: str, collection: str) -> None:
        import time
        self.operation_log.append({"op": op, "collection": collection, "ts": time.time()})

    async def get_collection_stats(self, collection_name: str) -> CollectionStats:
        await self._delay(collection_name)
        self._maybe_raise(collection_name)
        cfg = self._cfg(collection_name)
        return CollectionStats(
            total_vectors=cfg.total_vectors,
            deleted_vectors=cfg.deleted_vectors,
            segment_count=cfg.segment_count,
            last_maintenance_timestamp=cfg.last_maintenance_timestamp,
        )

    async def run_vacuum(self, collection_name: str) -> None:
        await self._delay(collection_name)
        self._maybe_raise(collection_name)
        self._log("vacuum", collection_name)

        cfg = self._cfg(collection_name)
        if cfg.simulate_cleanup_effect:
            import time
            cfg.deleted_vectors = 0
            cfg.last_maintenance_timestamp = time.time() * 1000

    async def compact_segments(self, collection_name: str) -> None:
        await self._delay(collection_name)
        self._maybe_raise(collection_name)
        self._log("compact_segments", collection_name)

        cfg = self._cfg(collection_name)
        if cfg.simulate_cleanup_effect:
            cfg.segment_count = max(3, cfg.segment_count // 3)

    async def optimize_payload_index(
        self, collection_name: str, fields: list[str]
    ) -> None:
        await self._delay(collection_name)
        self._maybe_raise(collection_name)
        self._log("optimize_payload_index", collection_name)

        cfg = self._cfg(collection_name)
        if cfg.simulate_cleanup_effect:
            cfg.indexed_fields = list(set(cfg.indexed_fields + fields))

    async def rebuild_index(self, collection_name: str) -> None:
        await self._delay(collection_name)
        self._maybe_raise(collection_name)
        self._log("rebuild", collection_name)

        cfg = self._cfg(collection_name)
        if cfg.simulate_cleanup_effect:
            import time
            cfg.deleted_vectors = 0
            cfg.segment_count = 4
            cfg.last_maintenance_timestamp = time.time() * 1000

    async def get_query_filter_fields(self, collection_name: str) -> list[str]:
        cfg = self._cfg(collection_name)
        return list(cfg.query_filter_fields)

    async def get_indexed_fields(self, collection_name: str) -> list[str]:
        cfg = self._cfg(collection_name)
        return list(cfg.indexed_fields)

    def reset_log(self) -> None:
        self.operation_log = []

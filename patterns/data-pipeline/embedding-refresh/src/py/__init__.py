"""
Embedding Refresh pattern — idiomatic Python implementation.

Two distinct refresh strategies:

1. Incremental content refresh: detect changed documents via content hashing,
   re-embed only what has changed. Runs frequently (hourly/daily).

2. Model upgrade via shadow index: build a new index in the background while
   serving queries from the live index, then swap atomically when coverage
   reaches threshold. Never mix model versions in a live index.

The critical invariant: every stored embedding carries its model_version.
Without this metadata, model upgrades require a blind full re-embed.

Usage::

    import asyncio
    from src.py import EmbeddingRefresher, EmbeddingRefreshConfig
    from src.py.mock_provider import MockEmbeddingProvider, InMemoryVectorStore

    async def main():
        provider = MockEmbeddingProvider()
        store = InMemoryVectorStore()
        config = EmbeddingRefreshConfig(model_version="1", staleness_threshold_days=7)
        refresher = EmbeddingRefresher(provider, store, config)

        result = await refresher.refresh([
            {"id": "doc1", "content": "Hello world"},
            {"id": "doc2", "content": "Goodbye world"},
        ])
        print(f"Refreshed: {result.refreshed}, Skipped: {result.skipped}")

    asyncio.run(main())
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional

from .mock_provider import RateLimitError
from .types import (
    DocumentRecord,
    EmbeddingRefreshConfig,
    EmbeddingRequest,
    EmbeddingProvider,
    RefreshResult,
    StalenessReport,
    StaleDocInfo,
    VectorStore,
)

__all__ = [
    "EmbeddingRefresher",
    "EmbeddingRefreshConfig",
    "RefreshResult",
    "StalenessReport",
]

logger = logging.getLogger(__name__)

# Backoff parameters for rate limit retries
_MAX_RETRIES = 3
_BASE_BACKOFF_S = 0.5  # 500ms in seconds


class EmbeddingRefresher:
    """Manages embedding freshness for a vector store corpus.

    Handles two orthogonal concerns:
    - Document drift: content changes trigger selective re-embedding
    - Model migration: version mismatch triggers full corpus re-embedding via
      shadow index pattern (callers must implement the index swap; this class
      tracks coverage so callers can gate promotion)

    The class is stateless between refresh() calls — all state lives in the
    VectorStore. This makes it safe to restart a job that was killed mid-run.
    """

    def __init__(
        self,
        provider: EmbeddingProvider,
        store: VectorStore,
        config: Optional[EmbeddingRefreshConfig] = None,
    ) -> None:
        self._provider = provider
        self._store = store
        self._config = config or EmbeddingRefreshConfig()

    def compute_hash(
        self,
        content: str,
        metadata: Optional[dict[str, Any]] = None,
    ) -> str:
        """Compute a stable content fingerprint.

        Optionally includes metadata in the hash so that metadata-only changes
        (author, category, version tags) can also trigger a refresh.
        Keys are sorted before hashing for insertion-order independence.
        """
        algo = self._config.hash_algorithm
        h = hashlib.new(algo)
        h.update(content.encode())
        if metadata is not None:
            # Sort keys for deterministic serialisation regardless of dict ordering
            stable_metadata = json.dumps(dict(sorted(metadata.items())), sort_keys=True)
            h.update(stable_metadata.encode())
        return h.hexdigest()

    def is_stale(
        self,
        doc: DocumentRecord,
        current_content: str,
        current_metadata: Optional[dict[str, Any]] = None,
    ) -> tuple[bool, Optional[str]]:
        """Check whether a document needs refreshing.

        Returns (is_stale, reason) where reason is one of:
        - "model": stored model version != configured version (migration needed)
        - "content-changed": content hash doesn't match stored hash
        - "time": last_refreshed_at is past the staleness threshold
        - None: document is fresh

        Model version check has highest priority — a migration must complete
        atomically, never leaving mixed model versions in a live index.
        """
        # Model version check first — highest priority
        if doc.embedding_model_version != self._config.model_version:
            return True, "model"

        # Content hash check — catches document edits
        new_hash = self.compute_hash(current_content, current_metadata)
        if doc.content_hash != new_hash:
            return True, "content-changed"

        # Time-based staleness — catches silent context drift even when text unchanged
        threshold_s = self._config.staleness_threshold_days * 24 * 3600
        now = datetime.now(timezone.utc)
        last = doc.last_refreshed_at
        # Handle naive datetimes by treating them as UTC
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        age_s = (now - last).total_seconds()
        if age_s > threshold_s:
            return True, "time"

        return False, None

    async def refresh(
        self,
        incoming_documents: list[dict[str, Any]],
    ) -> RefreshResult:
        """Run an incremental refresh cycle.

        Args:
            incoming_documents: List of dicts with keys:
                - "id" (str, required)
                - "content" (str, required)
                - "metadata" (dict, optional)

        The algorithm:
        1. Fetch current state from the store for all incoming IDs
        2. Classify each document as new / stale / fresh
        3. Batch stale documents and re-embed with concurrency control
        4. Upsert new vectors with updated metadata

        Designed to be restartable: if killed mid-run, the next run picks up
        where it left off — only un-refreshed docs remain stale.
        """
        start_time = datetime.now(timezone.utc)
        refreshed = 0
        skipped = 0
        failed = 0
        staleness_by_model: dict[str, int] = {}

        # Fetch current state for all incoming doc IDs in parallel
        ids = [d["id"] for d in incoming_documents]
        existing_docs = await self._fetch_existing(ids)

        # Classify documents into fresh (skip) or stale (queue for re-embedding)
        to_refresh: list[DocumentRecord] = []

        for doc_dict in incoming_documents:
            doc_id = doc_dict["id"]
            content = doc_dict["content"]
            metadata = doc_dict.get("metadata")
            new_hash = self.compute_hash(content, metadata)

            existing = existing_docs.get(doc_id)

            if existing is None:
                # New document — needs initial embedding
                to_refresh.append(
                    DocumentRecord(
                        id=doc_id,
                        content=content,
                        content_hash=new_hash,
                        last_refreshed_at=datetime.fromtimestamp(0, tz=timezone.utc),
                        embedding_model_version="",  # set after embedding
                        metadata=metadata,
                    )
                )
            else:
                # Track model version distribution for staleness reporting
                mv = existing.embedding_model_version
                staleness_by_model[mv] = staleness_by_model.get(mv, 0) + 1

                is_stale, _ = self.is_stale(existing, content, metadata)
                if is_stale:
                    from dataclasses import replace
                    to_refresh.append(
                        replace(
                            existing,
                            content=content,
                            content_hash=new_hash,
                            metadata=metadata,
                        )
                    )
                else:
                    skipped += 1

        # Process batches with concurrency control
        batches = _chunk(to_refresh, self._config.batch_size)

        for window_start in range(0, len(batches), self._config.max_concurrent_batches):
            window = batches[window_start : window_start + self._config.max_concurrent_batches]
            tasks = [self._embed_and_store(batch) for batch in window]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            for result in results:
                if isinstance(result, Exception):
                    # Whole batch raised an unexpected exception — count all as failed
                    failed += self._config.batch_size
                else:
                    refreshed += result[0]
                    failed += result[1]

        # Record refreshed docs under current model version
        current_mv = self._config.model_version
        staleness_by_model[current_mv] = staleness_by_model.get(current_mv, 0) + refreshed

        duration_ms = (datetime.now(timezone.utc) - start_time).total_seconds() * 1000

        return RefreshResult(
            refreshed=refreshed,
            skipped=skipped,
            failed=failed,
            duration_ms=duration_ms,
            staleness_by_model=staleness_by_model,
        )

    async def get_staleness_report(self) -> StalenessReport:
        """Compute a staleness snapshot without triggering any refresh.

        Safe to call frequently from monitoring/alerting code.
        Returns a StalenessReport with current coverage and oldest embedding age.
        """
        all_docs = await self._store.list_all()
        total = len(all_docs)

        if total == 0:
            return StalenessReport(
                total_documents=0,
                stale_count=0,
                wrong_model_count=0,
                current_model_coverage=1.0,  # vacuously fresh
                oldest_refreshed_at=None,
                stale_docs=[],
            )

        threshold_s = self._config.staleness_threshold_days * 24 * 3600
        now = datetime.now(timezone.utc)

        stale_count = 0
        wrong_model_count = 0
        oldest: Optional[datetime] = None
        stale_docs: list[StaleDocInfo] = []

        for doc in all_docs:
            # Track oldest refreshed_at
            last = doc.last_refreshed_at
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
            if oldest is None or last < oldest:
                oldest = last

            wrong_model = doc.embedding_model_version != self._config.model_version
            age_s = (now - last).total_seconds()
            too_old = age_s > threshold_s

            if wrong_model:
                wrong_model_count += 1
                stale_count += 1
                stale_docs.append(
                    StaleDocInfo(
                        id=doc.id,
                        last_refreshed_at=doc.last_refreshed_at,
                        reason="model",
                    )
                )
            elif too_old:
                stale_count += 1
                stale_docs.append(
                    StaleDocInfo(
                        id=doc.id,
                        last_refreshed_at=doc.last_refreshed_at,
                        reason="time",
                    )
                )

        on_current = sum(
            1 for d in all_docs if d.embedding_model_version == self._config.model_version
        )

        return StalenessReport(
            total_documents=total,
            stale_count=stale_count,
            wrong_model_count=wrong_model_count,
            current_model_coverage=on_current / total,
            oldest_refreshed_at=oldest,
            stale_docs=stale_docs,
        )

    # ─── Private helpers ──────────────────────────────────────────────────────

    async def _fetch_existing(
        self, ids: list[str]
    ) -> dict[str, DocumentRecord]:
        """Fetch all documents by ID in parallel."""
        fetched = await asyncio.gather(*[self._store.get(doc_id) for doc_id in ids])
        return {
            doc_id: doc
            for doc_id, doc in zip(ids, fetched)
            if doc is not None
        }

    async def _embed_and_store(
        self, batch: list[DocumentRecord]
    ) -> tuple[int, int]:
        """Embed a batch and upsert results. Returns (refreshed, failed).

        Retries on RateLimitError with exponential backoff.
        Non-retryable errors (ApiError, TimeoutError) fail the batch immediately.
        """
        attempt = 0
        last_error: Optional[Exception] = None

        while attempt < _MAX_RETRIES:
            try:
                response = await self._provider.embed(
                    EmbeddingRequest(documents=batch),
                    self._config.model_version,
                )

                to_upsert: list[DocumentRecord] = []
                failed = 0

                for item in response.embeddings:
                    if item.error:
                        failed += 1
                        continue
                    # Find the original record to preserve its fields
                    original = next((d for d in batch if d.id == item.id), None)
                    if original is None:
                        continue

                    from dataclasses import replace
                    to_upsert.append(
                        replace(
                            original,
                            embedding=item.embedding,
                            embedding_model_version=self._config.model_version,
                            last_refreshed_at=datetime.now(timezone.utc),
                        )
                    )

                if to_upsert:
                    await self._store.upsert_batch(to_upsert)

                return len(to_upsert), failed

            except RateLimitError as exc:
                last_error = exc
                # Exponential backoff — double the base wait time each retry
                backoff_s = _BASE_BACKOFF_S * (2 ** attempt)
                await asyncio.sleep(backoff_s)
                attempt += 1

            except Exception as exc:
                # Non-retryable (ApiError, TimeoutError, unexpected) — fail fast
                last_error = exc
                break

        logger.error(
            "Batch embed failed after %d attempt(s): %s",
            attempt,
            str(last_error),
        )
        return 0, len(batch)


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _chunk(lst: list, size: int) -> list[list]:
    """Split a list into chunks of at most `size` elements."""
    return [lst[i : i + size] for i in range(0, len(lst), size)]

"""
Tests for the Embedding Refresh pattern — Python implementation.

Coverage:
- Unit: hash computation, staleness detection, batch chunking
- Failure mode: mixed model versions, partial refresh, rate limit handling,
  shadow index promotion guard, silent staleness accumulation
- Integration: end-to-end refresh cycle, model upgrade path

Run: cd src/py && python -m pytest tests/ -v
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import pytest

from src.py import EmbeddingRefresher, EmbeddingRefreshConfig
from src.py.mock_provider import (
    ApiError,
    InMemoryVectorStore,
    MockEmbeddingProvider,
    MockProviderConfig,
    RateLimitError,
)
from src.py.types import (
    DocumentRecord,
    EmbeddingItem,
    EmbeddingRequest,
    EmbeddingResponse,
)


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _make_doc(
    id: str,
    content: str,
    model_version: str = "1",
    days_old: float = 0.0,
) -> DocumentRecord:
    """Create a DocumentRecord with a pre-computed content hash."""
    refresher = EmbeddingRefresher(
        MockEmbeddingProvider(), InMemoryVectorStore()
    )
    last_refreshed = datetime.now(timezone.utc) - timedelta(days=days_old)
    return DocumentRecord(
        id=id,
        content=content,
        content_hash=refresher.compute_hash(content),
        last_refreshed_at=last_refreshed,
        embedding_model_version=model_version,
        embedding=[0.1, 0.2, 0.3],
    )


def run(coro):
    """Helper to run a coroutine in tests."""
    return asyncio.get_event_loop().run_until_complete(coro)


# ─── Unit Tests ───────────────────────────────────────────────────────────────


class TestComputeHash:
    def test_same_content_same_hash(self):
        r = EmbeddingRefresher(MockEmbeddingProvider(), InMemoryVectorStore())
        assert r.compute_hash("hello world") == r.compute_hash("hello world")

    def test_different_content_different_hash(self):
        r = EmbeddingRefresher(MockEmbeddingProvider(), InMemoryVectorStore())
        assert r.compute_hash("hello") != r.compute_hash("world")

    def test_metadata_changes_hash(self):
        r = EmbeddingRefresher(MockEmbeddingProvider(), InMemoryVectorStore())
        without = r.compute_hash("hello")
        with_meta = r.compute_hash("hello", {"author": "alice"})
        assert without != with_meta

    def test_metadata_key_order_independent(self):
        """Hash should be stable regardless of dict key insertion order."""
        r = EmbeddingRefresher(MockEmbeddingProvider(), InMemoryVectorStore())
        h1 = r.compute_hash("hello", {"a": 1, "b": 2})
        h2 = r.compute_hash("hello", {"b": 2, "a": 1})
        assert h1 == h2

    def test_md5_produces_32_char_hex(self):
        config = EmbeddingRefreshConfig(hash_algorithm="md5")
        r = EmbeddingRefresher(MockEmbeddingProvider(), InMemoryVectorStore(), config)
        # MD5 produces 32-char hex; SHA256 produces 64-char hex
        assert len(r.compute_hash("hello")) == 32

    def test_sha256_produces_64_char_hex(self):
        config = EmbeddingRefreshConfig(hash_algorithm="sha256")
        r = EmbeddingRefresher(MockEmbeddingProvider(), InMemoryVectorStore(), config)
        assert len(r.compute_hash("hello")) == 64


class TestIsStale:
    def test_fresh_doc_not_stale(self):
        config = EmbeddingRefreshConfig(model_version="1", staleness_threshold_days=7)
        r = EmbeddingRefresher(MockEmbeddingProvider(), InMemoryVectorStore(), config)
        doc = _make_doc("a", "content", model_version="1", days_old=0)
        stale, reason = r.is_stale(doc, "content")
        assert not stale
        assert reason is None

    def test_wrong_model_version_is_stale(self):
        """Model version check has highest priority."""
        config = EmbeddingRefreshConfig(model_version="2")
        r = EmbeddingRefresher(MockEmbeddingProvider(), InMemoryVectorStore(), config)
        doc = _make_doc("a", "content", model_version="1", days_old=0)  # embedded with v1
        stale, reason = r.is_stale(doc, "content")
        assert stale
        assert reason == "model"

    def test_time_threshold_triggers_staleness(self):
        config = EmbeddingRefreshConfig(model_version="1", staleness_threshold_days=7)
        r = EmbeddingRefresher(MockEmbeddingProvider(), InMemoryVectorStore(), config)
        doc = _make_doc("a", "content", model_version="1", days_old=10)  # 10 days old
        stale, reason = r.is_stale(doc, "content")
        assert stale
        assert reason == "time"

    def test_content_change_triggers_staleness(self):
        config = EmbeddingRefreshConfig(model_version="1", staleness_threshold_days=7)
        r = EmbeddingRefresher(MockEmbeddingProvider(), InMemoryVectorStore(), config)
        doc = _make_doc("a", "original content", model_version="1", days_old=0)
        stale, reason = r.is_stale(doc, "updated content")
        assert stale
        assert reason == "content-changed"

    def test_model_check_priority_over_content(self):
        """Model version takes priority even when content hash also changed."""
        config = EmbeddingRefreshConfig(model_version="2")
        r = EmbeddingRefresher(MockEmbeddingProvider(), InMemoryVectorStore(), config)
        doc = _make_doc("a", "content", model_version="1", days_old=0)
        _, reason = r.is_stale(doc, "content")
        assert reason == "model"


# ─── Integration Tests ────────────────────────────────────────────────────────


class TestRefreshIntegration:
    def setup_method(self):
        self.provider = MockEmbeddingProvider(
            MockProviderConfig(latency_ms=0, latency_jitter_ms=0)
        )
        self.store = InMemoryVectorStore()
        self.refresher = EmbeddingRefresher(
            self.provider,
            self.store,
            EmbeddingRefreshConfig(model_version="1", batch_size=10, max_concurrent_batches=2),
        )

    def test_embeds_new_documents(self):
        result = run(self.refresher.refresh([
            {"id": "doc1", "content": "hello world"},
            {"id": "doc2", "content": "goodbye world"},
        ]))
        assert result.refreshed == 2
        assert result.skipped == 0
        assert result.failed == 0

        stored = run(self.store.get("doc1"))
        assert stored is not None
        assert stored.embedding is not None
        assert stored.embedding_model_version == "1"

    def test_skips_unchanged_documents(self):
        docs = [{"id": "doc1", "content": "hello world"}]
        run(self.refresher.refresh(docs))
        result = run(self.refresher.refresh(docs))
        assert result.refreshed == 0
        assert result.skipped == 1

    def test_reembeds_changed_content(self):
        run(self.refresher.refresh([{"id": "doc1", "content": "original"}]))
        result = run(self.refresher.refresh([{"id": "doc1", "content": "updated content"}]))
        assert result.refreshed == 1
        assert result.skipped == 0

        stored = run(self.store.get("doc1"))
        assert stored is not None
        assert stored.content == "updated content"

    def test_stores_model_version_with_embedding(self):
        run(self.refresher.refresh([{"id": "doc1", "content": "test"}]))
        stored = run(self.store.get("doc1"))
        assert stored is not None
        assert stored.embedding_model_version == "1"

    def test_handles_large_corpus_with_batching(self):
        docs = [{"id": f"doc{i}", "content": f"content {i}"} for i in range(25)]
        result = run(self.refresher.refresh(docs))
        assert result.refreshed == 25
        assert result.failed == 0
        assert run(self.store.count()) == 25


# ─── Failure Mode Tests ───────────────────────────────────────────────────────


class TestFMMixedModelVersions:
    def test_staleness_report_detects_wrong_model(self):
        store = InMemoryVectorStore()
        # Pre-populate with v1 embeddings
        run(store.upsert_batch([
            _make_doc("doc1", "content 1", model_version="1"),
            _make_doc("doc2", "content 2", model_version="1"),
        ]))

        # Refresher configured for v2
        config = EmbeddingRefreshConfig(model_version="2")
        refresher = EmbeddingRefresher(MockEmbeddingProvider(), store, config)
        report = run(refresher.get_staleness_report())

        assert report.wrong_model_count == 2
        assert report.current_model_coverage == 0.0
        assert report.stale_count == 2

    def test_refresh_upgrades_to_new_model_version(self):
        store = InMemoryVectorStore()
        provider = MockEmbeddingProvider(MockProviderConfig(latency_ms=0, latency_jitter_ms=0))
        docs = [
            {"id": "doc1", "content": "content 1"},
            {"id": "doc2", "content": "content 2"},
        ]

        # Seed with v1
        v1_refresher = EmbeddingRefresher(
            provider, store, EmbeddingRefreshConfig(model_version="1")
        )
        run(v1_refresher.refresh(docs))

        # Upgrade to v2
        v2_refresher = EmbeddingRefresher(
            provider, store, EmbeddingRefreshConfig(model_version="2")
        )
        result = run(v2_refresher.refresh(docs))
        assert result.refreshed == 2

        report = run(v2_refresher.get_staleness_report())
        assert report.current_model_coverage == 1.0
        assert report.wrong_model_count == 0


class TestFMRateLimitHandling:
    def test_retries_on_rate_limit_eventually_succeeds(self):
        call_count = 0

        class OnceRateLimited:
            async def embed(self, request, model_version):
                nonlocal call_count
                call_count += 1
                if call_count == 1:
                    raise RateLimitError("Rate limit hit")
                return EmbeddingResponse(
                    embeddings=[
                        EmbeddingItem(id=d.id, embedding=[0.1, 0.2])
                        for d in request.documents
                    ]
                )

        store = InMemoryVectorStore()
        refresher = EmbeddingRefresher(
            OnceRateLimited(),
            store,
            EmbeddingRefreshConfig(model_version="1", batch_size=10),
        )
        result = run(refresher.refresh([{"id": "doc1", "content": "test"}]))
        assert result.refreshed == 1
        assert result.failed == 0
        assert call_count == 2  # 1 failure + 1 success

    def test_exhausted_retries_mark_batch_failed(self):
        """Provider always rate-limits → batch is failed after MAX_RETRIES."""
        provider = MockEmbeddingProvider(
            MockProviderConfig(
                latency_ms=0,
                latency_jitter_ms=0,
                error_rate=1.0,
                error_type="rate-limit",
            )
        )
        store = InMemoryVectorStore()
        refresher = EmbeddingRefresher(
            provider, store, EmbeddingRefreshConfig(model_version="1", batch_size=10)
        )
        result = run(refresher.refresh([{"id": "doc1", "content": "test"}]))
        assert result.failed == 1
        assert result.refreshed == 0


class TestFMMetadataOnlyChanges:
    def test_detects_metadata_only_change(self):
        provider = MockEmbeddingProvider(MockProviderConfig(latency_ms=0, latency_jitter_ms=0))
        store = InMemoryVectorStore()
        refresher = EmbeddingRefresher(provider, store, EmbeddingRefreshConfig(model_version="1"))

        run(refresher.refresh([{"id": "doc1", "content": "policy text", "metadata": {"version": "v1"}}]))

        # Same content, different metadata — should be detected as stale
        result = run(refresher.refresh([{"id": "doc1", "content": "policy text", "metadata": {"version": "v2"}}]))
        assert result.refreshed == 1
        assert result.skipped == 0


class TestFMPartialRefreshRestartable:
    def test_second_run_only_processes_failed_docs(self):
        call_count = 0

        class FlakeyProvider:
            async def embed(self, request, model_version):
                nonlocal call_count
                call_count += 1
                if call_count > 1:
                    raise ApiError("Provider unavailable (simulated kill)")
                return EmbeddingResponse(
                    embeddings=[
                        EmbeddingItem(id=d.id, embedding=[0.1])
                        for d in request.documents
                    ]
                )

        store = InMemoryVectorStore()
        refresher = EmbeddingRefresher(
            FlakeyProvider(),
            store,
            EmbeddingRefreshConfig(
                model_version="1",
                batch_size=2,
                max_concurrent_batches=1,
            ),
        )

        docs = [
            {"id": "d1", "content": "a"},
            {"id": "d2", "content": "b"},
            {"id": "d3", "content": "c"},
            {"id": "d4", "content": "d"},
        ]

        # First run: batch 1 succeeds (d1, d2), batch 2 fails (d3, d4)
        first_result = run(refresher.refresh(docs))
        assert first_result.refreshed == 2
        assert first_result.failed == 2

        # Repair the provider and run again
        good_provider = MockEmbeddingProvider(MockProviderConfig(latency_ms=0, latency_jitter_ms=0))
        refresher2 = EmbeddingRefresher(
            good_provider,
            store,
            EmbeddingRefreshConfig(model_version="1", batch_size=2),
        )
        second_result = run(refresher2.refresh(docs))
        assert second_result.refreshed == 2
        assert second_result.skipped == 2


class TestFMSilentStalenessAccumulation:
    def test_time_based_staleness_detected_without_content_change(self):
        """Key 6-month failure: content hasn't changed but time has elapsed."""
        store = InMemoryVectorStore()
        old_date = datetime.now(timezone.utc) - timedelta(days=37)
        run(store.upsert(DocumentRecord(
            id="doc1",
            content="policy — text unchanged",
            content_hash="abc123",
            last_refreshed_at=old_date,
            embedding_model_version="1",
            embedding=[0.1, 0.2],
        )))

        config = EmbeddingRefreshConfig(model_version="1", staleness_threshold_days=7)
        refresher = EmbeddingRefresher(MockEmbeddingProvider(), store, config)
        report = run(refresher.get_staleness_report())

        assert report.stale_count == 1
        assert report.stale_docs[0].reason == "time"

    def test_coverage_metric_exposes_accumulating_mixed_versions(self):
        store = InMemoryVectorStore()
        # 3 docs on v1, 1 on v2 — simulates partial silent migration
        run(store.upsert_batch([
            _make_doc("d1", "a", "1"),
            _make_doc("d2", "b", "1"),
            _make_doc("d3", "c", "1"),
            _make_doc("d4", "d", "2"),
        ]))

        config = EmbeddingRefreshConfig(model_version="2")
        refresher = EmbeddingRefresher(MockEmbeddingProvider(), store, config)
        report = run(refresher.get_staleness_report())

        assert abs(report.current_model_coverage - 0.25) < 0.01
        assert report.wrong_model_count == 3


class TestFMShadowIndexPromotionGuard:
    def test_partial_migration_coverage_detectable(self):
        store = InMemoryVectorStore()
        # 8 of 10 docs on v2, 2 still on v1
        docs = [
            DocumentRecord(
                id=f"doc{i}",
                content=f"content {i}",
                content_hash=f"hash{i}",
                last_refreshed_at=datetime.now(timezone.utc),
                embedding_model_version="2" if i < 8 else "1",
                embedding=[0.1],
            )
            for i in range(10)
        ]
        run(store.upsert_batch(docs))

        config = EmbeddingRefreshConfig(model_version="2")
        refresher = EmbeddingRefresher(MockEmbeddingProvider(), store, config)
        report = run(refresher.get_staleness_report())

        assert report.current_model_coverage < 1.0
        assert abs(report.current_model_coverage - 0.8) < 0.01
        assert report.wrong_model_count == 2


class TestGetStalenessReport:
    def test_empty_corpus_returns_safe_defaults(self):
        refresher = EmbeddingRefresher(MockEmbeddingProvider(), InMemoryVectorStore())
        report = run(refresher.get_staleness_report())
        assert report.total_documents == 0
        assert report.current_model_coverage == 1.0  # vacuously fresh
        assert report.oldest_refreshed_at is None

    def test_full_refresh_gives_100pct_coverage(self):
        provider = MockEmbeddingProvider(MockProviderConfig(latency_ms=0, latency_jitter_ms=0))
        store = InMemoryVectorStore()
        config = EmbeddingRefreshConfig(model_version="1")
        refresher = EmbeddingRefresher(provider, store, config)

        run(refresher.refresh([{"id": "d1", "content": "a"}, {"id": "d2", "content": "b"}]))
        report = run(refresher.get_staleness_report())

        assert report.current_model_coverage == 1.0
        assert report.wrong_model_count == 0
        assert report.stale_count == 0

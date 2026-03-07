"""Tests for the Semantic Caching pattern — Python implementation.

Three categories: unit tests, failure mode tests, integration tests.
"""

from __future__ import annotations

import asyncio
import time

import pytest

from .. import SemanticCache, cosine_similarity
from ..mock_provider import MockEmbeddingProvider, MockLLMProvider
from .._types import InvalidationFilter, QueryOptions, SemanticCacheConfig


# ─── Helpers ──────────────────────────────────────────────────


def make_cache(**overrides) -> tuple[SemanticCache, MockEmbeddingProvider, MockLLMProvider]:
    embedding = MockEmbeddingProvider(latency_ms=0)
    llm = MockLLMProvider(latency_ms=0)
    defaults = dict(similarity_threshold=0.85, ttl=3600, max_entries=100)
    defaults.update(overrides)
    config = SemanticCacheConfig(**defaults)
    cache = SemanticCache(embedding, llm, config)
    return cache, embedding, llm


# ─── Unit Tests ───────────────────────────────────────────────


class TestCosineSimilarity:
    def test_identical_vectors(self):
        v = [1.0, 2.0, 3.0, 4.0, 5.0]
        assert cosine_similarity(v, v) == pytest.approx(1.0, abs=1e-5)

    def test_orthogonal_vectors(self):
        a = [1.0, 0.0, 0.0]
        b = [0.0, 1.0, 0.0]
        assert cosine_similarity(a, b) == pytest.approx(0.0, abs=1e-5)

    def test_opposite_vectors(self):
        a = [1.0, 2.0, 3.0]
        b = [-1.0, -2.0, -3.0]
        assert cosine_similarity(a, b) == pytest.approx(-1.0, abs=1e-5)

    def test_zero_vector(self):
        a = [0.0, 0.0, 0.0]
        b = [1.0, 2.0, 3.0]
        assert cosine_similarity(a, b) == 0.0


class TestConfiguration:
    @pytest.mark.asyncio
    async def test_default_config(self):
        cache, _, _ = make_cache()
        stats = cache.stats()
        assert stats.total_entries == 0
        assert stats.hit_rate == 0.0

    @pytest.mark.asyncio
    async def test_high_threshold_prevents_match(self):
        cache, _, llm = make_cache(similarity_threshold=0.999)
        await cache.query("What is the return policy?")
        result = await cache.query("How do I return an item?")
        assert not result.cache_hit
        assert llm.call_count == 2

    @pytest.mark.asyncio
    async def test_per_query_threshold_override(self):
        cache, _, _ = make_cache(similarity_threshold=0.5)
        await cache.query("What is the return policy?")
        result = await cache.query(
            "How do I return an item?",
            QueryOptions(similarity_threshold=0.999),
        )
        assert not result.cache_hit

    @pytest.mark.asyncio
    async def test_bypass_cache(self):
        cache, _, llm = make_cache()
        await cache.query("What is the return policy?")
        result = await cache.query(
            "What is the return policy?",
            QueryOptions(bypass_cache=True),
        )
        assert not result.cache_hit
        assert llm.call_count == 2
        assert cache.size == 2


class TestCacheHitMiss:
    @pytest.mark.asyncio
    async def test_first_query_is_miss(self):
        cache, _, _ = make_cache()
        result = await cache.query("What is the return policy?")
        assert not result.cache_hit
        assert result.similarity_score is None

    @pytest.mark.asyncio
    async def test_identical_query_is_hit(self):
        cache, _, llm = make_cache()
        await cache.query("What is the return policy?")
        result = await cache.query("What is the return policy?")
        assert result.cache_hit
        assert result.similarity_score == pytest.approx(1.0, abs=1e-3)
        assert llm.call_count == 1

    @pytest.mark.asyncio
    async def test_stats_tracking(self):
        cache, _, _ = make_cache()
        await cache.query("Question A")
        await cache.query("Question A")
        await cache.query("Question B")
        stats = cache.stats()
        assert stats.hits == 1
        assert stats.misses == 2
        assert stats.hit_rate == pytest.approx(1 / 3)


class TestNamespaceIsolation:
    @pytest.mark.asyncio
    async def test_different_namespaces_are_isolated(self):
        cache, _, llm = make_cache()
        await cache.query("What is the return policy?", QueryOptions(namespace="store-a"))
        result = await cache.query(
            "What is the return policy?", QueryOptions(namespace="store-b")
        )
        assert not result.cache_hit
        assert llm.call_count == 2

    @pytest.mark.asyncio
    async def test_same_namespace_hits(self):
        cache, _, llm = make_cache()
        await cache.query("What is the return policy?", QueryOptions(namespace="store-a"))
        result = await cache.query(
            "What is the return policy?", QueryOptions(namespace="store-a")
        )
        assert result.cache_hit
        assert llm.call_count == 1

    @pytest.mark.asyncio
    async def test_entries_by_namespace_in_stats(self):
        cache, _, _ = make_cache()
        await cache.query("Q1", QueryOptions(namespace="ns-a"))
        await cache.query("Q2", QueryOptions(namespace="ns-a"))
        await cache.query("Q3", QueryOptions(namespace="ns-b"))
        stats = cache.stats()
        assert stats.entries_by_namespace["ns-a"] == 2
        assert stats.entries_by_namespace["ns-b"] == 1


class TestTTLExpiration:
    @pytest.mark.asyncio
    async def test_expired_entries_are_evicted(self):
        cache, _, llm = make_cache(ttl=1)
        await cache.query("What is the return policy?")
        await asyncio.sleep(1.1)
        result = await cache.query("What is the return policy?")
        assert not result.cache_hit
        assert llm.call_count == 2

    @pytest.mark.asyncio
    async def test_per_query_ttl_override(self):
        cache, _, llm = make_cache(ttl=3600)
        await cache.query("What is the return policy?", QueryOptions(ttl=1))
        await asyncio.sleep(1.1)
        result = await cache.query("What is the return policy?", QueryOptions(ttl=1))
        assert not result.cache_hit
        assert llm.call_count == 2


class TestInvalidation:
    @pytest.mark.asyncio
    async def test_invalidate_by_namespace(self):
        cache, _, _ = make_cache()
        await cache.query("Q1", QueryOptions(namespace="ns-a"))
        await cache.query("Q2", QueryOptions(namespace="ns-a"))
        await cache.query("Q3", QueryOptions(namespace="ns-b"))
        removed = await cache.invalidate(InvalidationFilter(namespace="ns-a"))
        assert removed == 2
        assert cache.size == 1

    @pytest.mark.asyncio
    async def test_invalidate_older_than(self):
        cache, _, _ = make_cache()
        await cache.query("Old question")
        cutoff = time.time() + 0.1
        removed = await cache.invalidate(InvalidationFilter(older_than=cutoff))
        assert removed == 1
        assert cache.size == 0


class TestEviction:
    @pytest.mark.asyncio
    async def test_evicts_at_max_entries(self):
        cache, _, _ = make_cache(max_entries=3)
        await cache.query("Q1")
        await cache.query("Q2")
        await cache.query("Q3")
        await cache.query("Q4")
        assert cache.size <= 3
        assert cache.stats().evictions > 0


# ─── Failure Mode Tests ──────────────────────────────────────


class TestFMFalsePositive:
    @pytest.mark.asyncio
    async def test_high_threshold_rejects_different_intents(self):
        cache, _, llm = make_cache(similarity_threshold=0.95)
        await cache.query("sort ascending")
        result = await cache.query("sort descending")
        assert not result.cache_hit
        assert llm.call_count == 2


class TestFMStalePoisoning:
    @pytest.mark.asyncio
    async def test_stale_entries_removed_on_ttl_expiry(self):
        cache, _, llm = make_cache(ttl=1)
        await cache.query("What is the return policy?")
        await asyncio.sleep(1.1)
        result = await cache.query("What is the return policy?")
        assert not result.cache_hit
        assert llm.call_count == 2
        assert cache.size == 1


class TestFMEmbeddingModelMismatch:
    @pytest.mark.asyncio
    async def test_different_model_version_misses(self):
        embedding = MockEmbeddingProvider(latency_ms=0)
        llm = MockLLMProvider(latency_ms=0)

        cache_v1 = SemanticCache(
            embedding, llm,
            SemanticCacheConfig(embedding_model_version="v1", similarity_threshold=0.5),
        )
        await cache_v1.query("What is the return policy?")
        assert cache_v1.size == 1

        # New cache with different model version — separate instance, no shared entries
        cache_v2 = SemanticCache(
            embedding, llm,
            SemanticCacheConfig(embedding_model_version="v2", similarity_threshold=0.5),
        )
        result = await cache_v2.query("What is the return policy?")
        assert not result.cache_hit


class TestFMCapacityExhaustion:
    @pytest.mark.asyncio
    async def test_eviction_keeps_cache_bounded(self):
        cache, _, _ = make_cache(max_entries=5)
        for i in range(20):
            await cache.query(f"Unique question number {i}")
        assert cache.size <= 5
        assert cache.stats().evictions > 0


class TestFMThresholdDrift:
    @pytest.mark.asyncio
    async def test_similarity_score_trackable_via_stats(self):
        cache, _, _ = make_cache(similarity_threshold=0.5)
        await cache.query("What is the return policy?")
        await cache.query("What is the return policy?")
        stats = cache.stats()
        assert stats.avg_similarity_score > 0
        assert stats.hits == 1


class TestFMNamespacePollution:
    @pytest.mark.asyncio
    async def test_different_namespaces_dont_contaminate(self):
        cache, _, llm = make_cache()
        await cache.query("How do I reset my password?", QueryOptions(namespace="admin-panel"))
        result = await cache.query(
            "How do I reset my password?", QueryOptions(namespace="customer-portal")
        )
        assert not result.cache_hit
        assert llm.call_count == 2


# ─── Integration Tests ────────────────────────────────────────


class TestFullLifecycle:
    @pytest.mark.asyncio
    async def test_cache_lifecycle(self):
        cache, _, llm = make_cache(similarity_threshold=0.5, max_entries=50)

        # Phase 1: Cold cache — all misses
        await cache.query("What is the return policy?")
        await cache.query("How much does shipping cost?")
        await cache.query("Where is my order?")
        assert llm.call_count == 3

        # Phase 2: Repeat query — should hit
        hit = await cache.query("What is the return policy?")
        assert hit.cache_hit

        # Phase 3: Invalidate a topic
        removed = await cache.invalidate(
            InvalidationFilter(query="What is the return policy?", similarity_threshold=0.5)
        )
        assert removed > 0

        # Phase 4: Re-query — should miss
        after = await cache.query("What is the return policy?")
        assert not after.cache_hit

        # Phase 5: Stats
        stats = cache.stats()
        assert stats.hits >= 1
        assert stats.misses >= 4
        assert stats.total_entries > 0

    @pytest.mark.asyncio
    async def test_concurrent_queries(self):
        cache, _, llm = make_cache()
        queries = [f"Question {i}" for i in range(10)]

        # All concurrent — all misses
        results = await asyncio.gather(*(cache.query(q) for q in queries))
        assert all(not r.cache_hit for r in results)
        assert llm.call_count == 10
        assert cache.size == 10

        # Same queries again — all hits
        results2 = await asyncio.gather(*(cache.query(q) for q in queries))
        assert all(r.cache_hit for r in results2)
        assert llm.call_count == 10  # No new LLM calls

    @pytest.mark.asyncio
    async def test_clear_resets_cache(self):
        cache, _, _ = make_cache()
        await cache.query("Q1")
        await cache.query("Q2")
        assert cache.size == 2
        cache.clear()
        assert cache.size == 0
        # Stats persist after clear
        assert cache.stats().misses == 2


class TestErrorPropagation:
    @pytest.mark.asyncio
    async def test_llm_errors_not_cached(self):
        embedding = MockEmbeddingProvider(latency_ms=0)
        llm = MockLLMProvider(latency_ms=0, error_rate=1.0)
        cache = SemanticCache(embedding, llm, SemanticCacheConfig(similarity_threshold=0.85))

        with pytest.raises(RuntimeError, match="Mock provider error"):
            await cache.query("Will this fail?")
        assert cache.size == 0

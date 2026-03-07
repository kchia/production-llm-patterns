"""Semantic Caching — Cache LLM responses by meaning, not string identity.

Wraps any LLM provider. On each request, embeds the query, searches the
in-process vector store for a match above the similarity threshold, and
either returns the cached response or calls through to the provider.
"""

from __future__ import annotations

import math
import time
from collections import Counter
from itertools import count

from ._types import (
    CacheEntry,
    CacheResult,
    CacheStats,
    EmbeddingProvider,
    InvalidationFilter,
    LLMProvider,
    QueryOptions,
    SemanticCacheConfig,
)

_id_counter = count()


def _generate_id() -> str:
    return f"cache-{time.time_ns()}-{next(_id_counter)}"


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Cosine similarity between two vectors. Returns value in [-1, 1]."""
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    denom = norm_a * norm_b
    return dot / denom if denom > 0 else 0.0


class SemanticCache:
    """In-process semantic cache wrapping an LLM provider."""

    def __init__(
        self,
        embedding_provider: EmbeddingProvider,
        llm_provider: LLMProvider,
        config: SemanticCacheConfig | None = None,
    ) -> None:
        self._embedding_provider = embedding_provider
        self._llm_provider = llm_provider
        self._config = config or SemanticCacheConfig()
        self._entries: dict[str, CacheEntry] = {}

        # Stats counters
        self._hit_count = 0
        self._miss_count = 0
        self._eviction_count = 0
        self._similarity_score_sum = 0.0
        self._similarity_score_count = 0

    async def query(
        self, input_text: str, options: QueryOptions | None = None
    ) -> CacheResult:
        opts = options or QueryOptions()
        start = time.perf_counter()
        namespace = opts.namespace if opts.namespace is not None else self._config.namespace
        threshold = (
            opts.similarity_threshold
            if opts.similarity_threshold is not None
            else self._config.similarity_threshold
        )
        ttl = opts.ttl if opts.ttl is not None else self._config.ttl
        bypass = opts.bypass_cache

        embedding = await self._embedding_provider.embed(input_text)

        if not bypass:
            match = self._find_best_match(embedding, namespace, threshold)

            if match is not None:
                entry, score = match
                age = time.time() - entry.created_at
                if age <= ttl:
                    entry.last_hit_at = time.time()
                    entry.hit_count += 1
                    self._hit_count += 1
                    self._similarity_score_sum += score
                    self._similarity_score_count += 1

                    return CacheResult(
                        response=entry.response,
                        cache_hit=True,
                        similarity_score=score,
                        latency_ms=(time.perf_counter() - start) * 1000,
                    )
                # TTL expired — remove stale entry
                del self._entries[entry.id]

        # Cache miss — call through to LLM
        self._miss_count += 1
        response = await self._llm_provider.complete(input_text)

        entry = CacheEntry(
            id=_generate_id(),
            query=input_text,
            embedding=embedding,
            response=response,
            namespace=namespace,
            created_at=time.time(),
            last_hit_at=time.time(),
            hit_count=0,
            embedding_model_version=self._config.embedding_model_version,
        )

        self._evict_if_needed()
        self._entries[entry.id] = entry

        return CacheResult(
            response=response,
            cache_hit=False,
            similarity_score=None,
            latency_ms=(time.perf_counter() - start) * 1000,
        )

    async def invalidate(self, filter: InvalidationFilter) -> int:
        filter_embedding: list[float] | None = None
        if filter.query is not None:
            filter_embedding = await self._embedding_provider.embed(filter.query)

        to_remove: list[str] = []

        for entry_id, entry in self._entries.items():
            if filter.namespace and entry.namespace != filter.namespace:
                continue

            should_remove = False

            if filter.older_than is not None and entry.created_at < filter.older_than:
                should_remove = True

            if filter_embedding is not None:
                score = cosine_similarity(filter_embedding, entry.embedding)
                thresh = filter.similarity_threshold or self._config.similarity_threshold
                if score >= thresh:
                    should_remove = True

            # If no specific filters, remove everything in the namespace
            if filter.older_than is None and filter.query is None:
                should_remove = True

            if should_remove:
                to_remove.append(entry_id)

        for entry_id in to_remove:
            del self._entries[entry_id]

        return len(to_remove)

    def stats(self) -> CacheStats:
        total = self._hit_count + self._miss_count
        ns_counts: dict[str, int] = {}
        for entry in self._entries.values():
            ns_counts[entry.namespace] = ns_counts.get(entry.namespace, 0) + 1

        return CacheStats(
            total_entries=len(self._entries),
            hits=self._hit_count,
            misses=self._miss_count,
            hit_rate=self._hit_count / total if total > 0 else 0.0,
            avg_similarity_score=(
                self._similarity_score_sum / self._similarity_score_count
                if self._similarity_score_count > 0
                else 0.0
            ),
            evictions=self._eviction_count,
            entries_by_namespace=ns_counts,
        )

    def reset_stats(self) -> None:
        """Reset all stats counters (useful for benchmark warm-up)."""
        self._hit_count = 0
        self._miss_count = 0
        self._eviction_count = 0
        self._similarity_score_sum = 0.0
        self._similarity_score_count = 0

    def clear(self) -> None:
        """Clear all cache entries."""
        self._entries.clear()

    @property
    def size(self) -> int:
        """Current number of entries."""
        return len(self._entries)

    def _find_best_match(
        self, embedding: list[float], namespace: str, threshold: float
    ) -> tuple[CacheEntry, float] | None:
        best_score = -1.0
        best_entry: CacheEntry | None = None

        for entry in self._entries.values():
            if entry.namespace != namespace:
                continue
            if entry.embedding_model_version != self._config.embedding_model_version:
                continue

            score = cosine_similarity(embedding, entry.embedding)
            if score >= threshold and score > best_score:
                best_score = score
                best_entry = entry

        return (best_entry, best_score) if best_entry is not None else None

    def _evict_if_needed(self) -> None:
        while len(self._entries) >= self._config.max_entries:
            victim_id = self._select_eviction_victim()
            if victim_id is not None:
                del self._entries[victim_id]
                self._eviction_count += 1
            else:
                break

    def _select_eviction_victim(self) -> str | None:
        """Selects which entry to evict. lru-score weights last-hit time by
        hit count so frequently-accessed entries survive longer than pure LRU."""
        worst_id: str | None = None
        worst_score = float("inf")

        for entry_id, entry in self._entries.items():
            if self._config.eviction_policy == "lru-score":
                score = entry.last_hit_at * (1 + math.log2(entry.hit_count + 1))
            else:
                score = entry.last_hit_at

            if score < worst_score:
                worst_score = score
                worst_id = entry_id

        return worst_id

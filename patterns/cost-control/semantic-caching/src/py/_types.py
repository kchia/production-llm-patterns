"""Semantic Caching — Type definitions using dataclasses and protocols."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Literal, Protocol


class EmbeddingProvider(Protocol):
    """Protocol for embedding providers."""

    @property
    def dimensions(self) -> int: ...

    async def embed(self, text: str) -> list[float]: ...


@dataclass
class LLMResponse:
    text: str
    input_tokens: int
    output_tokens: int
    latency_ms: float


class LLMProvider(Protocol):
    """Protocol for LLM providers."""

    async def complete(self, prompt: str) -> LLMResponse: ...


@dataclass
class CacheEntry:
    id: str
    query: str
    embedding: list[float]
    response: LLMResponse
    namespace: str
    created_at: float  # time.time() epoch seconds
    last_hit_at: float
    hit_count: int = 0
    embedding_model_version: str = "mock-v1"


@dataclass
class QueryOptions:
    similarity_threshold: float | None = None
    ttl: float | None = None
    bypass_cache: bool = False
    namespace: str | None = None


@dataclass
class CacheResult:
    response: LLMResponse
    cache_hit: bool
    similarity_score: float | None
    latency_ms: float


@dataclass
class InvalidationFilter:
    namespace: str | None = None
    older_than: float | None = None  # epoch timestamp
    query: str | None = None
    similarity_threshold: float | None = None


@dataclass
class CacheStats:
    total_entries: int
    hits: int
    misses: int
    hit_rate: float
    avg_similarity_score: float
    evictions: int
    entries_by_namespace: dict[str, int]


@dataclass
class SemanticCacheConfig:
    similarity_threshold: float = 0.85
    ttl: float = 3600.0
    max_entries: int = 10_000
    eviction_policy: Literal["lru", "lru-score"] = "lru-score"
    namespace: str = "default"
    embedding_model_version: str = "mock-v1"

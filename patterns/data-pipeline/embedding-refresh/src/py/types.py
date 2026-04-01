"""
Type definitions for the Embedding Refresh pattern.

Core design principle: every DocumentRecord carries its embedding_model_version
as first-class metadata. Without this, zero-downtime model upgrades are impossible —
you can't know which documents need re-embedding during a migration.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, Optional, Protocol


@dataclass
class EmbeddingRefreshConfig:
    """Configuration for the EmbeddingRefresher.

    Defaults are starting points — adjust staleness_threshold_days based on
    how frequently your source content changes, and batch_size based on your
    embedding provider's rate limits and average document sizes.
    """

    embedding_model: str = "text-embedding-3-large"
    """Model identifier, e.g. 'text-embedding-3-large'"""

    model_version: str = "1"
    """Semantic version for migration tracking. Increment when switching models."""

    staleness_threshold_days: float = 7.0
    """Refresh if last_refreshed_at is older than this many days."""

    batch_size: int = 100
    """Documents per embedding API call. Tune based on provider batch limits."""

    max_concurrent_batches: int = 4
    """Parallel embedding API calls. Reduce if hitting rate limits."""

    hash_algorithm: Literal["sha256", "md5"] = "sha256"
    """Document fingerprint algorithm. sha256 is safer; md5 is faster."""


@dataclass
class DocumentRecord:
    """A document with its stored embedding and metadata for staleness tracking."""

    id: str
    content: str
    content_hash: str
    """SHA-256 (or MD5) of the current content — used to detect changes."""

    last_refreshed_at: datetime
    embedding_model_version: str
    """Which model version produced this embedding — critical for migration tracking."""

    embedding: Optional[list[float]] = None
    metadata: Optional[dict[str, Any]] = None


@dataclass
class RefreshResult:
    """Result of a refresh cycle."""

    refreshed: int
    skipped: int
    failed: int
    duration_ms: float
    staleness_by_model: dict[str, int]
    """Count of documents per model version.
    If this shows >1 key, a migration is partially complete or
    mixed-model contamination has occurred.
    """


StalenessReason = Literal["model", "time", "content-changed"]


@dataclass
class StaleDocInfo:
    id: str
    last_refreshed_at: datetime
    reason: StalenessReason


@dataclass
class StalenessReport:
    """Non-mutating staleness snapshot — safe to call frequently for monitoring."""

    total_documents: int
    stale_count: int
    wrong_model_count: int
    current_model_coverage: float
    """Fraction of corpus on the configured model_version (0.0–1.0)."""

    oldest_refreshed_at: Optional[datetime]
    stale_docs: list[StaleDocInfo] = field(default_factory=list)


@dataclass
class EmbeddingItem:
    id: str
    embedding: list[float]
    error: Optional[str] = None


@dataclass
class EmbeddingRequest:
    documents: list[DocumentRecord]


@dataclass
class EmbeddingResponse:
    embeddings: list[EmbeddingItem]


class EmbeddingProvider(Protocol):
    """Protocol for embedding providers — implement this to swap in real APIs."""

    async def embed(
        self, request: EmbeddingRequest, model_version: str
    ) -> EmbeddingResponse:
        ...


class VectorStore(Protocol):
    """Protocol for vector stores — implement to swap in Pinecone, Weaviate, pgvector, etc."""

    async def upsert(self, record: DocumentRecord) -> None:
        ...

    async def upsert_batch(self, records: list[DocumentRecord]) -> None:
        ...

    async def get(self, id: str) -> Optional[DocumentRecord]:
        ...

    async def list_all(self) -> list[DocumentRecord]:
        ...

    async def count(self) -> int:
        ...

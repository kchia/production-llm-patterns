"""
Mock embedding provider for testing and benchmarks.

Simulates realistic embedding API behavior:
- Configurable latency with jitter
- Configurable error injection (rate-limit, timeout, api-error)
- Deterministic embeddings seeded by content hash (reproducible across runs)
- In-memory vector store for tests

Python idiom notes:
- Uses asyncio.sleep instead of setTimeout
- LCG seeded embedding matches the TypeScript implementation's output structure
  (same numeric approach, different language primitives)
- dataclasses instead of interfaces
"""

from __future__ import annotations

import asyncio
import hashlib
import math
import random
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

from .types import (
    DocumentRecord,
    EmbeddingItem,
    EmbeddingProvider,
    EmbeddingRequest,
    EmbeddingResponse,
    VectorStore,
)


# ─── Error types ──────────────────────────────────────────────────────────────


class RateLimitError(Exception):
    """Raised when the provider returns 429 / rate limit exceeded."""

    code = "RATE_LIMIT"


class TimeoutError(Exception):  # noqa: A001
    """Raised when the provider request times out."""

    code = "TIMEOUT"


class ApiError(Exception):
    """Raised on generic provider error (500)."""

    code = "API_ERROR"


# ─── Mock provider config ─────────────────────────────────────────────────────


@dataclass
class MockProviderConfig:
    latency_ms: float = 50.0
    """Average latency per batch in ms."""

    latency_jitter_ms: float = 20.0
    """Latency jitter ± this many ms."""

    error_rate: float = 0.0
    """Fraction of requests that fail (0.0–1.0)."""

    error_type: str = "api-error"
    """One of: 'rate-limit', 'timeout', 'api-error'."""

    dimensions: int = 8
    """Embedding dimensions. Small default (8) for fast tests."""


# ─── Mock embedding provider ──────────────────────────────────────────────────


class MockEmbeddingProvider:
    """Deterministic mock embedding provider for unit tests and benchmarks.

    Generates L2-normalised float vectors seeded by content hash so embeddings
    are stable across test runs without any real API calls.
    """

    def __init__(self, config: Optional[MockProviderConfig] = None) -> None:
        self._config = config or MockProviderConfig()
        self._call_count = 0

    async def embed(
        self, request: EmbeddingRequest, _model_version: str
    ) -> EmbeddingResponse:
        self._call_count += 1

        # Simulate latency with jitter
        jitter = (random.random() - 0.5) * 2 * self._config.latency_jitter_ms
        delay_ms = max(0.0, self._config.latency_ms + jitter)
        if delay_ms > 0:
            await asyncio.sleep(delay_ms / 1000.0)

        # Inject errors at the configured rate
        if random.random() < self._config.error_rate:
            if self._config.error_type == "rate-limit":
                raise RateLimitError("Mock provider: rate limit exceeded (429)")
            elif self._config.error_type == "timeout":
                raise TimeoutError("Mock provider: request timed out")
            else:
                raise ApiError("Mock provider: internal server error (500)")

        embeddings = [
            EmbeddingItem(
                id=doc.id,
                embedding=_deterministic_embedding(doc.content_hash, self._config.dimensions),
            )
            for doc in request.documents
        ]
        return EmbeddingResponse(embeddings=embeddings)

    @property
    def total_calls(self) -> int:
        return self._call_count

    def reset(self) -> None:
        self._call_count = 0


# ─── In-memory vector store ───────────────────────────────────────────────────


class InMemoryVectorStore:
    """Thread-unsafe in-memory store for single-process tests and benchmarks.

    Swap out for a real implementation (Pinecone, Weaviate, pgvector, etc.)
    in production by implementing the VectorStore protocol.
    """

    def __init__(self) -> None:
        self._store: dict[str, DocumentRecord] = {}

    async def upsert(self, record: DocumentRecord) -> None:
        # Shallow copy to prevent external mutation of stored records
        from dataclasses import replace
        self._store[record.id] = replace(record)

    async def upsert_batch(self, records: list[DocumentRecord]) -> None:
        from dataclasses import replace
        for record in records:
            self._store[record.id] = replace(record)

    async def get(self, id: str) -> Optional[DocumentRecord]:
        return self._store.get(id)

    async def list_all(self) -> list[DocumentRecord]:
        return list(self._store.values())

    async def count(self) -> int:
        return len(self._store)

    def get_all(self) -> dict[str, DocumentRecord]:
        """Expose internal store for test assertions."""
        return self._store

    def clear(self) -> None:
        self._store.clear()


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _deterministic_embedding(content_hash: str, dimensions: int) -> list[float]:
    """Generate a deterministic L2-normalised embedding from a content hash.

    Uses the first 8 hex chars as a seed for a linear congruential generator
    (same LCG constants as Java's Random), producing stable vectors across runs.
    The TypeScript implementation uses the same approach, so embeddings from
    both languages are structurally equivalent for the same content hash.
    """
    seed = int(content_hash[:8], 16)
    embedding: list[float] = []

    state = seed & 0xFFFFFFFF
    for _ in range(dimensions):
        # LCG with Java Random constants for cross-language reproducibility
        state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
        # Map to [-1, 1]
        embedding.append((state / 0xFFFFFFFF) * 2 - 1)

    # L2-normalise so cosine similarity is meaningful
    magnitude = math.sqrt(sum(v * v for v in embedding))
    if magnitude > 0:
        embedding = [v / magnitude for v in embedding]

    return embedding


def sha256(input_str: str) -> str:
    """Compute SHA-256 hex digest of a string."""
    return hashlib.sha256(input_str.encode()).hexdigest()


def md5(input_str: str) -> str:
    """Compute MD5 hex digest of a string."""
    return hashlib.md5(input_str.encode()).hexdigest()

"""
Request Batching -- Type Definitions

Core types for grouping LLM API requests into batches for throughput efficiency.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Generic, Protocol, TypeVar

T = TypeVar("T")
TInput = TypeVar("TInput")
TOutput = TypeVar("TOutput")


@dataclass
class BatchConfig:
    """Configuration for the batch processor."""

    max_batch_size: int = 20
    """Maximum items per batch."""

    max_concurrent_batches: int = 3
    """Max batches running simultaneously."""

    flush_interval_ms: float = 100
    """Max ms to wait for a batch to fill before flushing a partial batch."""

    retry_attempts: int = 3
    """Per-batch retry attempts on failure."""

    retry_delay_ms: float = 1000
    """Base delay (ms) between retries. Applied with exponential backoff + jitter."""

    item_timeout_ms: float = 30_000
    """Max ms to wait for a single item before marking it timed out."""


@dataclass
class BatchItem(Generic[T]):
    """A single item submitted for batch processing."""

    id: str
    data: T


@dataclass
class BatchItemResult(Generic[TInput, TOutput]):
    """Result for a single successfully processed item."""

    item: BatchItem[TInput]
    result: TOutput


@dataclass
class BatchItemError(Generic[TInput]):
    """A failed item with its error."""

    item: BatchItem[TInput]
    error: Exception


@dataclass
class BatchMetrics:
    """Aggregate metrics for a completed batch job."""

    total_items: int = 0
    total_batches: int = 0
    successful_batches: int = 0
    failed_batches: int = 0
    avg_batch_size: float = 0.0
    duration_ms: float = 0.0
    success_count: int = 0
    failure_count: int = 0


@dataclass
class BatchResult(Generic[TInput, TOutput]):
    """Aggregated result for an entire batch job."""

    results: list[BatchItemResult[TInput, TOutput]] = field(default_factory=list)
    failed: list[BatchItemError[TInput]] = field(default_factory=list)
    metrics: BatchMetrics = field(default_factory=BatchMetrics)


class LLMProvider(Protocol[TInput, TOutput]):
    """LLM provider interface -- implemented by real and mock providers."""

    async def process_batch(
        self, items: list[BatchItem[TInput]]
    ) -> dict[str, TOutput]:
        """Process a batch of items. Returns a mapping of item id -> output."""
        ...

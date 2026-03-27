"""
Request Batching Pattern

Groups individual LLM API calls into batches for throughput efficiency.
Handles concurrency control, partial-batch flushing, and per-item failure tracking.

Usage:
    processor = BatchProcessor(provider, BatchConfig(max_batch_size=20))
    result = await processor.process(items)
"""

from __future__ import annotations

import asyncio
import random
import time
from dataclasses import dataclass
from typing import Any, Generic, TypeVar

from .models import (
    BatchConfig,
    BatchItem,
    BatchItemError,
    BatchItemResult,
    BatchMetrics,
    BatchResult,
)

TInput = TypeVar("TInput")
TOutput = TypeVar("TOutput")

__all__ = [
    "BatchProcessor",
    "BatchConfig",
    "BatchItem",
    "BatchItemResult",
    "BatchItemError",
    "BatchMetrics",
    "BatchResult",
]

# Error messages that indicate a non-retryable failure.
_NON_RETRYABLE_MARKERS = frozenset(
    ["invalid input", "context length exceeded", "content policy", "non_retryable"]
)


def _is_non_retryable(err: Exception) -> bool:
    msg = str(err).lower()
    return any(marker in msg for marker in _NON_RETRYABLE_MARKERS)


@dataclass
class _Batch(Generic[TInput]):
    """Internal batch ready for execution."""

    id: str
    items: list[BatchItem[TInput]]
    attempt: int = 0


class BatchProcessor(Generic[TInput, TOutput]):
    """
    Process items through an LLM provider in batches with concurrency control,
    retry logic, and per-item failure tracking.
    """

    def __init__(
        self,
        provider: Any,  # LLMProvider[TInput, TOutput]
        config: BatchConfig | None = None,
    ) -> None:
        self._provider = provider
        self._config = config or BatchConfig()

    async def process(
        self, items: list[BatchItem[TInput]]
    ) -> BatchResult[TInput, TOutput]:
        """Main entry point: split items into batches and process them concurrently."""
        start = time.monotonic()

        batches = self._split_into_batches(items)
        results: list[BatchItemResult[TInput, TOutput]] = []
        failed: list[BatchItemError[TInput]] = []
        successful_batches = 0
        failed_batches = 0

        # Use a lock to safely accumulate results from concurrent tasks
        lock = asyncio.Lock()

        async def _run_one(batch: _Batch[TInput]) -> None:
            nonlocal successful_batches, failed_batches
            batch_out = await self._execute_batch_with_retry(batch)
            async with lock:
                results.extend(batch_out.results)
                failed.extend(batch_out.failed)
                if len(batch_out.failed) == len(batch.items):
                    failed_batches += 1
                else:
                    successful_batches += 1

        await self._run_with_concurrency(batches, _run_one)

        duration_ms = (time.monotonic() - start) * 1000
        metrics = BatchMetrics(
            total_items=len(items),
            total_batches=len(batches),
            successful_batches=successful_batches,
            failed_batches=failed_batches,
            avg_batch_size=len(items) / max(len(batches), 1),
            duration_ms=duration_ms,
            success_count=len(results),
            failure_count=len(failed),
        )
        return BatchResult(results=results, failed=failed, metrics=metrics)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _split_into_batches(
        self, items: list[BatchItem[TInput]]
    ) -> list[_Batch[TInput]]:
        """Split items into fixed-size batches. A final partial batch is always included."""
        size = self._config.max_batch_size
        batches: list[_Batch[TInput]] = []
        for i in range(0, len(items), size):
            batches.append(
                _Batch(
                    id=f"batch-{i // size}",
                    items=items[i : i + size],
                )
            )
        return batches

    async def _execute_batch_with_retry(
        self, batch: _Batch[TInput]
    ) -> BatchResult[TInput, TOutput]:
        """Execute a batch with exponential-backoff retry. Returns per-item results."""
        last_error: Exception | None = None
        cfg = self._config

        for attempt in range(cfg.retry_attempts + 1):
            try:
                if attempt > 0:
                    delay_ms = cfg.retry_delay_ms * (2 ** (attempt - 1))
                    jitter = random.random() * delay_ms * 0.2
                    await asyncio.sleep((delay_ms + jitter) / 1000)

                # Timeout scales with batch size
                timeout_s = (cfg.item_timeout_ms * len(batch.items)) / 1000
                result_map: dict[str, TOutput] = await asyncio.wait_for(
                    self._provider.process_batch(batch.items),
                    timeout=timeout_s,
                )

                results: list[BatchItemResult[TInput, TOutput]] = []
                failed: list[BatchItemError[TInput]] = []
                for item in batch.items:
                    if item.id in result_map:
                        results.append(
                            BatchItemResult(item=item, result=result_map[item.id])
                        )
                    else:
                        failed.append(
                            BatchItemError(
                                item=item,
                                error=RuntimeError(
                                    f"Item {item.id} missing from batch response"
                                ),
                            )
                        )
                return BatchResult(results=results, failed=failed)

            except Exception as exc:
                last_error = exc
                if _is_non_retryable(exc):
                    break

        # All retries exhausted
        return BatchResult(
            results=[],
            failed=[
                BatchItemError(
                    item=item,
                    error=last_error or RuntimeError("Unknown batch failure"),
                )
                for item in batch.items
            ],
        )

    async def _run_with_concurrency(
        self,
        items: list[_Batch[TInput]],
        fn: Any,
    ) -> None:
        """Run tasks with bounded concurrency using an asyncio.Semaphore."""
        sem = asyncio.Semaphore(self._config.max_concurrent_batches)

        async def _wrapper(item: _Batch[TInput]) -> None:
            async with sem:
                await fn(item)

        await asyncio.gather(*[_wrapper(b) for b in items])

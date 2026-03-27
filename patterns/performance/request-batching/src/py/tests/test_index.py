"""
Tests for the Request Batching pattern (Python implementation).

Covers:
- Unit: correct batch splitting
- Unit: partial batch flush on interval
- Unit: metrics accuracy
- Failure: retry with backoff
- Failure: per-item timeout
- Failure: rate limit recovery
- Integration: end-to-end with mock provider
"""

from __future__ import annotations

import asyncio
import time

import pytest
import pytest_asyncio

from .. import BatchConfig, BatchItem, BatchProcessor, BatchResult
from ..mock_provider import MockLLMProvider, MockProviderConfig


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_items(n: int) -> list[BatchItem[str]]:
    """Create n simple batch items."""
    return [BatchItem(id=f"item-{i}", data=f"data-{i}") for i in range(n)]


# ---------------------------------------------------------------------------
# Unit: correct batch splitting
# ---------------------------------------------------------------------------

class TestBatchSplitting:
    @pytest.mark.asyncio
    async def test_items_split_into_correct_batch_count(self) -> None:
        """50 items with batch size 20 -> 3 batches (20, 20, 10)."""
        provider = MockLLMProvider(MockProviderConfig(latency_ms=1, jitter_ms=0))
        processor: BatchProcessor[str, str] = BatchProcessor(
            provider, BatchConfig(max_batch_size=20, max_concurrent_batches=5)
        )
        result = await processor.process(make_items(50))

        assert result.metrics.total_batches == 3
        assert result.metrics.total_items == 50
        assert result.metrics.success_count == 50
        assert result.metrics.failure_count == 0

    @pytest.mark.asyncio
    async def test_single_item_produces_one_batch(self) -> None:
        provider = MockLLMProvider(MockProviderConfig(latency_ms=1, jitter_ms=0))
        processor: BatchProcessor[str, str] = BatchProcessor(
            provider, BatchConfig(max_batch_size=20)
        )
        result = await processor.process(make_items(1))

        assert result.metrics.total_batches == 1
        assert result.metrics.success_count == 1

    @pytest.mark.asyncio
    async def test_exact_batch_size_no_remainder(self) -> None:
        """40 items with batch size 20 -> exactly 2 batches."""
        provider = MockLLMProvider(MockProviderConfig(latency_ms=1, jitter_ms=0))
        processor: BatchProcessor[str, str] = BatchProcessor(
            provider, BatchConfig(max_batch_size=20)
        )
        result = await processor.process(make_items(40))

        assert result.metrics.total_batches == 2
        assert result.metrics.success_count == 40


# ---------------------------------------------------------------------------
# Unit: partial batch flush on interval
# ---------------------------------------------------------------------------

class TestPartialBatchFlush:
    @pytest.mark.asyncio
    async def test_partial_batch_is_processed(self) -> None:
        """A batch smaller than max_batch_size still gets processed."""
        provider = MockLLMProvider(MockProviderConfig(latency_ms=1, jitter_ms=0))
        processor: BatchProcessor[str, str] = BatchProcessor(
            provider, BatchConfig(max_batch_size=100, flush_interval_ms=10)
        )
        # Only 5 items -- well under the batch size of 100
        result = await processor.process(make_items(5))

        assert result.metrics.total_batches == 1
        assert result.metrics.success_count == 5
        assert result.metrics.avg_batch_size == 5.0


# ---------------------------------------------------------------------------
# Unit: metrics accuracy
# ---------------------------------------------------------------------------

class TestMetrics:
    @pytest.mark.asyncio
    async def test_metrics_reflect_actual_processing(self) -> None:
        provider = MockLLMProvider(MockProviderConfig(latency_ms=5, jitter_ms=0))
        processor: BatchProcessor[str, str] = BatchProcessor(
            provider,
            BatchConfig(max_batch_size=10, max_concurrent_batches=2),
        )
        result = await processor.process(make_items(25))

        m = result.metrics
        assert m.total_items == 25
        assert m.total_batches == 3  # 10 + 10 + 5
        assert m.success_count == 25
        assert m.failure_count == 0
        assert m.successful_batches == 3
        assert m.failed_batches == 0
        assert m.avg_batch_size == pytest.approx(25 / 3)
        assert m.duration_ms > 0

    @pytest.mark.asyncio
    async def test_empty_input_produces_zero_metrics(self) -> None:
        provider = MockLLMProvider(MockProviderConfig(latency_ms=1, jitter_ms=0))
        processor: BatchProcessor[str, str] = BatchProcessor(provider)
        result = await processor.process([])

        assert result.metrics.total_items == 0
        assert result.metrics.total_batches == 0
        assert result.metrics.success_count == 0


# ---------------------------------------------------------------------------
# Failure: retry with backoff
# ---------------------------------------------------------------------------

class TestRetryWithBackoff:
    @pytest.mark.asyncio
    async def test_retries_on_transient_error(self) -> None:
        """Provider that fails once then succeeds should recover via retry."""
        call_count = 0

        class FlakyProvider:
            async def process_batch(
                self, items: list[BatchItem[str]]
            ) -> dict[str, str]:
                nonlocal call_count
                call_count += 1
                if call_count == 1:
                    raise RuntimeError("Transient failure")
                return {item.id: f"ok:{item.id}" for item in items}

        processor: BatchProcessor[str, str] = BatchProcessor(
            FlakyProvider(),
            BatchConfig(
                max_batch_size=5,
                retry_attempts=2,
                retry_delay_ms=10,  # fast for tests
            ),
        )
        result = await processor.process(make_items(3))

        assert result.metrics.success_count == 3
        assert result.metrics.failure_count == 0
        assert call_count == 2  # one failure + one success

    @pytest.mark.asyncio
    async def test_exhausted_retries_report_failure(self) -> None:
        """Provider that always fails exhausts retries and reports all items as failed."""

        class AlwaysFailProvider:
            async def process_batch(
                self, items: list[BatchItem[str]]
            ) -> dict[str, str]:
                raise RuntimeError("Permanent failure")

        processor: BatchProcessor[str, str] = BatchProcessor(
            AlwaysFailProvider(),
            BatchConfig(
                max_batch_size=5,
                retry_attempts=2,
                retry_delay_ms=10,
            ),
        )
        result = await processor.process(make_items(3))

        assert result.metrics.success_count == 0
        assert result.metrics.failure_count == 3
        assert all("Permanent failure" in str(f.error) for f in result.failed)

    @pytest.mark.asyncio
    async def test_non_retryable_error_skips_retries(self) -> None:
        call_count = 0

        class BadInputProvider:
            async def process_batch(
                self, items: list[BatchItem[str]]
            ) -> dict[str, str]:
                nonlocal call_count
                call_count += 1
                raise ValueError("invalid input: bad format")

        processor: BatchProcessor[str, str] = BatchProcessor(
            BadInputProvider(),
            BatchConfig(max_batch_size=5, retry_attempts=3, retry_delay_ms=10),
        )
        result = await processor.process(make_items(2))

        assert result.metrics.failure_count == 2
        # Should only have called once (no retries for non-retryable)
        assert call_count == 1


# ---------------------------------------------------------------------------
# Failure: per-item timeout
# ---------------------------------------------------------------------------

class TestTimeout:
    @pytest.mark.asyncio
    async def test_batch_timeout_marks_items_failed(self) -> None:
        """A provider that hangs should time out and report items as failed."""

        class HangingProvider:
            async def process_batch(
                self, items: list[BatchItem[str]]
            ) -> dict[str, str]:
                await asyncio.sleep(10)  # hang for 10 seconds
                return {}

        processor: BatchProcessor[str, str] = BatchProcessor(
            HangingProvider(),
            BatchConfig(
                max_batch_size=5,
                item_timeout_ms=50,  # 50ms per item -> 150ms for 3 items
                retry_attempts=0,  # no retries to keep test fast
            ),
        )
        result = await processor.process(make_items(3))

        assert result.metrics.failure_count == 3
        assert result.metrics.success_count == 0


# ---------------------------------------------------------------------------
# Failure: rate limit recovery
# ---------------------------------------------------------------------------

class TestRateLimitRecovery:
    @pytest.mark.asyncio
    async def test_recovers_after_rate_limit(self) -> None:
        """Provider that rate-limits on first call then succeeds should recover."""
        call_count = 0

        class RateLimitOnceProvider:
            async def process_batch(
                self, items: list[BatchItem[str]]
            ) -> dict[str, str]:
                nonlocal call_count
                call_count += 1
                if call_count == 1:
                    raise RuntimeError("Rate limit exceeded")
                return {item.id: f"ok:{item.id}" for item in items}

        processor: BatchProcessor[str, str] = BatchProcessor(
            RateLimitOnceProvider(),
            BatchConfig(
                max_batch_size=10,
                retry_attempts=3,
                retry_delay_ms=10,
            ),
        )
        result = await processor.process(make_items(5))

        assert result.metrics.success_count == 5
        assert result.metrics.failure_count == 0
        assert call_count == 2


# ---------------------------------------------------------------------------
# Integration: end-to-end with mock provider
# ---------------------------------------------------------------------------

class TestIntegrationEndToEnd:
    @pytest.mark.asyncio
    async def test_full_pipeline_with_mock_provider(self) -> None:
        """Run a realistic workload through the mock provider."""
        provider = MockLLMProvider(
            MockProviderConfig(latency_ms=5, jitter_ms=2, error_rate=0, rate_limit_rate=0)
        )
        processor: BatchProcessor[str, str] = BatchProcessor(
            provider,
            BatchConfig(
                max_batch_size=10,
                max_concurrent_batches=3,
                retry_attempts=2,
                retry_delay_ms=10,
            ),
        )
        items = make_items(35)
        result = await processor.process(items)

        # All items should succeed
        assert result.metrics.success_count == 35
        assert result.metrics.failure_count == 0
        assert result.metrics.total_batches == 4  # 10+10+10+5

        # Verify each result maps back to its input
        result_ids = {r.item.id for r in result.results}
        input_ids = {item.id for item in items}
        assert result_ids == input_ids

        # Each result should have the expected mock response format
        for r in result.results:
            assert r.result == f"response:{r.item.id}"

    @pytest.mark.asyncio
    async def test_concurrency_is_bounded(self) -> None:
        """Verify that no more than max_concurrent_batches run at once."""
        peak_concurrent = 0
        current_concurrent = 0
        lock = asyncio.Lock()

        class TrackingProvider:
            async def process_batch(
                self, items: list[BatchItem[str]]
            ) -> dict[str, str]:
                nonlocal peak_concurrent, current_concurrent
                async with lock:
                    current_concurrent += 1
                    if current_concurrent > peak_concurrent:
                        peak_concurrent = current_concurrent
                await asyncio.sleep(0.02)
                async with lock:
                    current_concurrent -= 1
                return {item.id: f"ok:{item.id}" for item in items}

        processor: BatchProcessor[str, str] = BatchProcessor(
            TrackingProvider(),
            BatchConfig(
                max_batch_size=5,
                max_concurrent_batches=2,
            ),
        )
        await processor.process(make_items(25))  # 5 batches

        assert peak_concurrent <= 2

    @pytest.mark.asyncio
    async def test_custom_transform(self) -> None:
        """Mock provider with a custom transform function."""
        provider = MockLLMProvider(
            MockProviderConfig(latency_ms=1, jitter_ms=0),
            transform=lambda item: f"transformed:{item.data}",
        )
        processor: BatchProcessor[str, str] = BatchProcessor(
            provider, BatchConfig(max_batch_size=10)
        )
        result = await processor.process(make_items(3))

        assert result.metrics.success_count == 3
        for r in result.results:
            assert r.result.startswith("transformed:")

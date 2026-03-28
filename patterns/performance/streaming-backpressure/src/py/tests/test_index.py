"""
Tests for streaming_backpressure.pipe_with_backpressure.

Mirrors the TypeScript test suite: unit tests, failure mode tests, and
integration tests via stream_with_disconnect_detection.
"""

import asyncio
import pytest

from .. import pipe_with_backpressure, stream_with_disconnect_detection
from ..mock_provider import (
    MockProviderOptions,
    MockSlowConsumer,
    mock_llm_stream,
)
from ..types import BackpressureOptions


# ─── Helpers ────────────────────────────────────────────────────────────────

class FastSink:
    """Sink that never exerts backpressure — always has capacity."""

    def __init__(self) -> None:
        self.written: list[str] = []
        self.closed = False

    def write(self, chunk: str) -> None:
        self.written.append(chunk)

    def needs_drain(self) -> bool:
        return False

    async def drain(self) -> None:
        pass  # never called

    async def aclose(self) -> None:
        self.closed = True


# ─── Unit Tests ──────────────────────────────────────────────────────────────

class TestPipeWithBackpressureUnit:
    @pytest.mark.asyncio
    async def test_delivers_all_tokens_fast_source_fast_sink(self):
        source = mock_llm_stream(MockProviderOptions(token_count=20, token_delay=0))
        sink = FastSink()
        result = await pipe_with_backpressure(
            source, sink, BackpressureOptions(high_water_mark=4)
        )
        assert result.tokens_delivered == 20
        assert result.client_disconnected is False
        assert result.drain_timeout_expired is False
        assert len(sink.written) == 20

    @pytest.mark.asyncio
    async def test_default_high_water_mark(self):
        source = mock_llm_stream(MockProviderOptions(token_count=32, token_delay=0))
        sink = FastSink()
        result = await pipe_with_backpressure(source, sink)
        assert result.tokens_delivered == 32

    @pytest.mark.asyncio
    async def test_records_backpressure_and_drain_events(self):
        sink = MockSlowConsumer(buffer_capacity=3, drain_delay=0.005)
        source = mock_llm_stream(MockProviderOptions(token_count=30, token_delay=0))
        result = await pipe_with_backpressure(
            source, sink, BackpressureOptions(high_water_mark=4, drain_timeout=5.0)
        )
        assert result.backpressure_events > 0
        assert result.drain_events > 0
        assert result.drain_events == result.backpressure_events
        assert result.tokens_delivered == 30

    @pytest.mark.asyncio
    async def test_on_backpressure_callback(self):
        fired = []
        sink = MockSlowConsumer(buffer_capacity=2, drain_delay=0.005)
        source = mock_llm_stream(MockProviderOptions(token_count=20, token_delay=0))
        result = await pipe_with_backpressure(
            source,
            sink,
            BackpressureOptions(
                high_water_mark=3,
                drain_timeout=5.0,
                on_backpressure=lambda: fired.append(1),
            ),
        )
        assert len(fired) == result.backpressure_events

    @pytest.mark.asyncio
    async def test_on_drain_callback(self):
        fired = []
        sink = MockSlowConsumer(buffer_capacity=2, drain_delay=0.005)
        source = mock_llm_stream(MockProviderOptions(token_count=20, token_delay=0))
        result = await pipe_with_backpressure(
            source,
            sink,
            BackpressureOptions(
                high_water_mark=3,
                drain_timeout=5.0,
                on_drain=lambda: fired.append(1),
            ),
        )
        assert len(fired) == result.drain_events

    @pytest.mark.asyncio
    async def test_duration_ms_non_negative(self):
        source = mock_llm_stream(MockProviderOptions(token_count=5, token_delay=0))
        sink = FastSink()
        result = await pipe_with_backpressure(source, sink)
        assert result.duration_ms >= 0


# ─── Failure Mode Tests ───────────────────────────────────────────────────────

class TestPipeWithBackpressureFailureModes:
    # FM: Zombie stream — client disconnect cancels upstream
    @pytest.mark.asyncio
    async def test_stops_on_cancel_event(self):
        cancel_event = asyncio.Event()
        sink = FastSink()
        source = mock_llm_stream(
            MockProviderOptions(token_count=1000, token_delay=0.005),
            cancel_event=cancel_event,
        )
        # Cancel after 50ms
        async def do_cancel():
            await asyncio.sleep(0.05)
            cancel_event.set()

        cancel_task = asyncio.create_task(do_cancel())
        result = await pipe_with_backpressure(
            source, sink, BackpressureOptions(high_water_mark=4), cancel_event
        )
        await cancel_task

        assert result.client_disconnected is True
        assert result.tokens_delivered < 1000

    # FM: Drain starvation — drain timeout aborts stream
    @pytest.mark.asyncio
    async def test_drain_timeout_sets_flag_and_aborts(self):
        # Drain delay of 60s → will always time out with 0.05s timeout
        sink = MockSlowConsumer(buffer_capacity=1, drain_delay=60.0)
        source = mock_llm_stream(MockProviderOptions(token_count=50, token_delay=0))

        result = await pipe_with_backpressure(
            source, sink, BackpressureOptions(high_water_mark=2, drain_timeout=0.05)
        )

        assert result.drain_timeout_expired is True
        assert result.tokens_delivered < 50

    # FM: Silent degradation — ratio metric is observable
    @pytest.mark.asyncio
    async def test_exposes_backpressure_ratio_for_monitoring(self):
        sink = MockSlowConsumer(buffer_capacity=4, drain_delay=0.01)
        source = mock_llm_stream(MockProviderOptions(token_count=100, token_delay=0))

        result = await pipe_with_backpressure(
            source, sink, BackpressureOptions(high_water_mark=8, drain_timeout=5.0)
        )

        ratio = result.backpressure_events / result.tokens_delivered if result.tokens_delivered else 0
        assert isinstance(ratio, float)
        assert result.tokens_delivered == 100

    # FM: Token loss on abort — partial delivery is observable
    @pytest.mark.asyncio
    async def test_partial_delivery_observable_via_tokens_delivered(self):
        cancel_event = asyncio.Event()
        sink = FastSink()
        source = mock_llm_stream(
            MockProviderOptions(token_count=500, token_delay=0.002),
            cancel_event=cancel_event,
        )

        async def cancel_after():
            await asyncio.sleep(0.03)
            cancel_event.set()

        cancel_task = asyncio.create_task(cancel_after())
        result = await pipe_with_backpressure(source, sink, cancel_event=cancel_event)
        await cancel_task

        assert result.tokens_delivered < 500

    # FM: highWaterMark larger than stream — flush at end, no backpressure
    @pytest.mark.asyncio
    async def test_no_backpressure_when_hwm_exceeds_token_count(self):
        source = mock_llm_stream(MockProviderOptions(token_count=10, token_delay=0))
        sink = FastSink()
        result = await pipe_with_backpressure(
            source, sink, BackpressureOptions(high_water_mark=100)
        )
        assert result.tokens_delivered == 10
        assert result.backpressure_events == 0


# ─── Integration Tests ───────────────────────────────────────────────────────

class TestStreamWithDisconnectDetection:
    @pytest.mark.asyncio
    async def test_full_stream_completes_when_no_disconnect(self):
        source = mock_llm_stream(MockProviderOptions(token_count=40, token_delay=0))
        sink = FastSink()

        # is_disconnected coroutine that never fires
        async def never_disconnect():
            await asyncio.sleep(999)
            return False

        result = await stream_with_disconnect_detection(
            source,
            sink,
            never_disconnect(),
            BackpressureOptions(high_water_mark=8),
        )

        assert result.tokens_delivered == 40
        assert result.client_disconnected is False

    @pytest.mark.asyncio
    async def test_cancels_upstream_when_disconnect_fires(self):
        source = mock_llm_stream(MockProviderOptions(token_count=500, token_delay=0.005))
        sink = FastSink()

        # Simulates request.is_disconnected() returning True after 50ms
        async def disconnect_after_50ms():
            await asyncio.sleep(0.05)
            return True

        result = await stream_with_disconnect_detection(
            source,
            sink,
            disconnect_after_50ms(),
            BackpressureOptions(high_water_mark=4),
        )

        assert result.client_disconnected is True
        assert result.tokens_delivered < 500

    @pytest.mark.asyncio
    async def test_slow_consumer_with_backpressure_delivers_all_tokens(self):
        sink = MockSlowConsumer(buffer_capacity=8, drain_delay=0.015)
        source = mock_llm_stream(MockProviderOptions(token_count=80, token_delay=0))

        async def never_disconnect():
            await asyncio.sleep(999)
            return False

        result = await stream_with_disconnect_detection(
            source,
            sink,
            never_disconnect(),
            BackpressureOptions(high_water_mark=10, drain_timeout=5.0),
        )

        assert result.tokens_delivered == 80
        assert result.backpressure_events > 0
        assert result.client_disconnected is False

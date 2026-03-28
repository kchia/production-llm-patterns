"""
Streaming Backpressure — Python implementation.

Pipes a token-producing AsyncIterable to a writable sink while cooperating
with asyncio's flow-control protocol (drain()) and cancelling upstream
inference on client disconnect.

Framework-agnostic: works with any AsyncIterator source and any object
that implements the write()/drain()/needs_drain() interface (asyncio
StreamWriter, mock sinks, etc.).

Key difference from Node.js: Python asyncio uses an explicit drain()
coroutine rather than an event + write() return value. Callers must
await drain() when the transport's buffer is full; skipping it disables
the backpressure mechanism entirely.

Reference: https://lucumr.pocoo.org/2020/1/1/async-pressure/
"""

import asyncio
import time
from contextlib import suppress
from typing import AsyncIterable, Optional, Protocol, runtime_checkable

from .types import BackpressureOptions, StreamResult


@runtime_checkable
class WritableSink(Protocol):
    """
    Minimal protocol for a writable sink that supports asyncio-style backpressure.

    Compatible with asyncio.StreamWriter and MockSlowConsumer.
    """

    def write(self, chunk: str) -> None: ...
    def needs_drain(self) -> bool: ...
    async def drain(self) -> None: ...
    async def aclose(self) -> None: ...


async def pipe_with_backpressure(
    source: AsyncIterable[str],
    sink: WritableSink,
    options: Optional[BackpressureOptions] = None,
    cancel_event: Optional[asyncio.Event] = None,
) -> StreamResult:
    """
    Pipe a token stream from an LLM to a client sink with full backpressure.

    Key behaviors:
    - Buffers up to high_water_mark tokens before flushing to the sink
    - Calls await sink.drain() when the sink signals it needs draining
    - Aborts on drain_timeout (slow/dead clients don't hold resources indefinitely)
    - Stops iteration when cancel_event is set (client disconnect)

    Args:
        source:       AsyncIterable of string tokens (from LLM or mock)
        sink:         Writable target implementing the WritableSink protocol
        options:      Configuration for buffer limits, timeouts, callbacks
        cancel_event: asyncio.Event set by disconnect detection to stop iteration
    """
    if options is None:
        options = BackpressureOptions()

    result = StreamResult()
    start = time.monotonic()
    buffer: list[str] = []

    async def flush() -> bool:
        """
        Write buffered tokens to the sink.
        Returns False if drain timed out or cancellation occurred.
        """
        nonlocal buffer
        for token in buffer:
            if cancel_event is not None and cancel_event.is_set():
                result.client_disconnected = True
                return False

            sink.write(token)
            result.tokens_delivered += 1

            if sink.needs_drain():
                # Sink buffer full: await drain with timeout
                result.backpressure_events += 1
                if options.on_backpressure:
                    options.on_backpressure()

                try:
                    await asyncio.wait_for(sink.drain(), timeout=options.drain_timeout)
                except asyncio.TimeoutError:
                    result.drain_timeout_expired = True
                    return False

                result.drain_events += 1
                if options.on_drain:
                    options.on_drain()

        buffer = []
        return True

    try:
        async for token in source:
            if cancel_event is not None and cancel_event.is_set():
                result.client_disconnected = True
                break

            buffer.append(token)

            if len(buffer) >= options.high_water_mark:
                ok = await flush()
                if not ok:
                    break

        # Flush remaining tokens after source exhausts
        if (
            not result.client_disconnected
            and not result.drain_timeout_expired
            and buffer
        ):
            await flush()

    finally:
        result.duration_ms = (time.monotonic() - start) * 1000
        await sink.aclose()

    return result


async def stream_with_disconnect_detection(
    source: AsyncIterable[str],
    sink: WritableSink,
    request_is_disconnected: asyncio.Coroutine,
    options: Optional[BackpressureOptions] = None,
) -> StreamResult:
    """
    Wrap pipe_with_backpressure with disconnect detection.

    In a Starlette/FastAPI handler, pass `await request.is_disconnected()`
    as a polling coroutine. The disconnect poller runs concurrently and sets
    a cancel_event when the client drops, stopping the upstream generator.

    Usage:
        async def streaming_endpoint(request: Request):
            result = await stream_with_disconnect_detection(
                llm_stream,
                response_sink,
                request.is_disconnected(),
            )
    """
    cancel_event = asyncio.Event()

    async def poll_disconnect() -> None:
        """
        Poll for client disconnect. Sets cancel_event when disconnected.

        request.is_disconnected() is a Starlette/ASGI idiom.
        The call blocks until disconnect or until the task is cancelled.
        """
        with suppress(asyncio.CancelledError):
            disconnected = await request_is_disconnected
            if disconnected:
                cancel_event.set()

    poll_task = asyncio.create_task(poll_disconnect())

    try:
        return await pipe_with_backpressure(source, sink, options, cancel_event)
    finally:
        poll_task.cancel()
        with suppress(asyncio.CancelledError):
            await poll_task

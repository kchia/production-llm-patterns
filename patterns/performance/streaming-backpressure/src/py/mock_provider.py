"""
Mock LLM provider for testing and benchmarks.

Simulates realistic streaming behavior: configurable token rate, latency,
and error injection — no real API calls required.
"""

import asyncio
from dataclasses import dataclass, field
from typing import AsyncGenerator, Callable, List, Optional


@dataclass
class MockProviderOptions:
    """Configuration for the mock LLM streaming provider."""

    # Tokens to emit per stream call. Default 100.
    token_count: int = 100

    # Delay between tokens in seconds. Default 0.01s (~100 tokens/sec).
    token_delay: float = 0.01

    # If set, raise an error after emitting this many tokens.
    error_after_tokens: Optional[int] = None

    # Content of each emitted token. Default 'token '.
    token_content: str = "token "


async def mock_llm_stream(
    options: Optional[MockProviderOptions] = None,
    cancel_event: Optional[asyncio.Event] = None,
) -> AsyncGenerator[str, None]:
    """
    Simulate an LLM streaming response as an async generator.

    Honors cancel_event — stops generation when set, which is what real
    LLM clients should do when the client disconnects.
    """
    if options is None:
        options = MockProviderOptions()

    for i in range(options.token_count):
        if cancel_event is not None and cancel_event.is_set():
            return  # upstream cancellation

        if options.error_after_tokens is not None and i >= options.error_after_tokens:
            raise RuntimeError(f"MockProvider: injected error at token {i}")

        yield options.token_content

        if options.token_delay > 0:
            try:
                if cancel_event is not None:
                    # Sleep but wake early if cancelled
                    await asyncio.wait_for(
                        asyncio.shield(cancel_event.wait()),
                        timeout=options.token_delay,
                    )
                    # If we got here, cancel_event was set during the sleep
                    return
                else:
                    await asyncio.sleep(options.token_delay)
            except asyncio.TimeoutError:
                pass  # Normal case: token_delay elapsed, continue generating


class MockSlowConsumer:
    """
    Simulates a slow client sink for testing backpressure behavior.

    Mimics asyncio.StreamWriter: write() accepts data, drain() is a coroutine
    that resolves after a simulated delay when the buffer is full.

    Unlike asyncio.StreamWriter, this class makes backpressure explicit:
    needs_drain() returns True when the internal buffer has reached capacity,
    prompting the caller to await drain() before writing more.
    """

    def __init__(self, buffer_capacity: int = 5, drain_delay: float = 0.02):
        self._buffer_capacity = buffer_capacity
        self._drain_delay = drain_delay
        self._buffer: List[str] = []
        self.written: List[str] = []
        self.drain_count: int = 0

    def write(self, chunk: str) -> None:
        """Accept a chunk. Call needs_drain() to check if drain is required."""
        self._buffer.append(chunk)
        self.written.append(chunk)

    def needs_drain(self) -> bool:
        """True when the buffer has reached capacity — caller should await drain()."""
        return len(self._buffer) >= self._buffer_capacity

    async def drain(self) -> None:
        """
        Simulate slow consumer processing: wait drain_delay, then clear buffer.

        This is the Python equivalent of waiting for the 'drain' event in Node.js.
        The caller must await this when needs_drain() returns True.
        """
        await asyncio.sleep(self._drain_delay)
        self._buffer.clear()
        self.drain_count += 1

    async def aclose(self) -> None:
        """Close the sink — no-op for mock."""
        pass

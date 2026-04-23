"""
test-fixtures — Core Implementation (Python)

Exports:
  MockProvider          — mock LLM with latency, failure rate, error sequences
  ProviderError         — typed provider error (re-exported from types)
  create_static_handler   — always returns the same response
  create_cache_handler    — prompt-keyed in-memory cache handler
  create_rule_based_handler — regex-matched rule handler
  create_sequence_provider  — cycles through a fixed list of responses
  mock_llm_stream         — async generator simulating token streaming
  MockSlowConsumer        — writable sink with configurable backpressure

Every pattern's mock_provider.py duplicated a subset of this. Import from
here — one canonical implementation, same behavior across all 35 patterns.
"""

from __future__ import annotations

import asyncio
import math
import random
import re
import time
from dataclasses import dataclass, field
from typing import (
    AsyncGenerator,
    Callable,
    Dict,
    List,
    Optional,
    Pattern,
    Tuple,
)

from .types import (
    LLMRequest,
    LLMResponse,
    MockProviderConfig,
    MockStreamOptions,
    ProviderError,
)

__all__ = [
    "MockProvider",
    "ProviderError",
    "LLMRequest",
    "LLMResponse",
    "MockProviderConfig",
    "MockStreamOptions",
    "create_static_handler",
    "create_cache_handler",
    "create_rule_based_handler",
    "create_sequence_provider",
    "mock_llm_stream",
    "MockSlowConsumer",
]


# ─── MockProvider ─────────────────────────────────────────────────────────────


class MockProvider:
    """
    Mock LLM provider with configurable latency, token counts, and error injection.

    Design decisions:
    - Deterministic error_sequence takes priority over probabilistic failure_rate.
      This lets tests script exact failure patterns without relying on random().
    - retry_after_ms only attaches to 429 errors, matching real provider behavior.
    - latency_ms=0 skips the sleep entirely — avoids overhead in tight loops.
    """

    def __init__(self, config: Optional[MockProviderConfig] = None) -> None:
        self._config = config or MockProviderConfig()
        self._call_count = 0
        self._sequence_index = 0

    async def call(self, request: LLMRequest) -> LLMResponse:
        self._call_count += 1
        start = time.perf_counter()

        if self._config.latency_ms > 0:
            await asyncio.sleep(self._config.latency_ms / 1000.0)

        # Deterministic sequence takes priority over probabilistic failure
        if self._sequence_index < len(self._config.error_sequence):
            outcome = self._config.error_sequence[self._sequence_index]
            self._sequence_index += 1
            if outcome != "success":
                self._raise_provider_error(int(outcome))
            # 'success' falls through to the response below
        elif random.random() < self._config.failure_rate:
            self._raise_provider_error(self._config.failure_status_code)

        latency_ms = (time.perf_counter() - start) * 1000
        content = self._config.response_content or (
            f"Mock response for: {request.prompt[:50]}"
        )

        return LLMResponse(
            content=content,
            tokens_used=self._config.tokens_per_response,
            model=self._config.model,
            finish_reason="stop",
            latency_ms=latency_ms,
        )

    def _raise_provider_error(self, status_code: int) -> None:
        retry_after_ms = (
            self._config.retry_after_ms
            if status_code == 429 and self._config.retry_after_ms > 0
            else None
        )
        raise ProviderError(
            self._config.error_message,
            status_code,
            retry_after_ms=retry_after_ms,
        )

    @property
    def call_count(self) -> int:
        """Total calls made to this provider (including failures)."""
        return self._call_count

    def reset(self) -> None:
        """Resets call counter and error sequence index. Safe to call between tests."""
        self._call_count = 0
        self._sequence_index = 0

    def update_config(self, **kwargs) -> None:
        """
        Applies partial config updates mid-test without constructing a new provider.

        Accepts the same keyword arguments as MockProviderConfig fields.
        If error_sequence is updated, the sequence index resets to 0.
        """
        for key, value in kwargs.items():
            if not hasattr(self._config, key):
                raise ValueError(f"Unknown config field: {key!r}")
            setattr(self._config, key, value)

        # Reset sequence index when sequence is replaced
        if "error_sequence" in kwargs:
            self._sequence_index = 0


# ─── Handler Factories ────────────────────────────────────────────────────────


def create_static_handler(content: str) -> Callable[[LLMRequest], LLMResponse]:
    """
    A handler that always returns the same response content.
    Zero latency, zero dependencies — the last resort in degradation chains.
    """

    async def handler(_request: LLMRequest) -> LLMResponse:
        return LLMResponse(
            content=content,
            model="static",
            finish_reason="static_fallback",
        )

    return handler


def create_cache_handler():
    """
    A simple prompt-keyed in-memory cache handler.

    Returns a cache-miss error when the prompt hasn't been populated.
    Use populate(prompt, content) in test setup to seed it.

    Returns a dict with keys: handler, populate, clear, size (property).
    """
    cache: Dict[str, Tuple[str, float]] = {}  # prompt → (content, cached_at)

    async def handler(request: LLMRequest) -> LLMResponse:
        entry = cache.get(request.prompt)
        if entry is None:
            raise ValueError("Cache miss")
        return LLMResponse(
            content=entry[0],
            model="cache",
            finish_reason="cache_hit",
        )

    def populate(prompt: str, content: str) -> None:
        cache[prompt] = (content, time.time())

    def clear() -> None:
        cache.clear()

    def size() -> int:
        return len(cache)

    return {
        "handler": handler,
        "populate": populate,
        "clear": clear,
        "size": size,
    }


def create_rule_based_handler(
    rules: List[Tuple[re.Pattern, str]],
) -> Callable[[LLMRequest], LLMResponse]:
    """
    A rule-based handler that matches prompts against regex patterns.

    Rules are evaluated in order — first match wins. Raises on no match.
    Useful for testing degradation chains where a rule tier handles predictable
    intents without a real LLM call.

    rules: list of (compiled_pattern, response_content) tuples.
    """

    async def handler(request: LLMRequest) -> LLMResponse:
        for pattern, response in rules:
            if pattern.search(request.prompt):
                return LLMResponse(
                    content=response,
                    model="rule-based",
                    finish_reason="rule_match",
                )
        raise ValueError("No matching rule")

    return handler


def create_sequence_provider(
    responses: List[str],
    latency_ms: int = 0,
    model: str = "sequence-mock",
):
    """
    Creates a provider that returns responses from a fixed list, in order.
    After the list is exhausted, it cycles back to the beginning.

    Useful for testing multi-turn flows, A/B comparisons, and scenarios where
    you need the Nth call to return a specific response.

    Returns an object with: call (coroutine), call_index (property), reset.
    """
    if not responses:
        raise ValueError("responses must be non-empty")

    state = {"index": 0}

    async def call(_request: LLMRequest) -> LLMResponse:
        if latency_ms > 0:
            await asyncio.sleep(latency_ms / 1000.0)
        content = responses[state["index"] % len(responses)]
        state["index"] += 1
        return LLMResponse(content=content, model=model, finish_reason="stop")

    def get_call_index() -> int:
        return state["index"]

    def reset() -> None:
        state["index"] = 0

    class SequenceProvider:
        async def call(self, request: LLMRequest) -> LLMResponse:
            return await call(request)

        @property
        def call_index(self) -> int:
            return get_call_index()

        def reset(self) -> None:
            reset()

    return SequenceProvider()


# ─── Streaming Mocks ──────────────────────────────────────────────────────────


async def mock_llm_stream(
    options: Optional[MockStreamOptions] = None,
    stop_event: Optional[asyncio.Event] = None,
) -> AsyncGenerator[str, None]:
    """
    Async generator that simulates an LLM streaming response.

    Honors the provided asyncio.Event — stops early on cancellation, matching
    what real LLM clients do when the downstream consumer disconnects.

    error_after_tokens injects a mid-stream error, which tests backpressure
    handlers and partial-content recovery logic.
    """
    opts = options or MockStreamOptions()
    token_count = opts.token_count
    token_delay_ms = opts.token_delay_ms
    error_after_tokens = opts.error_after_tokens
    token_content = opts.token_content

    for i in range(token_count):
        if stop_event is not None and stop_event.is_set():
            return

        if error_after_tokens is not None and i >= error_after_tokens:
            raise RuntimeError(f"mock_llm_stream: injected error at token {i}")

        yield token_content

        if token_delay_ms > 0:
            try:
                await asyncio.sleep(token_delay_ms / 1000.0)
            except asyncio.CancelledError:
                return


class MockSlowConsumer:
    """
    Writable sink that simulates a slow downstream consumer with backpressure.

    write() returns False (backpressure) when the internal buffer reaches
    capacity. After a configurable drain delay, it fires drain callbacks so
    producers know they can resume. Mirrors the pattern of Node.js Writable streams.
    """

    def __init__(self, buffer_capacity: int = 5, drain_delay_ms: float = 20) -> None:
        self._buffer_capacity = buffer_capacity
        self._drain_delay_ms = drain_delay_ms
        self._buffer: List[str] = []
        self._draining = False
        self._drain_callbacks: List[Callable[[], None]] = []
        self.written: List[str] = []
        self.drain_count = 0

    def write(self, chunk: str) -> bool:
        """Returns False when the buffer is full — caller must wait for drain."""
        self._buffer.append(chunk)
        self.written.append(chunk)

        if not self._draining and len(self._buffer) >= self._buffer_capacity:
            self._draining = True
            asyncio.get_event_loop().call_later(
                self._drain_delay_ms / 1000.0,
                self._do_drain,
            )
            return False

        return True

    def _do_drain(self) -> None:
        self._buffer = []
        self._draining = False
        self.drain_count += 1
        callbacks = self._drain_callbacks[:]
        self._drain_callbacks.clear()
        for cb in callbacks:
            cb()

    def on_drain(self, callback: Callable[[], None]) -> None:
        """Register a callback to fire when the buffer drains."""
        self._drain_callbacks.append(callback)

    def end(self) -> None:
        """No-op for mock — mirrors the Node.js stream interface."""

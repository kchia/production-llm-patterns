"""
Graceful Degradation — Mock LLM Provider

Simulates an LLM provider with configurable latency, error rates,
and token counts. Used for testing and benchmarks — no API keys needed.
"""

from __future__ import annotations

import asyncio
import random
import re
from dataclasses import dataclass, field

from .types import LLMRequest, LLMResponse


@dataclass
class MockProvider:
    """Mock LLM provider with configurable behavior."""

    latency_ms: float = 50.0
    failure_rate: float = 0.0
    error_message: str = "Provider unavailable"
    tokens_per_response: int = 100
    model_name: str = "mock-model"
    response_content: str = ""
    _call_count: int = field(default=0, init=False, repr=False)

    async def call(self, request: LLMRequest) -> LLMResponse:
        self._call_count += 1

        if self.latency_ms > 0:
            await asyncio.sleep(self.latency_ms / 1000)

        if random.random() < self.failure_rate:
            raise RuntimeError(self.error_message)

        content = self.response_content or f"Mock response for: {request.prompt[:50]}"

        return LLMResponse(
            content=content,
            tokens_used=self.tokens_per_response,
            model=self.model_name,
            finish_reason="stop",
        )

    @property
    def call_count(self) -> int:
        return self._call_count

    def reset_call_count(self) -> None:
        self._call_count = 0


class CacheHandler:
    """Simple cache-based handler. Returns cached content if the prompt has been seen."""

    def __init__(self) -> None:
        self._cache: dict[str, dict[str, object]] = {}

    async def handler(self, request: LLMRequest) -> LLMResponse:
        entry = self._cache.get(request.prompt)
        if entry is None:
            raise RuntimeError("Cache miss")
        return LLMResponse(
            content=str(entry["content"]),
            model="cache",
            finish_reason="cache_hit",
        )

    def populate(self, prompt: str, content: str) -> None:
        self._cache[prompt] = {"content": content}

    def clear(self) -> None:
        self._cache.clear()

    @property
    def size(self) -> int:
        return len(self._cache)


def create_cache_handler() -> CacheHandler:
    """Creates a simple cache-based handler."""
    return CacheHandler()


def create_rule_based_handler(
    rules: list[tuple[re.Pattern[str], str]],  # compiled regex avoids recompilation per call
):
    """Creates a rule-based handler that matches prompts against regex patterns."""

    async def handler(request: LLMRequest) -> LLMResponse:
        for pattern, response_text in rules:
            if pattern.search(request.prompt):
                return LLMResponse(
                    content=response_text,
                    model="rule-based",
                    finish_reason="rule_match",
                )
        raise RuntimeError("No matching rule")

    return handler


def create_static_handler(content: str):
    """Creates a static handler that always returns the same response.
    Zero dependencies, zero I/O — the last resort.
    """

    async def handler(_request: LLMRequest) -> LLMResponse:
        return LLMResponse(
            content=content,
            model="static",
            finish_reason="static_fallback",
        )

    return handler

"""
Mock LLM Provider for Request Batching

Simulates an LLM API with configurable latency, token counts, and error injection.
Used for tests and benchmarks -- no real API calls.
"""

from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass, field
from typing import Any, Callable, Generic, TypeVar

from .models import BatchItem

TInput = TypeVar("TInput")
TOutput = TypeVar("TOutput")


@dataclass
class MockProviderConfig:
    """Configuration for the mock LLM provider."""

    latency_ms: float = 50
    """Base latency per batch (ms)."""

    jitter_ms: float = 10
    """Additional latency variance (ms)."""

    error_rate: float = 0.0
    """Fraction of batches that fail with an error (0-1)."""

    rate_limit_rate: float = 0.0
    """Fraction of batches that fail with a 429 rate limit error (0-1)."""

    tokens_per_item_input: int = 100
    """Simulated tokens per item (input)."""

    tokens_per_item_output: int = 50
    """Simulated tokens per item (output)."""

    slow_item_pattern: str | None = None
    """If set, items whose id contains this pattern respond slowly."""

    slow_item_latency_ms: float = 5000
    """Latency for slow items (ms)."""


class RateLimitError(Exception):
    """Raised when the mock provider simulates a rate limit."""

    pass


class MockLLMProvider(Generic[TInput, TOutput]):
    """Mock LLM provider that simulates real API behavior."""

    def __init__(
        self,
        config: MockProviderConfig | None = None,
        transform: Callable[[BatchItem[TInput]], TOutput] | None = None,
    ) -> None:
        self.config = config or MockProviderConfig()
        self._transform = transform
        self._call_count = 0
        self._rate_limit_streak = 0

    async def process_batch(
        self, items: list[BatchItem[TInput]]
    ) -> dict[str, TOutput]:
        self._call_count += 1

        # Simulate rate limit (before latency so callers see it quickly)
        if random.random() < self.config.rate_limit_rate:
            self._rate_limit_streak += 1
            raise RateLimitError(
                f"Rate limit exceeded (call {self._call_count})"
            )
        self._rate_limit_streak = 0

        # Simulate generic error
        if random.random() < self.config.error_rate:
            raise RuntimeError(
                f"Provider error on batch (call {self._call_count})"
            )

        # Apply base latency + jitter
        latency = self.config.latency_ms + random.random() * self.config.jitter_ms
        await asyncio.sleep(latency / 1000)

        results: dict[str, TOutput] = {}
        for item in items:
            # Slow item simulation
            if (
                self.config.slow_item_pattern
                and self.config.slow_item_pattern in item.id
            ):
                await asyncio.sleep(self.config.slow_item_latency_ms / 1000)

            if self._transform:
                output = self._transform(item)
            else:
                output = f"response:{item.id}"  # type: ignore[assignment]
            results[item.id] = output

        return results

    @property
    def call_count(self) -> int:
        return self._call_count

    def reset(self) -> None:
        self._call_count = 0
        self._rate_limit_streak = 0

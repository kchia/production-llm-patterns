"""
Mock LLM Provider — Cost Dashboard

asyncio-native mock that simulates provider responses with configurable
latency, token counts, and error injection.
"""

from __future__ import annotations

import asyncio
import math
import random
from dataclasses import dataclass
from typing import Optional


@dataclass
class MockResponse:
    content: str
    model: str
    input_tokens: int
    output_tokens: int
    latency_ms: int

    @property
    def usage(self) -> dict[str, int]:
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "total_tokens": self.input_tokens + self.output_tokens,
        }


class MockProvider:
    """
    Simulates an LLM provider for tests and benchmarks.
    All configuration is set at construction; individual calls are stateless.
    """

    def __init__(
        self,
        base_latency_ms: int = 200,
        jitter_ms: int = 50,
        input_tokens: int = 0,       # 0 = derive from prompt length
        output_tokens: int = 150,
        error_rate: float = 0.0,
        error_message: str = "Mock provider error",
        model_override: Optional[str] = None,
    ) -> None:
        self.base_latency_ms = base_latency_ms
        self.jitter_ms = jitter_ms
        self._fixed_input_tokens = input_tokens
        self._output_tokens = output_tokens
        self.error_rate = error_rate
        self.error_message = error_message
        self.model_override = model_override
        self._request_count = 0

    async def complete(self, prompt: str, model: str = "gpt-4o") -> MockResponse:
        self._request_count += 1

        # Simulate latency
        jitter = (random.random() * 2 - 1) * self.jitter_ms
        latency_ms = max(0, self.base_latency_ms + jitter)
        await asyncio.sleep(latency_ms / 1000)

        if random.random() < self.error_rate:
            raise RuntimeError(self.error_message)

        # ~4 chars/token is a reasonable heuristic for English text
        input_tokens = (
            self._fixed_input_tokens
            if self._fixed_input_tokens > 0
            else math.ceil(len(prompt) / 4)
        )

        return MockResponse(
            content=f"Mock response to: {prompt[:50]}...",
            model=self.model_override or model,
            input_tokens=input_tokens,
            output_tokens=self._output_tokens,
            latency_ms=int(latency_ms),
        )

    @property
    def request_count(self) -> int:
        return self._request_count

    def reset(self) -> None:
        self._request_count = 0

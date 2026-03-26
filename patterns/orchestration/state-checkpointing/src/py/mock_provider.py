from __future__ import annotations

import asyncio
import random
import time
from dataclasses import dataclass, field
from typing import Any

from .types import LLMResponse


@dataclass
class MockProviderConfig:
    latency_s: float = 0.1
    latency_jitter_s: float = 0.02
    input_tokens_per_char: float = 0.25
    output_tokens: int = 150
    error_rate: float = 0.0
    error_message: str = "Mock provider error"
    responses: list[str] = field(default_factory=list)


class MockLLMProvider:
    """
    Mock LLM provider for testing and benchmarks.
    Simulates realistic latency, token counts, and error injection
    without making real API calls.
    """

    def __init__(self, config: MockProviderConfig | None = None) -> None:
        self._config = config or MockProviderConfig()
        self._call_count = 0

    async def complete(self, prompt: str, **_kwargs: Any) -> LLMResponse:
        start = time.monotonic()

        jitter = random.random() * self._config.latency_jitter_s
        await asyncio.sleep(self._config.latency_s + jitter)

        if random.random() < self._config.error_rate:
            raise RuntimeError(self._config.error_message)

        content = self._next_response(prompt)
        latency_s = time.monotonic() - start
        self._call_count += 1

        return LLMResponse(
            content=content,
            input_tokens=int(len(prompt) * self._config.input_tokens_per_char),
            output_tokens=self._config.output_tokens,
            latency_s=latency_s,
        )

    def _next_response(self, prompt: str) -> str:
        if not self._config.responses:
            return f"Mock response for: {prompt[:50]}"
        idx = min(self._call_count, len(self._config.responses) - 1)
        return self._config.responses[idx]

    @property
    def total_calls(self) -> int:
        return self._call_count

    def reset(self) -> None:
        self._call_count = 0

"""
Mock LLM provider for testing and benchmarks.
Configurable latency, token counts, error injection, and quality simulation.
"""

from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass, field
from typing import Protocol


class LLMProvider(Protocol):
    async def complete(
        self, prompt: str, input_text: str
    ) -> dict[str, int | float | str]:
        """Returns dict with keys: output, input_tokens, output_tokens, latency_ms."""
        ...


@dataclass
class MockProviderConfig:
    base_latency_ms: float = 200.0
    latency_jitter_ms: float = 50.0
    avg_input_tokens: int = 150
    avg_output_tokens: int = 100
    error_rate: float = 0.0
    error_message: str = "Provider error"
    quality_bias: float = 1.0
    # Simulates a prompt regression that adds preamble text before structured output
    preamble: str = ""


class MockLLMProvider:
    def __init__(self, config: MockProviderConfig | None = None) -> None:
        self._config = config or MockProviderConfig()
        self._call_count = 0

    async def complete(
        self, prompt: str, input_text: str
    ) -> dict[str, int | float | str]:
        self._call_count += 1

        # Simulate latency. When base_latency_ms is 0, skip the sleep entirely
        # so benchmarks can measure pattern overhead without async event loop noise.
        jitter = (random.random() - 0.5) * 2 * self._config.latency_jitter_ms
        latency = max(0.0, self._config.base_latency_ms + jitter)
        if latency > 0:
            await asyncio.sleep(latency / 1000)

        # Inject errors
        if random.random() < self._config.error_rate:
            raise RuntimeError(self._config.error_message)

        # Token count with ±20% variation
        input_tokens = round(self._config.avg_input_tokens * (0.8 + random.random() * 0.4))
        output_tokens = round(self._config.avg_output_tokens * (0.8 + random.random() * 0.4))

        output = _generate_output(prompt, input_text)
        if self._config.preamble:
            output = f"{self._config.preamble}\n{output}"

        return {
            "output": output,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "latency_ms": latency,
        }

    @property
    def call_count(self) -> int:
        return self._call_count

    def reset(self) -> None:
        self._call_count = 0


def _generate_output(prompt: str, input_text: str) -> str:
    return f"Response to: {input_text[:40]} [prompt hash: {_hash_str(prompt)}]"


def _hash_str(s: str) -> int:
    h = 0
    for ch in s:
        h = (31 * h + ord(ch)) & 0xFFFFFFFF
    return h % 10000

"""Mock LLM provider for testing and benchmarks.

Simulates realistic LLM behavior with configurable latency,
token counts, and error injection.
"""

from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass


@dataclass
class MockProviderConfig:
    latency_ms: float = 100
    latency_jitter_ms: float = 20
    input_tokens: int = 50
    output_tokens: int = 150
    error_rate: float = 0.0
    error_type: str = "server_error"  # "timeout" | "rate_limit" | "server_error"


@dataclass
class MockLLMResponse:
    content: str
    input_tokens: int
    output_tokens: int
    latency_ms: int
    prompt_version: int | None = None
    prompt_hash: str | None = None


class MockLLMProvider:
    def __init__(self, config: MockProviderConfig | None = None) -> None:
        self._config = config or MockProviderConfig()

    async def complete(
        self,
        prompt: str,
        *,
        prompt_version: int | None = None,
        prompt_hash: str | None = None,
    ) -> MockLLMResponse:
        jitter = (random.random() - 0.5) * 2 * self._config.latency_jitter_ms
        latency = max(1.0, self._config.latency_ms + jitter)

        await asyncio.sleep(latency / 1000)

        if random.random() < self._config.error_rate:
            self._raise_error()

        return MockLLMResponse(
            content=f"Mock response to: {prompt[:50]}...",
            input_tokens=self._config.input_tokens,
            output_tokens=self._config.output_tokens,
            latency_ms=round(latency),
            prompt_version=prompt_version,
            prompt_hash=prompt_hash,
        )

    def _raise_error(self) -> None:
        errors = {
            "timeout": "LLM request timed out",
            "rate_limit": "Rate limit exceeded (429)",
            "server_error": "Internal server error (500)",
        }
        raise RuntimeError(errors.get(self._config.error_type, errors["server_error"]))

    def configure(self, **kwargs: object) -> None:
        """Update config for scenario-specific testing."""
        for key, value in kwargs.items():
            if hasattr(self._config, key):
                setattr(self._config, key, value)

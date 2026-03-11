"""Mock LLM Provider — configurable latency, tokens, and error injection."""

from __future__ import annotations

import asyncio
import math
import random

from .types import MockProviderConfig, MockProviderResponse


class MockProvider:
    """Simulates an LLM provider with configurable latency, tokens, and errors."""

    def __init__(self, **kwargs: object) -> None:
        self._config = MockProviderConfig(**kwargs)  # type: ignore[arg-type]
        self._call_count = 0

    async def generate(
        self, prompt: str, model: str = "mock-gpt-4o"
    ) -> MockProviderResponse:
        latency = self._get_latency()

        if self._config.error_rate > 0 and random.random() < self._config.error_rate:
            await asyncio.sleep(latency * 0.3 / 1000)
            raise RuntimeError(
                f"MockProvider error: simulated failure on call #{self._call_count}"
            )

        await asyncio.sleep(latency / 1000)
        self._call_count += 1

        input_tokens = math.ceil(len(prompt) / 4)

        return MockProviderResponse(
            text=f"Mock response for: {prompt[:50]}...",
            input_tokens=input_tokens,
            output_tokens=self._config.output_tokens,
            latency_ms=latency,
            model=model,
        )

    async def generate_with_timeout(
        self, prompt: str, timeout_ms: float, model: str = "mock-gpt-4o"
    ) -> MockProviderResponse:
        latency = self._get_latency()

        if self._config.error_rate > 0 and random.random() < self._config.error_rate:
            await asyncio.sleep(min(latency * 0.3, timeout_ms) / 1000)
            raise RuntimeError("MockProvider error: simulated failure")

        if latency > timeout_ms:
            await asyncio.sleep(timeout_ms / 1000)
            raise TimeoutError(
                f"MockProvider timeout: {latency}ms exceeds {timeout_ms}ms budget"
            )

        await asyncio.sleep(latency / 1000)
        self._call_count += 1

        input_tokens = math.ceil(len(prompt) / 4)

        return MockProviderResponse(
            text=f"Mock response for: {prompt[:50]}...",
            input_tokens=input_tokens,
            output_tokens=self._config.output_tokens,
            latency_ms=latency,
            model=model,
        )

    @property
    def call_count(self) -> int:
        return self._call_count

    def reset(self) -> None:
        self._call_count = 0

    def update_config(self, **kwargs: object) -> None:
        """Update config at runtime (useful for benchmarks that change scenarios)."""
        for key, value in kwargs.items():
            if hasattr(self._config, key):
                setattr(self._config, key, value)

    def _get_latency(self) -> float:
        # Deterministic latencies for reproducible tests
        if self._config.deterministic_latencies:
            idx = self._call_count % len(self._config.deterministic_latencies)
            return self._config.deterministic_latencies[idx]

        jitter = (random.random() - 0.5) * 2 * self._config.variance_ms
        return max(1.0, self._config.latency_ms + jitter)

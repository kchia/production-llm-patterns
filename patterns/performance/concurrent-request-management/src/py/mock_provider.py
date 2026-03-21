"""
Mock LLM provider for testing and benchmarks.

Simulates realistic LLM behavior: variable latency, token counts, and
configurable error injection. Supports:
  - Configurable base latency + variance
  - Rate limit (429) injection at a specified failure rate
  - Transient 5xx injection
  - Configurable output token counts
"""

from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass

from .types import LLMResponse, LLMUsage


@dataclass
class MockProviderConfig:
    base_latency_s: float = 0.1
    latency_variance_s: float = 0.05
    rate_limit_error_rate: float = 0.0
    transient_error_rate: float = 0.0
    output_tokens: int = 100
    output_token_variance: int = 20


class RateLimitError(Exception):
    """Simulates a 429 Too Many Requests response."""

    status: int = 429

    def __init__(self, retry_after: float = 5.0) -> None:
        super().__init__(f"429 Too Many Requests — retry after {retry_after}s")
        self.retry_after = retry_after


class TransientServerError(Exception):
    """Simulates a 503 Service Unavailable response."""

    status: int = 503

    def __init__(self) -> None:
        super().__init__("503 Service Unavailable")


class MockLLMProvider:
    def __init__(self, config: MockProviderConfig | None = None) -> None:
        self._config = config or MockProviderConfig()
        self._call_count = 0

    async def complete(self, prompt: str) -> LLMResponse:
        self._call_count += 1

        # Simulate network/inference latency
        latency = self._config.base_latency_s + random.uniform(
            -self._config.latency_variance_s, self._config.latency_variance_s
        )
        await asyncio.sleep(max(0.0, latency))

        # Inject rate limit errors before transient to ensure test isolation
        if random.random() < self._config.rate_limit_error_rate:
            raise RateLimitError(retry_after=5.0)

        # Inject transient server errors
        if random.random() < self._config.transient_error_rate:
            raise TransientServerError()

        output_tokens = max(
            1,
            round(
                self._config.output_tokens
                + random.uniform(
                    -self._config.output_token_variance,
                    self._config.output_token_variance,
                )
            ),
        )

        # Naive input token estimate: 1 token ≈ 4 chars
        input_tokens = max(1, len(prompt) // 4)

        return LLMResponse(
            content=f"Mock response to: {prompt[:40]}...",
            usage=LLMUsage(input_tokens=input_tokens, output_tokens=output_tokens),
        )

    @property
    def call_count(self) -> int:
        return self._call_count

    def reset_call_count(self) -> None:
        self._call_count = 0

    def update_config(self, **kwargs: object) -> None:
        """Update config at runtime — useful for simulating sudden error rate changes."""
        for key, value in kwargs.items():
            setattr(self._config, key, value)

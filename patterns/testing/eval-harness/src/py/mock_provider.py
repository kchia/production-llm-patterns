"""Mock LLM Provider for Eval Harness

Simulates LLM responses with configurable latency, token counts,
error injection, and deterministic output mapping.
"""

from __future__ import annotations

import asyncio
import math
import random
from dataclasses import dataclass, field
from typing import Callable, Optional

from eval_types import ProviderResponse, TokenUsage


@dataclass
class MockProviderConfig:
    """Configuration for the mock LLM provider."""

    latency_ms: float = 50.0
    latency_jitter_ms: float = 20.0
    avg_input_tokens: int = 100
    avg_output_tokens: int = 200
    error_rate: float = 0.0
    error_factory: Optional[Callable[[], Exception]] = None
    output_map: Optional[dict[str, str]] = None
    default_output: str = "This is a mock LLM response."
    output_prefix: Optional[str] = None
    hang_forever: bool = False


class MockProvider:
    """Mock LLM provider with configurable behavior.

    Tracks call count for testing assertions.
    """

    def __init__(self, config: Optional[MockProviderConfig] = None) -> None:
        self._config = config or MockProviderConfig()
        self._call_count = 0

    @property
    def call_count(self) -> int:
        return self._call_count

    def reset_call_count(self) -> None:
        self._call_count = 0

    async def __call__(self, input_text: str) -> ProviderResponse:
        self._call_count += 1
        cfg = self._config

        # Hang forever (for timeout testing)
        if cfg.hang_forever:
            await asyncio.Future()  # never resolves

        # Error injection
        if cfg.error_rate > 0 and random.random() < cfg.error_rate:
            if cfg.error_factory:
                raise cfg.error_factory()
            raise RuntimeError("Mock provider error: simulated failure")

        # Simulate latency
        jitter = random.random() * cfg.latency_jitter_ms
        total_latency = cfg.latency_ms + jitter
        await asyncio.sleep(total_latency / 1000.0)

        # Determine output
        output = cfg.default_output
        if cfg.output_map and input_text in cfg.output_map:
            output = cfg.output_map[input_text]
        if cfg.output_prefix:
            output = cfg.output_prefix + output

        # Token estimation
        input_tokens = (
            cfg.avg_input_tokens
            if cfg.avg_input_tokens > 0
            else math.ceil(len(input_text.split()) * 1.3)
        )
        output_tokens = (
            cfg.avg_output_tokens
            if cfg.avg_output_tokens > 0
            else math.ceil(len(output.split()) * 1.3)
        )

        return ProviderResponse(
            output=output,
            latency_ms=total_latency,
            token_usage=TokenUsage(input=input_tokens, output=output_tokens),
        )


def create_mock_provider(
    config: Optional[MockProviderConfig] = None, **kwargs: object
) -> MockProvider:
    """Factory for creating mock providers.

    Accepts either a MockProviderConfig or keyword arguments matching its fields.
    """
    if config is None:
        config = MockProviderConfig(**kwargs)  # type: ignore[arg-type]
    return MockProvider(config)

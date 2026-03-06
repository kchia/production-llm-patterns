"""
Mock LLM Provider for Regression Testing

Simulates LLM responses with configurable latency, token counts,
error injection, and deterministic output mapping.
"""

from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass, field
from typing import Callable, Optional

from .types import ProviderResponse, TokenUsage


@dataclass
class MockProviderConfig:
    latency_ms: float = 50
    latency_jitter_ms: float = 20
    avg_input_tokens: int = 100
    avg_output_tokens: int = 200
    error_rate: float = 0.0
    error_factory: Optional[Callable[[], Exception]] = None
    output_map: Optional[dict[str, str]] = None
    default_output: str = "This is a mock LLM response."
    hang_forever: bool = False


class MockProvider:
    """Callable mock provider with call tracking."""

    def __init__(self, config: Optional[MockProviderConfig] = None) -> None:
        self._config = config or MockProviderConfig()
        self._call_count = 0

    async def __call__(self, input: str) -> ProviderResponse:
        self._call_count += 1

        if self._config.hang_forever:
            # Block forever — caller's timeout should catch this
            await asyncio.Future()

        if self._config.error_rate > 0 and random.random() < self._config.error_rate:
            if self._config.error_factory:
                raise self._config.error_factory()
            raise RuntimeError("Mock provider error: simulated failure")

        jitter = random.random() * self._config.latency_jitter_ms
        total_latency = self._config.latency_ms + jitter
        await asyncio.sleep(total_latency / 1000)

        output = self._config.default_output
        if self._config.output_map and input in self._config.output_map:
            output = self._config.output_map[input]

        input_tokens = self._config.avg_input_tokens or max(
            1, int(len(input.split()) * 1.3)
        )
        output_tokens = self._config.avg_output_tokens or max(
            1, int(len(output.split()) * 1.3)
        )

        return ProviderResponse(
            output=output,
            latency_ms=total_latency,
            token_usage=TokenUsage(input=input_tokens, output=output_tokens),
        )

    @property
    def call_count(self) -> int:
        return self._call_count

    def reset_call_count(self) -> None:
        self._call_count = 0


def create_mock_provider(config: Optional[MockProviderConfig] = None) -> MockProvider:
    return MockProvider(config)


def create_versioned_providers(
    baseline_outputs: dict[str, str],
    changed_outputs: dict[str, str],
    latency_ms: float = 10,
) -> tuple[MockProvider, MockProvider]:
    """
    Two providers simulating a prompt version change.
    Baseline returns original outputs; current merges changed outputs on top.
    """
    merged = {**baseline_outputs, **changed_outputs}

    baseline = create_mock_provider(
        MockProviderConfig(
            output_map=baseline_outputs,
            latency_ms=latency_ms,
            latency_jitter_ms=0,
        )
    )
    current = create_mock_provider(
        MockProviderConfig(
            output_map=merged,
            latency_ms=latency_ms,
            latency_jitter_ms=0,
        )
    )
    return baseline, current

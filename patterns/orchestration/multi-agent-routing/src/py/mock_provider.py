"""
Mock LLM provider for testing and benchmarks.

Supports configurable latency, token counts, routing behavior, and error injection.
No real API calls — everything is simulated.
"""

from __future__ import annotations

import asyncio
import json
import random
from dataclasses import dataclass, field
from typing import Optional, Protocol

from .types import CompletionOptions, LLMCompletion


class LLMProvider(Protocol):
    async def complete(self, prompt: str, options: Optional[CompletionOptions] = None) -> LLMCompletion:
        ...


@dataclass
class MockRoutingOverride:
    agent_id: str
    confidence: float
    reasoning: str


@dataclass
class MockProviderConfig:
    latency_ms: float = 50.0
    """Simulated latency in ms."""

    jitter_ms: float = 10.0
    """Jitter added to latency (±jitter_ms)."""

    tokens_per_completion: int = 120
    """Simulated tokens per completion."""

    error_every_n: int = 0
    """Throw an error on every Nth call (0 = never)."""

    routing_override: Optional[MockRoutingOverride] = None
    """
    When set, the mock returns this as the routing classification response.
    Useful for testing specific routing outcomes without parsing real LLM output.
    """

    response_sequence: list[str] = field(default_factory=list)
    """
    Per-call response override. The mock cycles through these in order, wrapping around.
    Used to simulate multi-turn scenarios.
    """


class MockLLMProvider:
    """Mock LLM provider for testing and benchmarks."""

    def __init__(self, config: Optional[MockProviderConfig] = None) -> None:
        self._config = config or MockProviderConfig()
        self._call_count = 0
        self._response_index = 0

    async def complete(self, prompt: str, options: Optional[CompletionOptions] = None) -> LLMCompletion:
        self._call_count += 1

        # Error injection
        if self._config.error_every_n > 0 and self._call_count % self._config.error_every_n == 0:
            raise RuntimeError(f"MockLLMProvider: injected error on call {self._call_count}")

        # Simulate latency with jitter
        jitter = (random.random() - 0.5) * 2 * self._config.jitter_ms
        delay_s = max(0.0, self._config.latency_ms + jitter) / 1000.0
        start = asyncio.get_event_loop().time()
        await asyncio.sleep(delay_s)
        latency_ms = (asyncio.get_event_loop().time() - start) * 1000.0

        content = self._generate_content(prompt)
        return LLMCompletion(
            content=content,
            tokens_used=self._config.tokens_per_completion,
            latency_ms=latency_ms,
        )

    def _generate_content(self, prompt: str) -> str:
        # Return routing override as JSON if set
        if self._config.routing_override:
            override = self._config.routing_override
            return json.dumps({
                "agentId": override.agent_id,
                "confidence": override.confidence,
                "reasoning": override.reasoning,
            })

        # Cycle through response sequence if configured
        if self._config.response_sequence:
            response = self._config.response_sequence[self._response_index % len(self._config.response_sequence)]
            self._response_index += 1
            return response

        # Default: echo truncated prompt
        return f'Mock response to: "{prompt[:80]}..."'

    @property
    def total_calls(self) -> int:
        return self._call_count

    def reset(self) -> None:
        """Reset call counter (useful between test cases)."""
        self._call_count = 0
        self._response_index = 0

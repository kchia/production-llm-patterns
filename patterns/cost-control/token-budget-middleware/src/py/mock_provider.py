"""
Token Budget Middleware — Mock LLM Provider

Simulates an LLM provider with configurable latency, token counts,
and error injection. Used for testing and benchmarks — no API keys needed.
"""

from __future__ import annotations

import asyncio
import math
import random
from dataclasses import dataclass, field

from budget_types import LLMRequest, LLMResponse


@dataclass
class MockProviderConfig:
    """Configuration for the mock provider."""

    latency_ms: float = 50.0
    failure_rate: float = 0.0
    error_message: str = "Provider unavailable"
    input_tokens_per_request: int = 0
    output_tokens_per_response: int = 100
    model_name: str = "mock-model"
    response_content: str = ""
    output_token_variance: int = 0


class MockProvider:
    """Mock LLM provider with configurable behavior for testing."""

    def __init__(self, config: MockProviderConfig | None = None) -> None:
        self._config = config or MockProviderConfig()
        self._call_count = 0
        self._total_input_tokens = 0
        self._total_output_tokens = 0

    async def call(self, request: LLMRequest) -> LLMResponse:
        self._call_count += 1

        # Simulate latency
        if self._config.latency_ms > 0:
            await asyncio.sleep(self._config.latency_ms / 1000)

        # Simulate failure
        if random.random() < self._config.failure_rate:
            raise RuntimeError(self._config.error_message)

        # Derive input tokens from prompt if not explicitly configured
        input_tokens = (
            self._config.input_tokens_per_request
            if self._config.input_tokens_per_request > 0
            else math.ceil(len(request.prompt) / 4)
        )

        # Apply variance to output tokens
        output_tokens = self._config.output_tokens_per_response
        if self._config.output_token_variance > 0:
            v = self._config.output_token_variance
            output_tokens += random.randint(-v, v)
            output_tokens = max(1, output_tokens)

        self._total_input_tokens += input_tokens
        self._total_output_tokens += output_tokens

        content = (
            self._config.response_content
            or f"Mock response for: {request.prompt[:50]}"
        )

        return LLMResponse(
            content=content,
            tokens_used=input_tokens + output_tokens,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            model=self._config.model_name,
            finish_reason="stop",
        )

    @property
    def call_count(self) -> int:
        return self._call_count

    @property
    def total_input_tokens(self) -> int:
        return self._total_input_tokens

    @property
    def total_output_tokens(self) -> int:
        return self._total_output_tokens

    def reset(self) -> None:
        self._call_count = 0
        self._total_input_tokens = 0
        self._total_output_tokens = 0

"""
Retry with Budget — Mock LLM Provider

Simulates an LLM provider with configurable latency, error rates,
error sequences, and token counts. Supports HTTP-status-aware errors
and Retry-After headers for testing budget behavior.
"""

from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass, field

from .types import LLMRequest, LLMResponse, ProviderError


@dataclass
class MockProviderConfig:
    """Configuration for the mock LLM provider."""

    latency_ms: float = 50
    failure_rate: float = 0.0
    failure_status_code: int = 503
    error_message: str = "Provider unavailable"
    retry_after_ms: int = 0
    tokens_per_response: int = 100
    model_name: str = "mock-model"
    response_content: str = ""
    error_sequence: list[str | int] = field(default_factory=list)


class MockProvider:
    """Mock LLM provider for testing and benchmarks."""

    def __init__(self, config: MockProviderConfig | None = None) -> None:
        self._config = config or MockProviderConfig()
        self._call_count = 0
        self._sequence_index = 0

    async def call(self, request: LLMRequest) -> LLMResponse:
        self._call_count += 1

        if self._config.latency_ms > 0:
            await asyncio.sleep(self._config.latency_ms / 1000)

        # Check error sequence first
        if self._sequence_index < len(self._config.error_sequence):
            outcome = self._config.error_sequence[self._sequence_index]
            self._sequence_index += 1

            if outcome != "success":
                status_code = int(outcome)
                retry_after = (
                    self._config.retry_after_ms
                    if status_code == 429 and self._config.retry_after_ms > 0
                    else None
                )
                raise ProviderError(
                    self._config.error_message,
                    status_code,
                    retry_after_ms=retry_after,
                )
            # "success" falls through to return a response
        else:
            # Probabilistic failure
            if random.random() < self._config.failure_rate:
                status_code = self._config.failure_status_code
                retry_after = (
                    self._config.retry_after_ms
                    if status_code == 429 and self._config.retry_after_ms > 0
                    else None
                )
                raise ProviderError(
                    self._config.error_message,
                    status_code,
                    retry_after_ms=retry_after,
                )

        content = (
            self._config.response_content
            or f"Mock response for: {request.prompt[:50]}"
        )

        return LLMResponse(
            content=content,
            tokens_used=self._config.tokens_per_response,
            model=self._config.model_name,
            finish_reason="stop",
        )

    @property
    def call_count(self) -> int:
        return self._call_count

    def reset(self) -> None:
        self._call_count = 0
        self._sequence_index = 0

    def update_config(self, **kwargs: object) -> None:
        for key, value in kwargs.items():
            if hasattr(self._config, key):
                setattr(self._config, key, value)
        if "error_sequence" in kwargs:
            self._sequence_index = 0

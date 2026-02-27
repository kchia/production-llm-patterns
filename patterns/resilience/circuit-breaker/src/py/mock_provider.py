"""Mock LLM provider with configurable latency, token counts, and error injection."""

from __future__ import annotations

import asyncio
import math
import random
import time
from dataclasses import dataclass, field
from typing import Optional, Sequence, Union

from .cb_types import LLMRequest, LLMResponse, ProviderError, TokenUsage


@dataclass
class MockProviderConfig:
    """Configuration for the mock provider."""

    latency_ms: float = 50.0
    """Simulated response latency in ms."""

    tokens_per_response: int = 100
    """Simulated tokens per response."""

    failure_rate: float = 0.0
    """Probabilistic failure rate (0.0 to 1.0)."""

    failure_status_code: int = 503
    """HTTP status code to throw on failure."""

    error_message: Optional[str] = None
    """Custom error message on failure."""

    error_sequence: Optional[list[Union[str, int]]] = None
    """Deterministic sequence of outcomes ('success' or status code). Falls back to probabilistic after exhaustion."""

    response_content: Optional[str] = None
    """Static response content."""

    model: str = "mock-model"
    """Simulated model name."""


class MockProvider:
    """Mock LLM provider for testing circuit breaker behavior."""

    def __init__(self, config: Optional[MockProviderConfig] = None, **kwargs: object) -> None:
        if config is not None:
            self._config = config
        else:
            self._config = MockProviderConfig(**kwargs)  # type: ignore[arg-type]
        self._call_count = 0
        self._sequence_index = 0

    async def call(self, request: LLMRequest) -> LLMResponse:
        self._call_count += 1
        start = time.perf_counter()

        # Simulate latency
        if self._config.latency_ms > 0:
            await asyncio.sleep(self._config.latency_ms / 1000.0)

        # Deterministic sequence takes priority over probabilistic failure
        if (
            self._config.error_sequence is not None
            and self._sequence_index < len(self._config.error_sequence)
        ):
            outcome = self._config.error_sequence[self._sequence_index]
            self._sequence_index += 1
            if outcome != "success":
                status = int(outcome)
                raise ProviderError(
                    self._config.error_message or f"Mock provider error (status {status})",
                    status,
                )
        elif random.random() < self._config.failure_rate:
            raise ProviderError(
                self._config.error_message
                or f"Mock provider error (status {self._config.failure_status_code})",
                self._config.failure_status_code,
            )

        latency_ms = (time.perf_counter() - start) * 1000.0
        input_tokens = math.ceil(len(request.prompt) / 4)

        return LLMResponse(
            content=self._config.response_content or f"Response to: {request.prompt[:50]}",
            token_usage=TokenUsage(
                input=input_tokens,
                output=self._config.tokens_per_response,
                total=input_tokens + self._config.tokens_per_response,
            ),
            latency_ms=latency_ms,
            model=self._config.model,
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

"""Mock LLM Provider for structured tracing tests and benchmarks.

Simulates realistic LLM behavior with configurable latency, token counts,
and error injection. Designed to exercise all tracing paths without
requiring a real LLM API.
"""

from __future__ import annotations

import asyncio
import random
import time
from dataclasses import dataclass, field

from ._types import LLMRequest, LLMResponse


class ProviderError(Exception):
    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass
class MockProviderConfig:
    latency_ms: float = 50.0
    failure_rate: float = 0.0
    error_message: str = "Provider error"
    failure_status_code: int = 503
    input_tokens_per_request: int = 100
    output_tokens_per_request: int = 200
    model: str = "mock-model"
    response_content: str = ""
    error_sequence: list[str | int] = field(default_factory=list)


class MockProvider:
    def __init__(self, config: MockProviderConfig | None = None) -> None:
        self._config = config or MockProviderConfig()
        self._call_count = 0
        self._sequence_index = 0

    async def call(self, request: LLMRequest) -> LLMResponse:
        start = time.perf_counter()
        self._call_count += 1

        if self._config.latency_ms > 0:
            await asyncio.sleep(self._config.latency_ms / 1000.0)

        should_fail = self._should_fail()

        if should_fail is not False:
            status = should_fail if isinstance(should_fail, int) else self._config.failure_status_code
            raise ProviderError(self._config.error_message, status)

        latency_ms = (time.perf_counter() - start) * 1000.0
        content = (
            self._config.response_content
            or f"Mock response for: {request.prompt[:50]}"
        )

        return LLMResponse(
            content=content,
            model=request.model or self._config.model,
            input_tokens=self._config.input_tokens_per_request,
            output_tokens=self._config.output_tokens_per_request,
            latency_ms=latency_ms,
        )

    def _should_fail(self) -> bool | int:
        if self._config.error_sequence:
            entry = self._config.error_sequence[
                self._sequence_index % len(self._config.error_sequence)
            ]
            self._sequence_index += 1
            if entry == "success":
                return False
            return entry  # type: ignore[return-value]
        if self._config.failure_rate > 0 and random.random() < self._config.failure_rate:
            return self._config.failure_status_code
        return False

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

"""
Multi-Provider Failover — Mock LLM Provider

Simulates an LLM provider with configurable latency, failure rate,
and error injection. Used for testing and benchmarks — no API keys needed.
"""

from __future__ import annotations

import asyncio
import random
import time

from .types import LLMRequest, LLMResponse, ProviderError


class MockProvider:
    """Mock LLM provider with configurable latency, failure rate, and error codes."""

    def __init__(
        self,
        name: str,
        *,
        latency_ms: float = 200.0,
        failure_rate: float = 0.0,
        failure_status_code: int = 503,
        avg_tokens: int = 100,
        model: str = "mock-model",
    ) -> None:
        self.name = name
        self.latency_ms = latency_ms
        self.failure_rate = failure_rate
        self.failure_status_code = failure_status_code
        self.avg_tokens = avg_tokens
        self.model = model
        self._request_count = 0
        # Deterministic failure schedule — overrides failure_rate when set
        self._failure_schedule: list[bool] = []

    def set_failure_schedule(self, schedule: list[bool]) -> None:
        """Set a deterministic failure schedule for testing."""
        self._failure_schedule = list(schedule)

    def update_config(self, **kwargs: object) -> None:
        """Update config at runtime (useful for injecting failures mid-test)."""
        for key, value in kwargs.items():
            if hasattr(self, key):
                setattr(self, key, value)

    @property
    def request_count(self) -> int:
        return self._request_count

    def reset(self) -> None:
        self._request_count = 0
        self._failure_schedule = []

    async def handle(self, request: LLMRequest) -> LLMResponse:
        self._request_count += 1
        start = time.perf_counter()

        # Simulate latency with ±20% jitter
        jitter = 1 + (random.random() * 0.4 - 0.2)
        delay = self.latency_ms * jitter / 1000  # convert ms to seconds
        await asyncio.sleep(delay)

        # Determine failure: schedule takes priority over random rate
        if self._failure_schedule:
            should_fail = self._failure_schedule.pop(0)
        else:
            should_fail = random.random() < self.failure_rate

        if should_fail:
            raise ProviderError(
                f"{self.name} returned {self.failure_status_code}",
                status_code=self.failure_status_code,
                provider=self.name,
            )

        latency_ms = (time.perf_counter() - start) * 1000
        tokens = self.avg_tokens + random.randint(-10, 10)

        return LLMResponse(
            content=f"Response from {self.name}: {request.prompt[:50]}",
            tokens_used=max(1, tokens),
            model=self.model,
            finish_reason="stop",
            latency_ms=latency_ms,
        )


def create_failing_provider(name: str, status_code: int) -> MockProvider:
    """Create a provider that always fails with a specific status code."""
    return MockProvider(name, failure_rate=1.0, failure_status_code=status_code)


def create_timeout_provider(name: str, timeout_ms: float) -> MockProvider:
    """Create a provider that always times out."""
    return MockProvider(name, latency_ms=timeout_ms * 10)

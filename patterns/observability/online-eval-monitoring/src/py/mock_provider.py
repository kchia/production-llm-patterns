"""Mock scorer and LLM provider for testing and benchmarks."""

from __future__ import annotations

import asyncio
import random

from .types import Trace


class MockScorer:
    """Configurable mock scorer for testing.

    Supports fixed or random scores, simulated latency, error injection,
    and drift simulation (score degrades by drift_per_call each invocation).
    """

    def __init__(
        self,
        name: str,
        sampling_rate: float = 1.0,
        fixed_score: float = -1.0,
        latency_ms: float = 50.0,
        error_rate: float = 0.0,
        drift_per_call: float = 0.0,
    ) -> None:
        self.name = name
        self.sampling_rate = sampling_rate
        self._fixed_score = fixed_score
        self._latency_s = latency_ms / 1000.0
        self._error_rate = error_rate
        self._drift_per_call = drift_per_call
        self._call_count = 0

    async def score(self, trace: Trace) -> float:  # noqa: ARG002
        await asyncio.sleep(self._latency_s)

        if random.random() < self._error_rate:
            raise RuntimeError(f"MockScorer({self.name}): injected error")

        self._call_count += 1
        base = self._fixed_score if self._fixed_score >= 0 else random.random()
        drift = self._drift_per_call * self._call_count
        return max(0.0, min(1.0, base - drift))

    @property
    def call_count(self) -> int:
        return self._call_count

    def reset(self) -> None:
        self._call_count = 0


class MockLLMProvider:
    """Mock LLM provider with configurable latency and error injection."""

    def __init__(
        self,
        response: str = "Mock LLM response",
        latency_ms: float = 10.0,
        error_rate: float = 0.0,
    ) -> None:
        self._response = response
        self._latency_s = latency_ms / 1000.0
        self._error_rate = error_rate
        self._call_count = 0

    async def complete(self, prompt: str) -> str:
        await asyncio.sleep(self._latency_s)
        self._call_count += 1

        if random.random() < self._error_rate:
            raise RuntimeError("MockLLMProvider: injected error")

        return f"{self._response} [prompt_len={len(prompt)}]"

    @property
    def call_count(self) -> int:
        return self._call_count

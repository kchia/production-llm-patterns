"""Mock LLM provider for testing and benchmarks."""

from __future__ import annotations

import asyncio
import math
import random
from dataclasses import dataclass, field

from models import CompletionResult


@dataclass
class MockProviderConfig:
    strong_latency_ms: float = 800.0
    mid_latency_ms: float = 400.0
    weak_latency_ms: float = 150.0
    latency_jitter_ms: float = 50.0
    avg_output_tokens: int = 200
    error_rate: float = 0.0
    error_models: list[str] = field(default_factory=list)


class MockProvider:
    """Simulates realistic LLM behavior with configurable latency and error injection."""

    def __init__(self, config: MockProviderConfig | None = None) -> None:
        self._config = config or MockProviderConfig()
        self._call_count = 0

    async def complete(self, model_id: str, prompt: str) -> CompletionResult:
        self._call_count += 1

        # Error injection
        if self._config.error_rate > 0:
            should_error = (
                not self._config.error_models
                or model_id in self._config.error_models
            )
            if should_error and random.random() < self._config.error_rate:
                raise RuntimeError(
                    f"MockProvider: simulated error for model {model_id}"
                )

        base_latency = self._get_base_latency(model_id)
        jitter = (random.random() - 0.5) * 2 * self._config.latency_jitter_ms
        latency = max(0.001, base_latency + jitter)

        await asyncio.sleep(latency / 1000)  # convert ms to seconds

        input_tokens = math.ceil(len(prompt) / 4)
        output_tokens = max(
            10,
            self._config.avg_output_tokens + random.randint(-20, 20),
        )

        return CompletionResult(
            response=f"[{model_id}] Mock response for prompt ({input_tokens} input tokens)",
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )

    def _get_base_latency(self, model_id: str) -> float:
        low = model_id.lower()
        if any(tag in low for tag in ("mini", "small", "flash")):
            return self._config.weak_latency_ms
        if any(tag in low for tag in ("sonnet", "haiku", "mid")):
            return self._config.mid_latency_ms
        return self._config.strong_latency_ms

    @property
    def call_count(self) -> int:
        return self._call_count

    def reset_call_count(self) -> None:
        self._call_count = 0

"""
Mock LLM provider for testing and benchmarks.

Three behavioral modes:
  stable  — consistent distributions (normal production)
  drifted — systematically shifted (simulates post-model-update drift)
  noisy   — high variance (simulates unreliable provider)

No real API calls.
"""

from __future__ import annotations

import itertools
import math
import random
from dataclasses import dataclass
from typing import Literal

MockMode = Literal["stable", "drifted", "noisy"]

_counter = itertools.count(1)


@dataclass
class MockResponse:
    request_id: str
    input_length: int
    output_length: int
    latency_ms: float
    output_score: float


@dataclass
class MockProviderConfig:
    mode: MockMode = "stable"
    base_latency_ms: float = 800.0
    base_output_length: int = 600
    base_input_length: int = 300
    base_quality_score: float = 0.82
    drift_multiplier: float = 0.6  # fraction of base applied in 'drifted' mode
    noise_factor: float = 0.10


class MockProvider:
    def __init__(self, config: MockProviderConfig | None = None) -> None:
        self.config = config or MockProviderConfig()

    def call(self, input_length_override: int | None = None) -> MockResponse:
        cfg = self.config
        drift = cfg.drift_multiplier if cfg.mode == "drifted" else 1.0
        noise = cfg.noise_factor * (5.0 if cfg.mode == "noisy" else 1.0)

        def _sample(base: float) -> float:
            return max(10.0, random.gauss(base * drift, base * noise))

        input_length = round(_sample(input_length_override or cfg.base_input_length))
        output_length = round(_sample(cfg.base_output_length))
        latency_ms = round(_sample(cfg.base_latency_ms), 1)

        base_score = cfg.base_quality_score * cfg.drift_multiplier if cfg.mode == "drifted" else cfg.base_quality_score
        output_score = max(0.0, min(1.0, random.gauss(base_score, 0.05 if cfg.mode == "drifted" else 0.02)))

        return MockResponse(
            request_id=f"mock-{next(_counter)}",
            input_length=input_length,
            output_length=output_length,
            latency_ms=latency_ms,
            output_score=output_score,
        )

    def set_mode(self, mode: MockMode) -> None:
        self.config.mode = mode

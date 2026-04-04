"""
Mock LLM provider for testing and benchmarks.

Supports configurable latency, canned responses, error injection,
and a deterministic embedding function. The character-frequency embedding
is identical to the TypeScript implementation — 64-dim unit vector —
so cross-language baseline snapshots are compatible.
"""

from __future__ import annotations

import asyncio
import math
import random
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class MockProviderConfig:
    latency_ms: float = 10.0
    responses: list[str] = field(default_factory=lambda: [
        "The system is operating normally. All checks passed."
    ])
    error_rate: float = 0.0
    error_message: str = "Mock provider error"
    # Multiplier on dimension 0 of the embedding vector — simulates embedding
    # model version drift without changing the underlying text.
    embedding_drift_multiplier: float = 1.0


class MockProvider:
    """Deterministic mock LLM provider.

    Responses cycle through the provided list. Embedding is a normalised
    64-dim character-frequency vector — identical math to the TypeScript
    mock, ensuring cross-language snapshot compatibility.
    """

    def __init__(self, config: Optional[MockProviderConfig] = None) -> None:
        self._config = config or MockProviderConfig()
        self._call_count = 0

    async def complete(self, prompt: str) -> str:  # noqa: ARG002
        await asyncio.sleep(self._config.latency_ms / 1000)

        if self._config.error_rate > 0 and random.random() < self._config.error_rate:
            raise RuntimeError(self._config.error_message)

        response = self._config.responses[
            self._call_count % len(self._config.responses)
        ]
        self._call_count += 1
        return response

    async def embed(self, text: str) -> list[float]:
        dims = 64
        vector = [0.0] * dims
        for char in text:
            idx = ord(char) % dims
            vector[idx] += 1.0

        # Normalise to unit vector for cosine similarity
        magnitude = math.sqrt(sum(v * v for v in vector))
        if magnitude > 0:
            vector = [v / magnitude for v in vector]

        # Apply drift multiplier to simulate embedding model version change
        if self._config.embedding_drift_multiplier != 1.0:
            vector[0] *= self._config.embedding_drift_multiplier
            new_mag = math.sqrt(sum(v * v for v in vector))
            if new_mag > 0:
                vector = [v / new_mag for v in vector]

        return vector

    @property
    def call_count(self) -> int:
        return self._call_count

    def reset_call_count(self) -> None:
        self._call_count = 0

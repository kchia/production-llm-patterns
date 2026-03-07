"""Mock LLM and Embedding providers for testing and benchmarks.

The mock embedding provider generates deterministic vectors from text,
designed so that semantically "similar" test strings (sharing word stems)
produce vectors with high cosine similarity.
"""

from __future__ import annotations

import asyncio
import math
import re
import time
from dataclasses import dataclass, field

from ._types import LLMResponse


@dataclass
class MockLLMConfig:
    latency_ms: float = 200.0
    output_tokens: int = 150
    input_token_multiplier: float = 0.25
    error_rate: float = 0.0
    error_message: str = "Mock provider error"


class MockLLMProvider:
    """Mock LLM provider with configurable latency, tokens, and error injection."""

    def __init__(self, **kwargs: object) -> None:
        self._config = MockLLMConfig(**kwargs)  # type: ignore[arg-type]
        self._call_count = 0

    async def complete(self, prompt: str) -> LLMResponse:
        self._call_count += 1

        if self._config.error_rate > 0:
            import random

            if random.random() < self._config.error_rate:
                raise RuntimeError(self._config.error_message)

        start = time.perf_counter()
        if self._config.latency_ms > 0:
            await asyncio.sleep(self._config.latency_ms / 1000)
        elapsed_ms = (time.perf_counter() - start) * 1000

        return LLMResponse(
            text=f"Mock response for: {prompt[:80]}",
            input_tokens=math.ceil(len(prompt) * self._config.input_token_multiplier),
            output_tokens=self._config.output_tokens,
            latency_ms=elapsed_ms,
        )

    @property
    def call_count(self) -> int:
        return self._call_count

    def reset_call_count(self) -> None:
        self._call_count = 0

    def update_config(self, **kwargs: object) -> None:
        for key, value in kwargs.items():
            if hasattr(self._config, key):
                setattr(self._config, key, value)


@dataclass
class MockEmbeddingConfig:
    dimensions: int = 384
    latency_ms: float = 5.0


class MockEmbeddingProvider:
    """Generates deterministic embeddings from text.

    Uses a hash-based approach: each word contributes to specific vector
    dimensions based on its character codes. Strings sharing words produce
    overlapping non-zero dimensions and higher cosine similarity — mimicking
    real embedding models on paraphrases.
    """

    def __init__(self, **kwargs: object) -> None:
        self._config = MockEmbeddingConfig(**kwargs)  # type: ignore[arg-type]

    @property
    def dimensions(self) -> int:
        return self._config.dimensions

    async def embed(self, text: str) -> list[float]:
        if self._config.latency_ms > 0:
            await asyncio.sleep(self._config.latency_ms / 1000)
        return self._generate_embedding(text)

    def embed_sync(self, text: str) -> list[float]:
        """Synchronous embedding for benchmarks."""
        return self._generate_embedding(text)

    def _generate_embedding(self, text: str) -> list[float]:
        dims = self._config.dimensions
        vec = [0.0] * dims
        normalized = re.sub(r"[^a-z0-9\s]", "", text.lower())
        words = normalized.split()

        for word in words:
            # Hash matching the TS implementation's behavior
            h = 0
            for ch in word:
                h = ((h << 5) - h + ord(ch)) & 0xFFFFFFFF
                # Convert to signed 32-bit like JS
                if h >= 0x80000000:
                    h -= 0x100000000

            for i in range(8):
                # Multiply and wrap to signed 32-bit, matching JS bitwise OR 0
                raw = h * (i + 1) * 2654435761
                raw = raw & 0xFFFFFFFF
                if raw >= 0x80000000:
                    raw -= 0x100000000
                idx = abs(raw) % dims

                sign_check = (h * (i + 1)) & 0xFFFFFFFF
                sign = 1 if sign_check & 1 else -1
                vec[idx] += sign * (1 / (i + 1))

        # L2-normalize
        norm = math.sqrt(sum(v * v for v in vec))
        if norm > 0:
            vec = [v / norm for v in vec]

        return vec

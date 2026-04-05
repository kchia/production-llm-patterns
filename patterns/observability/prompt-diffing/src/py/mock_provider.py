"""Mock providers for testing and benchmarks — no real API calls."""
from __future__ import annotations

import asyncio
import math
import random
from datetime import datetime

try:
    from .models import PromptRegistry, PromptVersion
except ImportError:
    from models import PromptRegistry, PromptVersion  # type: ignore[no-redef]


class MockPromptRegistry(PromptRegistry):
    """In-memory registry with configurable latency and error injection."""

    def __init__(self, latency_seconds: float = 0.0, error_rate: float = 0.0) -> None:
        self._versions: dict[str, PromptVersion] = {}
        # prompt_name -> ordered list of version IDs (oldest first)
        self._name_index: dict[str, list[str]] = {}
        self.latency_seconds = latency_seconds
        self.error_rate = error_rate

    def seed(self, version: PromptVersion) -> None:
        """Seed a version directly. Used by tests."""
        self._versions[version.id] = version
        ids = self._name_index.setdefault(version.name, [])
        ids.append(version.id)

    async def get(self, version_id: str) -> PromptVersion | None:
        await self._simulate_latency()
        self._maybe_raise("get")
        return self._versions.get(version_id)

    async def get_latest(self, prompt_name: str) -> PromptVersion | None:
        await self._simulate_latency()
        self._maybe_raise("get_latest")
        ids = self._name_index.get(prompt_name)
        if not ids:
            return None
        return self._versions.get(ids[-1])

    async def get_previous(self, version_id: str) -> PromptVersion | None:
        await self._simulate_latency()
        self._maybe_raise("get_previous")
        version = self._versions.get(version_id)
        if version is None:
            return None
        ids = self._name_index.get(version.name, [])
        idx = ids.index(version_id) if version_id in ids else -1
        if idx <= 0:
            return None  # already oldest
        return self._versions.get(ids[idx - 1])

    async def _simulate_latency(self) -> None:
        if self.latency_seconds > 0:
            await asyncio.sleep(self.latency_seconds)

    def _maybe_raise(self, operation: str) -> None:
        if random.random() < self.error_rate:
            raise RuntimeError(f"MockPromptRegistry: simulated error on {operation}")


class MockEmbeddingProvider:
    """
    Deterministic 64-dim embedding via character trigram bag-of-words.
    Cosine distance is proportional to lexical divergence — useful for
    threshold-based severity testing without calling a real API.
    """

    def __init__(self, latency_seconds: float = 0.0) -> None:
        self.latency_seconds = latency_seconds

    async def embed(self, text: str) -> list[float]:
        if self.latency_seconds > 0:
            await asyncio.sleep(self.latency_seconds)

        vec = [0.0] * 64
        for word in text.lower().split():
            for i in range(len(word) - 2):
                trigram = word[i : i + 3]
                h = 0
                for ch in trigram:
                    h = (h * 31 + ord(ch)) & 0xFFFFFFFF
                vec[h % 64] += 1.0

        return _normalize(vec)


def _normalize(vec: list[float]) -> list[float]:
    magnitude = math.sqrt(sum(v * v for v in vec))
    if magnitude == 0:
        return vec
    return [v / magnitude for v in vec]

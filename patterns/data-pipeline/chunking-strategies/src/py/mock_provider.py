"""Mock tokenizer for tests and benchmarks.

In production, replace with tiktoken or a model-specific tokenizer.
"""

from __future__ import annotations

import math
import random
import time


class MockTokenizer:
    """Approximates GPT-style tokenization without a real tokenizer dependency.

    Uses word splitting + a configurable tokens-per-word ratio, which is accurate
    enough for chunk size estimation in tests and benchmarks.

    For production, swap for tiktoken:
        import tiktoken
        enc = tiktoken.encoding_for_model("gpt-4o")
    """

    def __init__(
        self,
        tokens_per_word: float = 1.3,
        error_rate: float = 0.0,
        latency_ms: float = 0.0,
    ) -> None:
        # Real GPT tokenizers average ~1.3 tokens/word for English prose.
        self._tokens_per_word = tokens_per_word
        self._error_rate = error_rate
        self._latency_ms = latency_ms
        self._call_count = 0

    def count_tokens(self, text: str) -> int:
        self._call_count += 1
        self._maybe_raise()
        self._simulate_latency()
        return self._estimate_tokens(text)

    def encode(self, text: str) -> list[int]:
        """Encode as word indices — sufficient for overlap slicing in tests."""
        self._maybe_raise()
        words = text.split()
        return list(range(len(words)))

    def decode(self, tokens: list[int]) -> str:
        # Round-trip fidelity isn't needed in tests — return placeholder.
        return f"[decoded:{len(tokens)}tokens]"

    @property
    def call_count(self) -> int:
        return self._call_count

    def _estimate_tokens(self, text: str) -> int:
        words = len(text.split())
        return math.ceil(words * self._tokens_per_word)

    def _maybe_raise(self) -> None:
        if self._error_rate > 0 and random.random() < self._error_rate:
            raise RuntimeError("MockTokenizer: simulated tokenization failure")

    def _simulate_latency(self) -> None:
        if self._latency_ms > 0:
            time.sleep(self._latency_ms / 1000)


def create_mock_tokenizer(**overrides: object) -> MockTokenizer:
    """Create a MockTokenizer with realistic GPT-4 token ratios."""
    return MockTokenizer(tokens_per_word=overrides.get("tokens_per_word", 1.3))  # type: ignore[arg-type]

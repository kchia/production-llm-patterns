"""Mock tokenizer and summarizer for tests and benchmarks.

In production, replace MockTokenizer with tiktoken or a model-specific tokenizer.
Replace MockSummarizer with an actual LLM call that compresses conversation history.
"""

from __future__ import annotations

import math
import random
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .types import Message, Tokenizer


class MockTokenizer:
    """Approximates GPT-style tokenization without a real tokenizer dependency.

    Uses word splitting + a configurable tokens-per-word ratio, accurate enough
    for budget estimation in tests and benchmarks.

    For production, swap for tiktoken:
        import tiktoken
        enc = tiktoken.encoding_for_model("gpt-4o")
        token_count = len(enc.encode(text))
    """

    def __init__(
        self,
        tokens_per_word: float = 1.3,
        error_rate: float = 0.0,
    ) -> None:
        # Real GPT tokenizers average ~1.3 tokens/word for English prose.
        self._tokens_per_word = tokens_per_word
        self._error_rate = error_rate
        self._call_count = 0

    def count_tokens(self, text: str) -> int:
        self._call_count += 1
        if self._error_rate > 0 and random.random() < self._error_rate:
            raise RuntimeError("MockTokenizer: simulated tokenization failure")
        words = len(text.split())
        return math.ceil(words * self._tokens_per_word)

    @property
    def call_count(self) -> int:
        return self._call_count


def create_mock_tokenizer(tokens_per_word: float = 1.3) -> MockTokenizer:
    """Create a MockTokenizer with realistic GPT-4 token ratios."""
    return MockTokenizer(tokens_per_word=tokens_per_word)


class MockSummarizer:
    """Mock compressor for the summarize strategy.

    In production, replace with an LLM call:

        response = openai.chat.completions.create(
            messages=[{"role": "user", "content": f"Summarize: {json.dumps(messages)}"}],
            max_tokens=target_tokens,
        )

    The mock produces a deterministic placeholder so tests stay fast and offline.
    """

    def __init__(self, tokenizer: "Tokenizer | None" = None) -> None:
        self._tokenizer = tokenizer or create_mock_tokenizer()

    def compress(self, messages: "list[Message]", target_tokens: int) -> "Message":
        from .types import Message as Msg

        total_original_tokens = sum(
            m.tokens if m.tokens is not None else self._tokenizer.count_tokens(m.content)
            for m in messages
        )
        content = f"[Summary: {len(messages)} messages ({total_original_tokens} tokens) compressed]"
        return Msg(
            role="user",
            content=content,
            id=f"summary-{id(messages)}",
            priority=0.9,  # summaries are high-priority — they represent compressed history
            tokens=self._tokenizer.count_tokens(content),
        )


def create_mock_summarizer(tokenizer: "Tokenizer | None" = None) -> MockSummarizer:
    """Create a MockSummarizer for tests."""
    return MockSummarizer(tokenizer=tokenizer)

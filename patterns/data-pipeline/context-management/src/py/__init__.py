"""Context Management — idiomatic Python implementation.

Manages what goes into an LLM context window by tracking message history
and applying a trim strategy when the token budget is exceeded.

Usage::

    from patterns.data_pipeline.context_management.src.py import ContextManager

    manager = ContextManager(ContextConfig(max_tokens=128_000, reserve_for_output=4_000))
    manager.add(role="system", content="You are a helpful assistant.")
    manager.add(role="user", content="Hello!")
    window = manager.build()
    # Pass window.messages to your LLM API call.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Optional

from .mock_provider import MockSummarizer, MockTokenizer, create_mock_summarizer, create_mock_tokenizer
from .types import ContextConfig, ContextStats, ContextWindow, Message, StrategyName, Tokenizer

if TYPE_CHECKING:
    from .mock_provider import MockSummarizer

__all__ = [
    "ContextManager",
    "ContextConfig",
    "ContextWindow",
    "ContextStats",
    "Message",
    "create_mock_tokenizer",
    "create_mock_summarizer",
    "MockTokenizer",
]

# ─── ID Generation ────────────────────────────────────────────────────────────

_id_counter = 0


def _generate_id() -> str:
    global _id_counter
    _id_counter += 1
    return f"msg-{int(time.time() * 1000)}-{_id_counter}"


# ─── Trim Strategies ──────────────────────────────────────────────────────────

def _sliding_window(messages: list[Message], budget: int, tokenizer: Tokenizer) -> list[Message]:
    """Keep all system messages and the most recent non-system messages that fit."""
    system_messages = [m for m in messages if m.role == "system"]
    non_system = [m for m in messages if m.role != "system"]

    system_tokens = sum(
        m.tokens if m.tokens is not None else tokenizer.count_tokens(m.content)
        for m in system_messages
    )
    remaining = budget - system_tokens

    # Walk non-system messages from most recent to oldest, keeping what fits.
    kept: list[Message] = []
    for msg in reversed(non_system):
        msg_tokens = msg.tokens if msg.tokens is not None else tokenizer.count_tokens(msg.content)
        if msg_tokens <= remaining:
            kept.insert(0, msg)
            remaining -= msg_tokens

    return system_messages + kept


def _priority_trim(messages: list[Message], budget: int, tokenizer: Tokenizer) -> list[Message]:
    """Keep all system messages and highest-priority non-system messages that fit.

    Within equal priority, recency wins (later index = more recent).
    """
    system_messages = [m for m in messages if m.role == "system"]
    non_system = [(i, m) for i, m in enumerate(messages) if m.role != "system"]

    system_tokens = sum(
        m.tokens if m.tokens is not None else tokenizer.count_tokens(m.content)
        for m in system_messages
    )
    remaining = budget - system_tokens

    # Sort by priority descending, then by original index descending (recency tiebreaker).
    non_system.sort(key=lambda x: (x[1].priority, x[0]), reverse=True)

    selected: list[tuple[int, Message]] = []
    for idx, msg in non_system:
        msg_tokens = msg.tokens if msg.tokens is not None else tokenizer.count_tokens(msg.content)
        if msg_tokens <= remaining:
            selected.append((idx, msg))
            remaining -= msg_tokens

    # Restore original order for the LLM call.
    selected.sort(key=lambda x: x[0])
    return system_messages + [m for _, m in selected]


def _summarize_trim(
    messages: list[Message],
    budget: int,
    keep_recent: int,
    tokenizer: Tokenizer,
    summarizer: MockSummarizer,
) -> list[Message]:
    """Keep the most recent keep_recent messages verbatim; compress older messages."""
    system_messages = [m for m in messages if m.role == "system"]
    non_system = [m for m in messages if m.role != "system"]

    system_tokens = sum(
        m.tokens if m.tokens is not None else tokenizer.count_tokens(m.content)
        for m in system_messages
    )
    available_for_non_system = budget - system_tokens

    recent_messages = non_system[-keep_recent:] if keep_recent > 0 else []
    older_messages = non_system[:-keep_recent] if keep_recent > 0 else non_system

    recent_tokens = sum(
        m.tokens if m.tokens is not None else tokenizer.count_tokens(m.content)
        for m in recent_messages
    )

    if not older_messages:
        # Nothing to compress — just apply sliding window to recent.
        return system_messages + _sliding_window(recent_messages, available_for_non_system, tokenizer)

    summary_budget = available_for_non_system - recent_tokens
    if summary_budget <= 0:
        # No room for even a summary — fall back to sliding window over full history.
        return _sliding_window(messages, budget, tokenizer)

    summary = summarizer.compress(older_messages, summary_budget)
    summary_tokens = summary.tokens if summary.tokens is not None else tokenizer.count_tokens(summary.content)

    if summary_tokens > summary_budget:
        # Summary too large — fall back to sliding window.
        return _sliding_window(messages, budget, tokenizer)

    return system_messages + [summary] + recent_messages


# ─── ContextManager (Public API) ──────────────────────────────────────────────


class ContextManager:
    """Manages what goes into an LLM context window.

    Maintains a growing history of messages and trims to a token budget when
    build() is called. System messages are always preserved regardless of strategy.

    Args:
        config: Configuration for token budget and trim strategy. Uses defaults if None.
        tokenizer: Tokenizer for counting tokens. Defaults to MockTokenizer.
        summarizer: Compressor for the 'summarize' strategy. Defaults to MockSummarizer.
    """

    def __init__(
        self,
        config: Optional[ContextConfig] = None,
        tokenizer: Optional[Tokenizer] = None,
        summarizer: Optional[MockSummarizer] = None,
    ) -> None:
        self._config = config or ContextConfig()
        self._tokenizer = tokenizer or create_mock_tokenizer()
        self._summarizer = summarizer or create_mock_summarizer(self._tokenizer)
        self._history: list[Message] = []

    def add(
        self,
        role: str = "user",
        content: str = "",
        priority: float = 0.5,
        id: Optional[str] = None,
        **kwargs,
    ) -> str:
        """Add a message to the history.

        Token count is cached on the Message object to avoid re-counting on every build().

        Returns:
            The generated message id (use with remove() if needed).
        """
        msg_id = id or _generate_id()
        tokens = self._tokenizer.count_tokens(content)
        self._history.append(
            Message(
                role=role,  # type: ignore[arg-type]
                content=content,
                id=msg_id,
                priority=priority,
                tokens=tokens,
            )
        )
        return msg_id

    def remove(self, id: str) -> bool:
        """Remove a specific message by id.

        Returns:
            True if the message was found and removed.
        """
        for i, m in enumerate(self._history):
            if m.id == id:
                self._history.pop(i)
                return True
        return False

    def clear(self) -> None:
        """Clear all message history."""
        self._history = []

    def get_history(self) -> list[Message]:
        """Read-only view of the full history (before any trimming)."""
        return list(self._history)

    def build(self) -> ContextWindow:
        """Build a context window that fits within the token budget.

        Applies the configured trim strategy if needed.
        System messages are always preserved.
        """
        available = self._config.max_tokens - self._config.reserve_for_output
        all_tokens = sum(
            m.tokens if m.tokens is not None else self._tokenizer.count_tokens(m.content)
            for m in self._history
        )

        if all_tokens <= available:
            included = list(self._history)
        else:
            included = self._apply_strategy(available)

        total_tokens = sum(
            m.tokens if m.tokens is not None else self._tokenizer.count_tokens(m.content)
            for m in included
        )

        return ContextWindow(
            messages=included,
            total_tokens=total_tokens,
            dropped_messages=len(self._history) - len(included),
            budget_used=total_tokens / available if available > 0 else 0.0,
            strategy=self._config.strategy,
        )

    def stats(self) -> ContextStats:
        """Current memory and budget stats without building a trimmed window."""
        available = self._config.max_tokens - self._config.reserve_for_output
        total_tokens = sum(
            m.tokens if m.tokens is not None else self._tokenizer.count_tokens(m.content)
            for m in self._history
        )
        return ContextStats(
            total_messages=len(self._history),
            total_tokens=total_tokens,
            budget_used=total_tokens / available if available > 0 else 0.0,
        )

    @property
    def config(self) -> ContextConfig:
        """Return a copy of the current config to prevent external mutation."""
        from dataclasses import replace
        return replace(self._config)

    def _apply_strategy(self, budget: int) -> list[Message]:
        if self._config.strategy == "sliding-window":
            return _sliding_window(self._history, budget, self._tokenizer)
        elif self._config.strategy == "priority":
            return _priority_trim(self._history, budget, self._tokenizer)
        elif self._config.strategy == "summarize":
            return _summarize_trim(
                self._history,
                budget,
                self._config.keep_recent,
                self._tokenizer,
                self._summarizer,
            )
        else:
            return _sliding_window(self._history, budget, self._tokenizer)

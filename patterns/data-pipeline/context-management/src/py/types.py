"""Types for the Context Management pattern."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional, Protocol

Role = Literal["system", "user", "assistant"]
StrategyName = Literal["sliding-window", "priority", "summarize"]


@dataclass
class Message:
    role: Role
    content: str
    id: str
    priority: float = 0.5
    """Importance score 0–1. Higher = more likely to survive trimming.
    System messages ignore this — they're always kept."""
    tokens: Optional[int] = None
    """Cached token count. Populated by ContextManager.add() to avoid re-counting."""


@dataclass
class ContextConfig:
    max_tokens: int = 128_000
    """Total context window size for the model being called."""
    reserve_for_output: int = 4_000
    """Tokens to reserve for model output. Available = max_tokens - reserve_for_output."""
    strategy: StrategyName = "sliding-window"
    """How to trim messages when total tokens exceed available budget."""
    keep_recent: int = 10
    """Summarize strategy only: how many recent messages to keep verbatim."""


@dataclass
class ContextWindow:
    messages: list[Message]
    """Messages to send to the LLM. Safe to pass directly as the messages array."""
    total_tokens: int
    """Total tokens for the included messages."""
    dropped_messages: int
    """Number of messages excluded due to budget constraints."""
    budget_used: float
    """Fraction of available budget consumed (0–1). Alert if approaching 1.0."""
    strategy: StrategyName


@dataclass
class ContextStats:
    total_messages: int
    total_tokens: int
    budget_used: float
    """Fraction of available budget currently used by the full history."""


class Tokenizer(Protocol):
    def count_tokens(self, text: str) -> int:
        ...

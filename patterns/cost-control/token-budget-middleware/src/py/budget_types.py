"""
Token Budget Middleware — Type Definitions

Core types for the token budget enforcement pattern.
Framework-agnostic, no external dependencies.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Optional


@dataclass
class LLMRequest:
    """A request to an LLM provider."""

    prompt: str
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None
    metadata: Optional[dict[str, Any]] = None


@dataclass
class LLMResponse:
    """A response from an LLM provider."""

    content: str
    tokens_used: int
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    model: Optional[str] = None
    finish_reason: Optional[str] = None


@dataclass
class BudgetContext:
    """Context for budget enforcement — identifies who/what the budget applies to."""

    budget_key: str = "global"
    parent_keys: Optional[list[str]] = None


@dataclass
class BudgetUsage:
    """Snapshot of budget usage for a given key."""

    budget_key: str
    tokens_used: int
    max_tokens: int
    remaining: int
    utilization: float
    window_start: float
    window_end: float


@dataclass
class BudgetedResponse:
    """Result of an execute() call, wrapping the LLM response with budget metadata."""

    response: LLMResponse
    usage: BudgetUsage
    warning_triggered: bool
    estimated_input_tokens: int
    actual_tokens: int


class BudgetScope(Enum):
    GLOBAL = "global"
    TEAM = "team"
    USER = "user"
    REQUEST = "request"


class ExceededStrategy(Enum):
    REJECT = "reject"
    THROTTLE = "throttle"
    WARN_ONLY = "warn-only"


class BudgetExceededError(Exception):
    """Raised when a request would exceed the token budget."""

    def __init__(self, usage: BudgetUsage, estimated_cost: int) -> None:
        self.usage = usage
        self.estimated_cost = estimated_cost
        super().__init__(
            f'Token budget exceeded for "{usage.budget_key}": '
            f"{usage.tokens_used}/{usage.max_tokens} tokens used, "
            f"request would add ~{estimated_cost} tokens"
        )

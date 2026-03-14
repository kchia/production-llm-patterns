"""
Agent Loop Guards — Type Definitions

Uses dataclasses and Literal types for idiomatic Python typing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Protocol

HaltReason = Literal[
    "max_turns",
    "max_tokens",
    "max_duration",
    "repeated_calls",
    "no_progress",
    "abort_signal",
]


@dataclass
class ToolCall:
    """A single tool call made by the LLM."""

    name: str
    arguments: dict[str, Any]


@dataclass
class LLMResponse:
    """LLM response containing optional tool calls and text."""

    tool_calls: list[ToolCall]
    tokens_used: int
    text: str | None = None


@dataclass
class Message:
    """A message in the conversation."""

    role: Literal["system", "user", "assistant", "tool"]
    content: str
    tool_call_id: str | None = None


@dataclass
class ToolDefinition:
    """Definition of a tool the LLM can call."""

    name: str
    description: str
    parameters: dict[str, Any]


@dataclass
class LoopContext:
    """Snapshot of loop state at any point during execution."""

    turn_count: int = 0
    total_tokens: int = 0
    elapsed_ms: float = 0.0
    tool_call_history: list[ToolCall] = field(default_factory=list)
    halt_reason: HaltReason | None = None


@dataclass
class LoopGuardConfig:
    """Configuration for the loop guard."""

    max_turns: int = 25
    max_tokens: int = 100_000
    max_duration_ms: float = 120_000
    max_repeated_calls: int = 3
    convergence_window: int = 5
    on_halt: Callable[[HaltReason, LoopContext], None] | None = None


@dataclass
class AgentResult:
    """Result returned by the guarded agent loop."""

    response: str
    halted: bool
    context: LoopContext
    halt_reason: HaltReason | None = None


class LLMProvider(Protocol):
    """Protocol for LLM providers — implemented by both mock and real providers."""

    async def call(
        self, messages: list[Message], tools: list[ToolDefinition]
    ) -> LLMResponse: ...


# Callable type for tool executors
ToolExecutor = Callable[[str, dict[str, Any]], Any]


# Expose default config as a factory function (dataclasses are mutable,
# so a fresh instance per use avoids shared-state bugs)
def default_config() -> LoopGuardConfig:
    return LoopGuardConfig()

"""
Mock LLM Provider for Agent Loop Guards

Simulates LLM behavior with configurable:
- Latency per call
- Token counts per response
- Tool call sequences (scripted or cycling)
- Error injection
- Loop simulation (repeated identical tool calls)
"""

from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass, field

from ._types import LLMResponse, Message, ToolCall, ToolDefinition


@dataclass
class MockProviderConfig:
    """Configuration for the mock provider."""

    latency_ms: float = 50.0
    latency_jitter_ms: float = 10.0
    tokens_per_response: int = 150
    scripted_responses: list[LLMResponse] = field(default_factory=list)
    simulate_loop: bool = False
    loop_tool_call: ToolCall | None = None
    loop_start_after: int = 2
    error_on_turns: list[int] = field(default_factory=list)
    error_message: str = "Mock provider error"


class MockProvider:
    """Mock LLM provider for testing and benchmarks."""

    def __init__(self, config: MockProviderConfig | None = None) -> None:
        self._config = config or MockProviderConfig()
        if self._config.loop_tool_call is None:
            self._config.loop_tool_call = ToolCall(
                name="search", arguments={"query": "same query"}
            )
        self._call_count = 0
        self._script_index = 0

    async def call(
        self, _messages: list[Message], _tools: list[ToolDefinition]
    ) -> LLMResponse:
        current_call = self._call_count
        self._call_count += 1

        # Simulate latency — skip sleep entirely when delay is 0
        # to avoid asyncio.sleep overhead in benchmarks
        jitter = (random.random() - 0.5) * 2 * self._config.latency_jitter_ms
        delay = max(0.0, self._config.latency_ms + jitter)
        if delay > 0:
            await asyncio.sleep(delay / 1000)

        # Error injection
        if current_call in self._config.error_on_turns:
            raise RuntimeError(self._config.error_message)

        # Scripted responses take priority
        if self._config.scripted_responses:
            resp = self._config.scripted_responses[self._script_index]
            self._script_index = (
                self._script_index + 1
            ) % len(self._config.scripted_responses)
            # Use scripted tokens_used if set, otherwise default
            tokens = (
                resp.tokens_used
                if resp.tokens_used
                else self._config.tokens_per_response
            )
            return LLMResponse(
                text=resp.text,
                tool_calls=list(resp.tool_calls),
                tokens_used=tokens,
            )

        # Loop simulation
        if (
            self._config.simulate_loop
            and current_call >= self._config.loop_start_after
        ):
            assert self._config.loop_tool_call is not None
            return LLMResponse(
                tool_calls=[self._config.loop_tool_call],
                tokens_used=self._config.tokens_per_response,
            )

        # Default: text response with no tool calls (natural completion)
        return LLMResponse(
            text=f"Response for turn {current_call}",
            tool_calls=[],
            tokens_used=self._config.tokens_per_response,
        )

    def reset(self) -> None:
        """Reset call counter and script index for reuse."""
        self._call_count = 0
        self._script_index = 0

    @property
    def call_count(self) -> int:
        return self._call_count

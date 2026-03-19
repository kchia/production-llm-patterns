"""
Mock LLM provider for testing and benchmarks.
Supports configurable latency, error injection, and tool call response scenarios.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, Union
from typing import Literal

from .types import LLMProvider, Message, RawToolCall, ToolSchema


ValidScenario = dict  # typed below via TypedDict-like dicts for simplicity


@dataclass
class MockProviderConfig:
    # Latency in ms added to each call. Default: 0
    latency_ms: int = 0
    # Sequence of scenarios to return, in order (cycles when exhausted)
    scenarios: list[dict] = field(default_factory=lambda: [
        {"type": "valid-call", "tool_name": "get_weather", "args": {"city": "Seattle"}}
    ])
    # Token counts for cost tracking. Default: 500 input, 100 output
    input_tokens: int = 500
    output_tokens: int = 100


class MockLLMProvider:
    """
    Deterministic mock provider for testing.
    Cycles through scenarios in order, allowing precise control over call behavior.
    """

    def __init__(self, config: MockProviderConfig | None = None) -> None:
        self.config = config or MockProviderConfig()
        self._call_count = 0

    async def chat(
        self,
        messages: list[Message],
        tools: list[ToolSchema],
    ) -> Message:
        if self.config.latency_ms > 0:
            await asyncio.sleep(self.config.latency_ms / 1000)

        scenario = self.config.scenarios[self._call_count % len(self.config.scenarios)]
        self._call_count += 1
        return self._build_response(scenario)

    def _build_response(self, scenario: dict) -> Message:
        stype = scenario["type"]

        if stype == "valid-call":
            tool_call = RawToolCall(
                id=f"call_{self._call_count}",
                name=scenario["tool_name"],
                arguments=json.dumps(scenario["args"]),
            )
            return Message(role="assistant", content="", tool_calls=[tool_call])

        elif stype == "malformed-json":
            # Invalid JSON — missing closing brace
            tool_call = RawToolCall(
                id=f"call_{self._call_count}",
                name="get_weather",
                arguments='{city: "Seattle"',
            )
            return Message(role="assistant", content="", tool_calls=[tool_call])

        elif stype in ("wrong-type", "missing-required"):
            tool_call = RawToolCall(
                id=f"call_{self._call_count}",
                name=scenario["tool_name"],
                arguments=json.dumps(scenario["args"]),
            )
            return Message(role="assistant", content="", tool_calls=[tool_call])

        elif stype == "hallucinated-tool":
            tool_call = RawToolCall(
                id=f"call_{self._call_count}",
                name=scenario["tool_name"],
                arguments=json.dumps({"query": "test"}),
            )
            return Message(role="assistant", content="", tool_calls=[tool_call])

        elif stype == "api-error":
            raise RuntimeError(scenario["message"])

        elif stype == "repair-success":
            tool_call = RawToolCall(
                id=f"call_{self._call_count}",
                name=scenario["tool_name"],
                arguments=json.dumps(scenario["args"]),
            )
            return Message(role="assistant", content="", tool_calls=[tool_call])

        elif stype == "no-tool-call":
            return Message(role="assistant", content=scenario["content"])

        else:
            raise ValueError(f"Unknown scenario type: {stype}")

    def reset(self) -> None:
        """Reset call counter (useful between test cases)."""
        self._call_count = 0

    @property
    def call_count(self) -> int:
        return self._call_count

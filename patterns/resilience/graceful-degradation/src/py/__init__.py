"""
Graceful Degradation — DegradationChain

Walks an ordered chain of quality tiers to produce the best available response.
When the primary LLM provider fails, the chain falls through to progressively
lower-quality but more reliable alternatives.

Framework-agnostic. No external dependencies.
"""

from __future__ import annotations

import asyncio
import time
from typing import Callable

from .types import (
    AllTiersExhaustedError,
    DegradationResult,
    DegradationTier,
    LLMRequest,
    LLMResponse,
    TierAttempt,
)


class DegradationChain:
    """Walks an ordered chain of quality tiers for graceful degradation."""

    def __init__(
        self,
        tiers: list[DegradationTier],
        global_timeout_ms: float = 5000.0,
        min_quality: float = 0.0,
        on_degradation: Callable[[DegradationResult], None] | None = None,
    ) -> None:
        if not tiers:
            # ValueError: Python convention for invalid constructor arguments
            raise ValueError("DegradationChain requires at least one tier")

        self._tiers = tiers
        self._global_timeout_ms = global_timeout_ms
        self._min_quality = min_quality
        self._on_degradation = on_degradation

    async def execute(self, request: LLMRequest) -> DegradationResult:
        """Execute the degradation chain for a request.

        Walks tiers in order until one succeeds or all are exhausted.
        """
        # perf_counter: monotonic, high-resolution (vs time.time() which drifts with NTP)
        chain_start = time.perf_counter()
        attempts: list[TierAttempt] = []

        for i, tier in enumerate(self._tiers):
            elapsed_ms = (time.perf_counter() - chain_start) * 1000

            # Check global timeout
            if elapsed_ms >= self._global_timeout_ms:
                for remaining_tier in self._tiers[i:]:
                    attempts.append(
                        TierAttempt(
                            tier=remaining_tier.name,
                            status="timeout",
                            latency_ms=0,
                            error="Global timeout exceeded",
                        )
                    )
                break

            # Skip tiers below minimum quality
            if tier.quality_score < self._min_quality:
                attempts.append(
                    TierAttempt(
                        tier=tier.name,
                        status="skipped_quality",
                        latency_ms=0,
                        error=f"Quality {tier.quality_score} below minimum {self._min_quality}",
                    )
                )
                continue

            # Skip unhealthy tiers
            if tier.is_healthy is not None and not tier.is_healthy():
                attempts.append(
                    TierAttempt(
                        tier=tier.name,
                        status="skipped_unhealthy",
                        latency_ms=0,
                        error="Tier reported unhealthy",
                    )
                )
                continue

            # Attempt the tier with its per-tier timeout
            tier_start = time.perf_counter()
            remaining_global_ms = self._global_timeout_ms - elapsed_ms
            effective_timeout_ms = min(tier.timeout_ms, remaining_global_ms)

            try:
                # wait_for cancels the underlying task on timeout — no resource leaks
                response = await asyncio.wait_for(
                    tier.handler(request),
                    timeout=effective_timeout_ms / 1000,
                )
                tier_latency = (time.perf_counter() - tier_start) * 1000

                attempts.append(
                    TierAttempt(
                        tier=tier.name,
                        status="success",
                        latency_ms=tier_latency,
                    )
                )

                result = DegradationResult(
                    response=response,
                    tier=tier.name,
                    quality=tier.quality_score,
                    latency_ms=(time.perf_counter() - chain_start) * 1000,
                    degraded=i > 0,
                    attempted_tiers=attempts,
                )

                if i > 0 and self._on_degradation is not None:
                    self._on_degradation(result)

                return result

            except asyncio.TimeoutError:
                tier_latency = (time.perf_counter() - tier_start) * 1000
                attempts.append(
                    TierAttempt(
                        tier=tier.name,
                        status="timeout",
                        latency_ms=tier_latency,
                        error="Operation timed out",
                    )
                )

            except Exception as exc:
                tier_latency = (time.perf_counter() - tier_start) * 1000
                attempts.append(
                    TierAttempt(
                        tier=tier.name,
                        status="failure",
                        latency_ms=tier_latency,
                        error=str(exc),
                    )
                )

        raise AllTiersExhaustedError(attempts)


__all__ = [
    "DegradationChain",
    "AllTiersExhaustedError",
    "DegradationResult",
    "DegradationTier",
    "LLMRequest",
    "LLMResponse",
    "TierAttempt",
]

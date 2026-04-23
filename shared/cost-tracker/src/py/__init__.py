"""
cost-tracker — Core Implementation

Three exports:
  1. BUILT_IN_PRICES       — model price table (authoritative source of truth)
  2. CostTracker           — computes cost for a single LLM call
  3. SpendAccumulator      — running totals grouped by label

Usage pattern:
  tracker = CostTracker()
  record  = tracker.record(model="gpt-4o", input_tokens=500, output_tokens=100)
  accumulator.add(record)
  snapshot = accumulator.snapshot("user-123")
"""

from __future__ import annotations

import math
import time
from typing import Callable, Optional

from .types import CostRecord, ModelPrice, SpendSnapshot, TokenUsage

# ─── Built-in Price Table ─────────────────────────────────────────────────────

# Prices in USD per 1M tokens. Verified against provider docs January 2026.
# Production deployments should refresh this on a schedule — prices change.
#
# Canonical source: import from here instead of hardcoding in each pattern.
BUILT_IN_PRICES: list[ModelPrice] = [
    ModelPrice("gpt-4o",            input_price_per_million=2.50,  output_price_per_million=10.00),
    ModelPrice("gpt-4o-mini",       input_price_per_million=0.15,  output_price_per_million=0.60),
    ModelPrice("claude-sonnet-4-6", input_price_per_million=3.00,  output_price_per_million=15.00),
    ModelPrice("claude-haiku-4-5",  input_price_per_million=0.80,  output_price_per_million=4.00),
]

# ─── Token Estimator ──────────────────────────────────────────────────────────


def estimate_tokens(text: str) -> int:
    """
    Estimate token count from raw text before making a provider call.

    Uses the 4-chars-per-token heuristic (English text). Over-estimates slightly
    compared to tiktoken — intentional for budget-gate safety.

    Exported so patterns can import one canonical implementation.
    """
    return math.ceil(len(text) / 4)


# ─── Cost Computation ─────────────────────────────────────────────────────────


def compute_cost(input_tokens: int, output_tokens: int, price: ModelPrice) -> float:
    """
    Compute the USD cost for a known token usage + model.

    Args:
        input_tokens:  tokens in the prompt/context
        output_tokens: tokens in the completion
        price:         the ModelPrice entry for this model

    Returns:
        USD cost (may be very small — use f"{cost:.6f}" when displaying)
    """
    input_cost = (input_tokens / 1_000_000) * price.input_price_per_million
    output_cost = (output_tokens / 1_000_000) * price.output_price_per_million
    return input_cost + output_cost


# ─── CostTracker ──────────────────────────────────────────────────────────────


class CostTracker:
    """
    Computes and records cost for individual LLM calls.

    Stateless beyond the price table — each call to record() returns a CostRecord
    that callers can pass to a SpendAccumulator or log directly.
    """

    def __init__(
        self,
        prices: Optional[list[ModelPrice]] = None,
        unknown_model_price: Optional[ModelPrice] = None,
        estimate_tokens_fn: Optional[Callable[[str], int]] = None,
    ) -> None:
        price_list = prices if prices is not None else BUILT_IN_PRICES
        self._prices: dict[str, ModelPrice] = {p.model: p for p in price_list}

        # Conservative fallback: over-count is safer than under-count for budgets
        self._unknown_model_price = unknown_model_price or ModelPrice(
            model="unknown",
            input_price_per_million=2.50,
            output_price_per_million=10.00,
        )

        self._estimate_tokens = estimate_tokens_fn or estimate_tokens

    def get_price(self, model: str) -> ModelPrice:
        """
        Look up a model's price. Returns the fallback price for unknown models
        rather than raising — callers don't need to handle unknown model errors.
        """
        if model in self._prices:
            return self._prices[model]
        # Return a copy with the actual model name for accurate CostRecord.model
        fallback = self._unknown_model_price
        return ModelPrice(
            model=model,
            input_price_per_million=fallback.input_price_per_million,
            output_price_per_million=fallback.output_price_per_million,
        )

    def record(
        self,
        *,
        model: str,
        input_tokens: int,
        output_tokens: int,
        label: Optional[str] = None,
        timestamp: Optional[float] = None,
    ) -> CostRecord:
        """
        Record the cost of a completed LLM call.

        Call this after the provider responds (with real token counts).
        For pre-call estimates, use estimate() instead.
        """
        price = self.get_price(model)
        cost_usd = compute_cost(input_tokens, output_tokens, price)

        usage = TokenUsage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=input_tokens + output_tokens,
        )

        return CostRecord(
            model=model,
            usage=usage,
            cost_usd=cost_usd,
            timestamp=timestamp if timestamp is not None else time.time(),
            label=label,
        )

    def estimate(
        self,
        *,
        model: str,
        prompt_text: str,
        expected_output_tokens: int = 256,
    ) -> dict[str, float | int]:
        """
        Estimate the cost of a prompt before calling the provider.

        Useful for budget-check gates — pair with record() to compare estimate vs. actual.

        Returns a dict with:
            estimated_input_tokens, estimated_output_tokens, estimated_cost_usd
        """
        estimated_input_tokens = self._estimate_tokens(prompt_text)
        price = self.get_price(model)
        estimated_cost_usd = compute_cost(estimated_input_tokens, expected_output_tokens, price)
        return {
            "estimated_input_tokens": estimated_input_tokens,
            "estimated_output_tokens": expected_output_tokens,
            "estimated_cost_usd": estimated_cost_usd,
        }


# ─── SpendAccumulator ─────────────────────────────────────────────────────────


class SpendAccumulator:
    """
    Accumulates CostRecords into running totals grouped by label.

    Useful for per-user, per-feature, or per-session cost tracking without
    pulling in the full cost-dashboard pattern's store+query+alert infrastructure.

    Not thread-safe — single-process only. For multi-process aggregation,
    use the cost-dashboard pattern's SpendStore instead.
    """

    def __init__(self) -> None:
        self._totals: dict[str, SpendSnapshot] = {}

    def add(self, record: CostRecord) -> None:
        label = record.label or "unlabeled"

        if label in self._totals:
            existing = self._totals[label]
            self._totals[label] = SpendSnapshot(
                label=label,
                total_cost_usd=existing.total_cost_usd + record.cost_usd,
                total_input_tokens=existing.total_input_tokens + record.usage.input_tokens,
                total_output_tokens=existing.total_output_tokens + record.usage.output_tokens,
                total_requests=existing.total_requests + 1,
            )
        else:
            self._totals[label] = SpendSnapshot(
                label=label,
                total_cost_usd=record.cost_usd,
                total_input_tokens=record.usage.input_tokens,
                total_output_tokens=record.usage.output_tokens,
                total_requests=1,
            )

    def snapshot(self, label: str) -> SpendSnapshot:
        """Returns the snapshot for a specific label. Returns zeroed snapshot if not found."""
        return self._totals.get(
            label,
            SpendSnapshot(
                label=label,
                total_cost_usd=0.0,
                total_input_tokens=0,
                total_output_tokens=0,
                total_requests=0,
            ),
        )

    def all_snapshots(self) -> list[SpendSnapshot]:
        """Returns snapshots for all labels."""
        return list(self._totals.values())

    def global_total(self) -> SpendSnapshot:
        """Returns the global total across all labels."""
        snapshots = self.all_snapshots()
        return SpendSnapshot(
            label="all",
            total_cost_usd=sum(s.total_cost_usd for s in snapshots),
            total_input_tokens=sum(s.total_input_tokens for s in snapshots),
            total_output_tokens=sum(s.total_output_tokens for s in snapshots),
            total_requests=sum(s.total_requests for s in snapshots),
        )

    def reset(self) -> None:
        """Resets all accumulated state. Useful between test runs."""
        self._totals.clear()

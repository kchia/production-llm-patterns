"""
cost-tracker — Type Definitions

Shared types for computing and accumulating LLM API costs.
Framework-agnostic. No external dependencies.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class ModelPrice:
    """Per-model pricing. All prices in USD per 1M tokens."""

    model: str
    input_price_per_million: float
    output_price_per_million: float


@dataclass
class TokenUsage:
    """Token counts for a single LLM request/response pair."""

    input_tokens: int
    output_tokens: int
    total_tokens: int


@dataclass
class CostRecord:
    """
    Cost attributed to a single LLM call.

    Produced by CostTracker.record(); consumed by SpendAccumulator.
    """

    model: str
    usage: TokenUsage
    cost_usd: float
    timestamp: float  # Unix epoch seconds
    label: Optional[str] = None


@dataclass
class SpendSnapshot:
    """Running totals for a spend accumulator."""

    label: str
    total_cost_usd: float
    total_input_tokens: int
    total_output_tokens: int
    total_requests: int

"""
Cost Dashboard — Type Definitions

Python uses dataclasses for structured data (vs. TypeScript interfaces).
Enums replace union string literals. Optional fields use Optional[T].
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional


class GroupByDimension(str, Enum):
    FEATURE = "feature"
    MODEL = "model"
    USER = "user"
    PROMPT_VERSION = "promptVersion"
    TEAM = "team"


class AlertType(str, Enum):
    SPIKE = "spike"
    CONCENTRATION_RISK = "concentrationRisk"
    MISSING_TAGS = "missingTags"
    PRICE_TABLE_STALE = "priceTableStale"


class AlertSeverity(str, Enum):
    WARNING = "warning"
    CRITICAL = "critical"


@dataclass
class CostEvent:
    timestamp: datetime
    request_id: str
    feature: str          # Mandatory attribution dimension
    model: str
    prompt_version: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    latency_ms: int
    tags: dict[str, str] = field(default_factory=dict)
    user_id: Optional[str] = None
    team_id: Optional[str] = None


@dataclass
class ModelPrice:
    model: str
    input_price_per_million_tokens: float
    output_price_per_million_tokens: float
    fetched_at: datetime = field(default_factory=datetime.utcnow)


@dataclass
class SpendSummary:
    dimension_value: str
    total_cost_usd: float
    total_requests: int
    total_input_tokens: int
    total_output_tokens: int
    avg_cost_per_request_usd: float
    start_time: datetime
    end_time: datetime


@dataclass
class QueryFilters:
    feature: Optional[str] = None
    model: Optional[str] = None
    user_id: Optional[str] = None
    team_id: Optional[str] = None


@dataclass
class QueryParams:
    group_by: GroupByDimension
    start_time: datetime
    end_time: datetime
    filters: Optional[QueryFilters] = None
    min_cost_usd: Optional[float] = None


@dataclass
class AlertConfig:
    spike_sensitivity: float = 2.5
    concentration_risk_threshold: float = 0.40
    baseline_window_hours: int = 168   # 7 days
    current_window_hours: int = 1


@dataclass
class Alert:
    type: AlertType
    severity: AlertSeverity
    message: str
    context: dict[str, float | str | int]
    fired_at: datetime


@dataclass
class CostDashboardConfig:
    required_tags: list[str] = field(default_factory=lambda: ["feature"])
    retention_days: int = 90
    rollup_interval_minutes: int = 60
    price_refresh_interval_seconds: int = 3600
    alert_config: AlertConfig = field(default_factory=AlertConfig)


# Built-in price table. Prices in USD per 1M tokens.
# Production systems should refresh from provider docs — prices change frequently.
BUILT_IN_PRICES: list[ModelPrice] = [
    ModelPrice("gpt-4o",            input_price_per_million_tokens=2.50,  output_price_per_million_tokens=10.00),
    ModelPrice("gpt-4o-mini",       input_price_per_million_tokens=0.15,  output_price_per_million_tokens=0.60),
    ModelPrice("claude-sonnet-4-6", input_price_per_million_tokens=3.00,  output_price_per_million_tokens=15.00),
    ModelPrice("claude-haiku-4-5",  input_price_per_million_tokens=0.80,  output_price_per_million_tokens=4.00),
]

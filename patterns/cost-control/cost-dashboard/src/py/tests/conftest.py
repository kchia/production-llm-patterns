"""
Shared pytest fixtures for Cost Dashboard tests.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from cost_dashboard import CostDashboard, InMemorySpendStore, PriceTable
from cost_dashboard.types import BUILT_IN_PRICES, CostEvent


@pytest.fixture
def price_table() -> PriceTable:
    return PriceTable(BUILT_IN_PRICES)


@pytest.fixture
def store() -> InMemorySpendStore:
    return InMemorySpendStore()


@pytest.fixture
def dashboard() -> CostDashboard:
    return CostDashboard()


def make_event(**kwargs) -> CostEvent:
    """Create a CostEvent with sensible defaults, overridable via kwargs."""
    defaults = dict(
        timestamp=datetime.now(timezone.utc),
        request_id="req-1",
        feature="document-analysis",
        model="gpt-4o",
        prompt_version="v1.0",
        input_tokens=500,
        output_tokens=150,
        cost_usd=0.00275,
        latency_ms=210,
        tags={},
    )
    defaults.update(kwargs)
    return CostEvent(**defaults)

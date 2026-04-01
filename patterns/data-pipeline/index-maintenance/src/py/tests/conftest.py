"""Shared pytest fixtures for Index Maintenance tests."""

import pytest

from ..mock_provider import MockCollectionConfig, MockVectorStoreAdapter
from .. import IndexMaintenanceScheduler
from ..types import DEFAULT_CONFIG, MaintenanceConfig

COLLECTION = "test-collection"


def make_scheduler(
    adapter: MockVectorStoreAdapter,
    **overrides,
) -> IndexMaintenanceScheduler:
    config = MaintenanceConfig(
        **{
            **DEFAULT_CONFIG.__dict__,
            "maintenance_cooldown_ms": 0,  # disable in most tests
            **overrides,
        }
    )
    return IndexMaintenanceScheduler(adapter, config)


@pytest.fixture
def adapter() -> MockVectorStoreAdapter:
    return MockVectorStoreAdapter()


@pytest.fixture
def healthy_adapter() -> MockVectorStoreAdapter:
    a = MockVectorStoreAdapter()
    a.configure(
        COLLECTION,
        MockCollectionConfig(
            total_vectors=100_000,
            deleted_vectors=1_000,
            segment_count=5,
            query_filter_fields=["category"],
            indexed_fields=["category"],
        ),
    )
    return a

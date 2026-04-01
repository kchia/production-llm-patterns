"""Shared fixtures for multi-agent routing tests."""

import pytest
from ..types import AgentCapability
from ..mock_provider import MockProviderConfig, MockRoutingOverride


@pytest.fixture
def billing_agent() -> AgentCapability:
    return AgentCapability(
        id="billing",
        description="Handles billing and payment questions, invoices, refunds",
        examples=["How do I update my credit card?", "I was charged twice", "Where is my invoice?"],
        priority=1,
    )


@pytest.fixture
def support_agent() -> AgentCapability:
    return AgentCapability(
        id="support",
        description="Handles general product support, troubleshooting, and how-to questions",
        examples=["How do I reset my password?", "The app is crashing", "Where is the settings page?"],
        priority=0,
    )


@pytest.fixture
def fallback_agent() -> AgentCapability:
    return AgentCapability(
        id="fallback",
        description="General-purpose fallback for unclassified requests",
        examples=[],
        priority=0,
    )

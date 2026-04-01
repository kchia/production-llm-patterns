"""
Tests for the Multi-Agent Routing pattern (Python).

Three categories:
  1. Unit tests — registry, confidence gating, parsing, audit log
  2. Failure mode tests — one per failure mode in the README Failure Modes table
  3. Integration tests — end-to-end with mock provider
"""

import asyncio
import pytest

from .. import MultiAgentRouter
from ..mock_provider import MockLLMProvider, MockProviderConfig, MockRoutingOverride
from ..types import AgentCapability, RouterConfig


# ─── Helpers ────────────────────────────────────────────────────────────────


def make_router(
    config: RouterConfig | None = None,
    provider_config: MockProviderConfig | None = None,
    billing_agent: AgentCapability | None = None,
    support_agent: AgentCapability | None = None,
) -> tuple[MultiAgentRouter, MockLLMProvider]:
    provider = MockLLMProvider(provider_config)
    router = MultiAgentRouter(provider, config)
    if billing_agent:
        router.register(billing_agent)
    if support_agent:
        router.register(support_agent)
    return router, provider


# ─── Unit: Agent Registry ───────────────────────────────────────────────────


class TestAgentRegistry:
    def test_registers_and_lists_agents(self, billing_agent, support_agent):
        router = MultiAgentRouter(MockLLMProvider())
        router.register(billing_agent)
        router.register(support_agent)
        ids = {a.id for a in router.registered_agents}
        assert ids == {"billing", "support"}

    def test_raises_on_duplicate_id(self, billing_agent):
        router = MultiAgentRouter(MockLLMProvider())
        router.register(billing_agent)
        with pytest.raises(ValueError, match="already registered"):
            router.register(billing_agent)

    def test_unregisters_agents(self, billing_agent):
        router = MultiAgentRouter(MockLLMProvider())
        router.register(billing_agent)
        router.unregister("billing")
        assert router.registered_agents == []

    async def test_raises_when_no_agents_registered(self):
        router = MultiAgentRouter(MockLLMProvider())
        with pytest.raises(ValueError, match="No agents registered"):
            await router.handle("any request")


# ─── Unit: Confidence Gating ─────────────────────────────────────────────────


class TestConfidenceGating:
    async def test_routes_high_confidence_to_agent(self, billing_agent, support_agent):
        router, _ = make_router(
            config=RouterConfig(confidence_threshold=0.75),
            provider_config=MockProviderConfig(
                routing_override=MockRoutingOverride("billing", 0.92, "Billing question")
            ),
            billing_agent=billing_agent,
            support_agent=support_agent,
        )
        response = await router.handle("I need a refund")
        assert response.agent_id == "billing"
        assert response.routing_decision.fallback is False

    async def test_activates_fallback_below_threshold(self, billing_agent, fallback_agent):
        router = MultiAgentRouter(
            MockLLMProvider(MockProviderConfig(
                routing_override=MockRoutingOverride("billing", 0.35, "Uncertain")
            )),
            RouterConfig(fallback_agent_id="fallback"),
        )
        router.register(billing_agent)
        router.register(fallback_agent)

        response = await router.handle("something unclear")
        assert response.agent_id == "fallback"
        assert response.routing_decision.fallback is True

    async def test_raises_when_low_confidence_no_fallback(self, billing_agent, support_agent):
        router, _ = make_router(
            config=RouterConfig(confidence_threshold=0.75),
            provider_config=MockProviderConfig(
                routing_override=MockRoutingOverride("billing", 0.40, "Low confidence")
            ),
            billing_agent=billing_agent,
            support_agent=support_agent,
        )
        with pytest.raises(ValueError, match="below threshold"):
            await router.handle("unclear request")

    async def test_respects_custom_threshold(self, billing_agent, support_agent):
        # With threshold=0.5, confidence=0.6 should NOT trigger fallback
        router, _ = make_router(
            config=RouterConfig(confidence_threshold=0.5),
            provider_config=MockProviderConfig(
                routing_override=MockRoutingOverride("support", 0.6, "Support question")
            ),
            billing_agent=billing_agent,
            support_agent=support_agent,
        )
        response = await router.handle("how do I reset my password?")
        assert response.agent_id == "support"
        assert response.routing_decision.fallback is False


# ─── Unit: Routing Response Parsing ──────────────────────────────────────────


class TestRoutingResponseParsing:
    async def test_fallback_on_unparseable_json(self, billing_agent, fallback_agent):
        router = MultiAgentRouter(
            MockLLMProvider(MockProviderConfig(response_sequence=["not valid json at all"])),
            RouterConfig(fallback_agent_id="fallback"),
        )
        router.register(billing_agent)
        router.register(fallback_agent)

        response = await router.handle("any request")
        assert response.agent_id == "fallback"
        assert response.routing_decision.fallback is True

    async def test_fallback_on_unknown_agent_id(self, billing_agent, fallback_agent):
        router = MultiAgentRouter(
            MockLLMProvider(MockProviderConfig(
                routing_override=MockRoutingOverride("nonexistent", 0.99, "Ghost")
            )),
            RouterConfig(fallback_agent_id="fallback"),
        )
        router.register(billing_agent)
        router.register(fallback_agent)

        response = await router.handle("any request")
        assert response.agent_id == "fallback"
        assert response.routing_decision.fallback is True

    async def test_raises_on_unknown_agent_no_fallback(self, billing_agent):
        router = MultiAgentRouter(
            MockLLMProvider(MockProviderConfig(
                routing_override=MockRoutingOverride("nonexistent", 0.99, "Ghost")
            )),
        )
        router.register(billing_agent)
        with pytest.raises((ValueError, Exception)):
            await router.handle("any request")


# ─── Unit: Audit Log ──────────────────────────────────────────────────────────


class TestAuditLog:
    async def test_logs_each_routing_decision(self, billing_agent, support_agent):
        router, _ = make_router(
            provider_config=MockProviderConfig(
                routing_override=MockRoutingOverride("billing", 0.9, "Billing")
            ),
            billing_agent=billing_agent,
            support_agent=support_agent,
        )
        await router.handle("first request")
        await router.handle("second request")
        log = router.get_audit_log()
        assert len(log) == 2
        assert log[0].decision.agent_id == "billing"

    async def test_routing_stats_track_fallbacks(self, billing_agent, fallback_agent):
        router = MultiAgentRouter(
            MockLLMProvider(MockProviderConfig(
                routing_override=MockRoutingOverride("billing", 0.4, "Low")
            )),
            RouterConfig(fallback_agent_id="fallback"),
        )
        router.register(billing_agent)
        router.register(fallback_agent)

        await router.handle("request 1")
        await router.handle("request 2")

        stats = router.get_routing_stats()
        assert stats["fallback"].count == 2
        assert stats["fallback"].fallback_count == 2


# ─── Failure Mode Tests ───────────────────────────────────────────────────────


class TestFailureModes:
    # FM1: Misclassification cascade — audit log captures wrong routing for retrospective analysis
    async def test_fm1_audit_log_captures_misrouted_requests(self, billing_agent, support_agent):
        router = MultiAgentRouter(
            MockLLMProvider(MockProviderConfig(
                routing_override=MockRoutingOverride("billing", 0.91, "Incorrectly classified")
            )),
        )
        router.register(billing_agent)
        router.register(support_agent)

        response = await router.handle("how do I reset my password?")
        assert response.agent_id == "billing"  # Wrong, but logged

        log = router.get_audit_log()
        assert log[0].decision.agent_id == "billing"
        assert log[0].request == "how do I reset my password?"

    # FM2: Capability description drift — low confidence triggers fallback
    async def test_fm2_stale_descriptions_route_to_fallback(self, billing_agent, fallback_agent):
        router = MultiAgentRouter(
            MockLLMProvider(MockProviderConfig(
                routing_override=MockRoutingOverride("billing", 0.30, "Outdated description")
            )),
            RouterConfig(fallback_agent_id="fallback"),
        )
        router.register(billing_agent)
        router.register(fallback_agent)

        response = await router.handle("process my enterprise license renewal")
        assert response.agent_id == "fallback"
        assert response.routing_decision.fallback is True
        assert "Low confidence" in response.routing_decision.reasoning

    # FM3: Ambiguous multi-intent — low confidence activates fallback
    async def test_fm3_ambiguous_request_falls_back(self, billing_agent, support_agent, fallback_agent):
        router = MultiAgentRouter(
            MockLLMProvider(MockProviderConfig(
                routing_override=MockRoutingOverride("billing", 0.55, "Spans billing and support")
            )),
            RouterConfig(confidence_threshold=0.75, fallback_agent_id="fallback"),
        )
        router.register(billing_agent)
        router.register(support_agent)
        router.register(fallback_agent)

        response = await router.handle("cancel subscription AND fix broken account")
        assert response.agent_id == "fallback"
        assert response.routing_decision.fallback is True

    # FM4: Fallback overload — routing stats detect all requests going to fallback
    async def test_fm4_routing_stats_detect_fallback_overload(self, billing_agent, fallback_agent):
        router = MultiAgentRouter(
            MockLLMProvider(MockProviderConfig(
                routing_override=MockRoutingOverride("billing", 0.20, "No match")
            )),
            RouterConfig(fallback_agent_id="fallback"),
        )
        router.register(billing_agent)
        router.register(fallback_agent)

        for i in range(5):
            await router.handle(f"request {i}")

        stats = router.get_routing_stats()
        assert stats["fallback"].fallback_count == 5

    # FM5: Router latency spike — timeout fires, fallback activates
    async def test_fm5_routing_timeout_activates_fallback(self, billing_agent, fallback_agent):
        router = MultiAgentRouter(
            MockLLMProvider(MockProviderConfig(latency_ms=300, jitter_ms=0)),
            RouterConfig(routing_timeout_ms=50, fallback_agent_id="fallback"),
        )
        router.register(billing_agent)
        router.register(fallback_agent)

        response = await router.handle("any request")
        assert response.agent_id == "fallback"
        assert response.routing_decision.fallback is True
        assert "failed" in response.routing_decision.reasoning.lower()

    # FM6: Silent misroute accumulation — routing stats enable detection of distribution shift
    async def test_fm6_routing_stats_detect_distribution_shift(self, billing_agent, support_agent):
        router = MultiAgentRouter(
            MockLLMProvider(MockProviderConfig(
                routing_override=MockRoutingOverride("billing", 0.95, "Overfit")
            )),
        )
        router.register(billing_agent)
        router.register(support_agent)

        for i in range(10):
            await router.handle(f"request {i}")

        stats = router.get_routing_stats()
        assert stats["billing"].count == 10
        assert stats.get("support", None) is None or stats["support"].count == 0


# ─── Integration Tests ────────────────────────────────────────────────────────


class TestIntegration:
    async def test_end_to_end_routing_returns_response(self, billing_agent, support_agent):
        router, _ = make_router(
            provider_config=MockProviderConfig(
                routing_override=MockRoutingOverride("support", 0.88, "Support question"),
                response_sequence=["routing JSON (overridden)", "Here is how to reset your password."],
            ),
            billing_agent=billing_agent,
            support_agent=support_agent,
        )
        response = await router.handle("how do I reset my password?")
        assert response.agent_id == "support"
        assert response.content
        assert response.routing_decision.confidence == 0.88
        assert response.routing_decision.fallback is False

    async def test_audit_log_entry_has_full_details(self, billing_agent, support_agent):
        router, _ = make_router(
            provider_config=MockProviderConfig(
                routing_override=MockRoutingOverride("billing", 0.95, "Billing")
            ),
            billing_agent=billing_agent,
            support_agent=support_agent,
        )
        await router.handle("where is my invoice?")
        log = router.get_audit_log()
        assert len(log) == 1
        assert log[0].request == "where is my invoice?"
        assert log[0].decision.agent_id == "billing"
        assert log[0].agent_response is not None
        assert log[0].total_latency_ms > 0

    async def test_concurrent_routing_handles_multiple_requests(self, billing_agent, support_agent):
        router, _ = make_router(
            provider_config=MockProviderConfig(
                routing_override=MockRoutingOverride("support", 0.85, "Support")
            ),
            billing_agent=billing_agent,
            support_agent=support_agent,
        )
        requests = [f"request {i}" for i in range(10)]
        responses = await asyncio.gather(*[router.handle(r) for r in requests])
        assert len(responses) == 10
        assert all(r.agent_id == "support" for r in responses)
        assert len(router.get_audit_log()) == 10

    async def test_raises_when_fallback_agent_not_registered(self, billing_agent):
        router = MultiAgentRouter(
            MockLLMProvider(MockProviderConfig(
                routing_override=MockRoutingOverride("billing", 0.2, "Low")
            )),
            RouterConfig(fallback_agent_id="unregistered-fallback"),
        )
        router.register(billing_agent)
        with pytest.raises(ValueError, match="not registered"):
            await router.handle("some request")

    async def test_route_returns_decision_without_dispatch(self, billing_agent, support_agent):
        router, _ = make_router(
            provider_config=MockProviderConfig(
                routing_override=MockRoutingOverride("billing", 0.92, "Billing")
            ),
            billing_agent=billing_agent,
            support_agent=support_agent,
        )
        decision = await router.route("how do I get a refund?")
        assert decision.agent_id == "billing"
        assert decision.confidence == 0.92
        assert decision.fallback is False

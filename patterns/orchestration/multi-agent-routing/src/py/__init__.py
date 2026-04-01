"""
Multi-Agent Routing pattern implementation.

Classifies incoming requests and dispatches them to the most appropriate
registered agent, with confidence gating and fallback support.

Usage:
    from multi_agent_routing import MultiAgentRouter, RouterConfig
    from multi_agent_routing.types import AgentCapability

    router = MultiAgentRouter(provider, RouterConfig(fallback_agent_id="fallback"))
    router.register(AgentCapability(id="billing", description="...", examples=[...]))
    router.register(AgentCapability(id="support", description="...", examples=[...]))
    response = await router.handle(user_request)
"""

from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime, timezone
from typing import Optional

from .mock_provider import LLMProvider, MockLLMProvider, MockProviderConfig, MockRoutingOverride
from .types import (
    AgentCapability,
    AgentResponse,
    CompletionOptions,
    RouterConfig,
    RoutingAuditEntry,
    RoutingDecision,
    RoutingStats,
)

__all__ = [
    "MultiAgentRouter",
    "RouterConfig",
    "AgentCapability",
    "AgentResponse",
    "RoutingDecision",
    "RoutingAuditEntry",
    "MockLLMProvider",
    "MockProviderConfig",
    "MockRoutingOverride",
]


class MultiAgentRouter:
    """Routes requests to the appropriate registered agent based on LLM classification."""

    def __init__(self, provider: LLMProvider, config: Optional[RouterConfig] = None) -> None:
        self._provider = provider
        self._config = config or RouterConfig()
        self._agents: dict[str, AgentCapability] = {}
        self._audit_log: list[RoutingAuditEntry] = []

    def register(self, agent: AgentCapability) -> None:
        """Register a specialized agent. Raises ValueError on duplicate ID."""
        if agent.id in self._agents:
            raise ValueError(f'Agent "{agent.id}" is already registered')
        self._agents[agent.id] = agent

    def unregister(self, agent_id: str) -> None:
        """Remove a registered agent."""
        self._agents.pop(agent_id, None)

    async def handle(self, request: str) -> AgentResponse:
        """
        Main entry point: classify the request, dispatch to the chosen agent,
        and return the combined result with audit metadata.
        """
        if not self._agents:
            raise ValueError("No agents registered. Call register() before handle().")

        routing_start = asyncio.get_event_loop().time()

        decision = await self.route(request)
        response = await self.dispatch(decision, request)

        entry = RoutingAuditEntry(
            timestamp=datetime.now(timezone.utc).isoformat(),
            request=request,
            decision=decision,
            agent_response=response,
            total_latency_ms=(asyncio.get_event_loop().time() - routing_start) * 1000.0,
        )
        self._audit_log.append(entry)
        return response

    async def route(self, request: str) -> RoutingDecision:
        """
        Classify a request and return a routing decision.
        Exposed separately to allow callers to inspect decisions before dispatch.
        """
        prompt = self._build_routing_prompt(request)

        try:
            # asyncio.wait_for honours the timeout in milliseconds converted to seconds
            completion = await asyncio.wait_for(
                self._provider.complete(
                    prompt,
                    CompletionOptions(
                        model=self._config.routing_model,
                        max_tokens=self._config.max_routing_tokens,
                        temperature=0.0,
                    ),
                ),
                timeout=self._config.routing_timeout_ms / 1000.0,
            )
            raw = completion.content
        except (asyncio.TimeoutError, Exception) as exc:
            return self._build_fallback_decision(f"Classification failed: {exc}")

        return self._parse_routing_response(raw, request)

    async def dispatch(self, decision: RoutingDecision, request: str) -> AgentResponse:
        """
        Dispatch a routing decision to the selected agent.
        The agent receives the original request — not a transformed version.
        """
        agent = self._agents.get(decision.agent_id)
        if agent is None:
            registered = ", ".join(self._agents.keys())
            raise ValueError(
                f'Routing decision references unknown agent "{decision.agent_id}". '
                f"Registered agents: {registered}"
            )

        agent_start = asyncio.get_event_loop().time()
        agent_prompt = _build_agent_prompt(agent, request)
        completion = await self._provider.complete(agent_prompt, CompletionOptions(model=agent.id))

        return AgentResponse(
            agent_id=agent.id,
            content=completion.content,
            tokens_used=completion.tokens_used,
            latency_ms=(asyncio.get_event_loop().time() - agent_start) * 1000.0,
            routing_decision=decision,
        )

    def get_audit_log(self) -> list[RoutingAuditEntry]:
        """Returns a copy of the routing audit log for inspection."""
        return list(self._audit_log)

    def get_routing_stats(self) -> dict[str, RoutingStats]:
        """Returns routing distribution stats — useful for monitoring."""
        stats: dict[str, RoutingStats] = {}
        for entry in self._audit_log:
            agent_id = entry.decision.agent_id
            if agent_id not in stats:
                stats[agent_id] = RoutingStats()
            stats[agent_id].count += 1
            stats[agent_id].total_confidence += entry.decision.confidence
            if entry.decision.fallback:
                stats[agent_id].fallback_count += 1
        return stats

    @property
    def registered_agents(self) -> list[AgentCapability]:
        return list(self._agents.values())

    # ── Private helpers ──────────────────────────────────────────────────────

    def _build_routing_prompt(self, request: str) -> str:
        # Higher priority agents listed first
        sorted_agents = sorted(self._agents.values(), key=lambda a: -a.priority)
        agent_sections = []
        for agent in sorted_agents:
            examples = "\n".join(f'  - "{e}"' for e in agent.examples)
            agent_sections.append(
                f"Agent ID: {agent.id}\n"
                f"Description: {agent.description}\n"
                f"Example requests:\n{examples}"
            )

        agents_block = "\n\n".join(agent_sections)
        return (
            f"You are a request router. Classify the following request to the most appropriate agent.\n\n"
            f"Available agents:\n{agents_block}\n\n"
            f'Request to classify: "{request}"\n\n'
            f"Respond with JSON only:\n"
            f'{{"agentId": "<agent id>", "confidence": <0-1>, "reasoning": "<one sentence>"}}'
        )

    def _parse_routing_response(self, raw: str, request: str) -> RoutingDecision:
        try:
            # Strip markdown fences if the LLM wrapped the JSON
            cleaned = re.sub(r"^```(?:json)?\s*", "", raw.strip(), flags=re.MULTILINE)
            cleaned = re.sub(r"\s*```$", "", cleaned.strip(), flags=re.MULTILINE).strip()
            parsed = json.loads(cleaned)
        except (json.JSONDecodeError, ValueError):
            return self._build_fallback_decision(
                f'Router returned unparseable response: "{raw[:100]}"'
            )

        agent_id = parsed.get("agentId", "")
        confidence = float(parsed.get("confidence", 0))
        reasoning = parsed.get("reasoning", "")

        if agent_id not in self._agents:
            return self._build_fallback_decision(f'Router returned unknown agent ID "{agent_id}"')

        if confidence < self._config.confidence_threshold:
            if self._config.fallback_agent_id:
                return RoutingDecision(
                    agent_id=self._config.fallback_agent_id,
                    confidence=confidence,
                    reasoning=f"Low confidence ({confidence:.2f} < {self._config.confidence_threshold}): {reasoning}",
                    fallback=True,
                )
            raise ValueError(
                f"Routing confidence {confidence:.2f} is below threshold "
                f"{self._config.confidence_threshold} and no fallback_agent_id is configured. "
                f'Request: "{request[:100]}"'
            )

        return RoutingDecision(agent_id=agent_id, confidence=confidence, reasoning=reasoning, fallback=False)

    def _build_fallback_decision(self, reason: str) -> RoutingDecision:
        if not self._config.fallback_agent_id:
            raise ValueError(f"Routing failed and no fallback_agent_id configured. Reason: {reason}")
        if self._config.fallback_agent_id not in self._agents:
            raise ValueError(
                f'fallback_agent_id "{self._config.fallback_agent_id}" is not registered. '
                "Register it before using it as a fallback."
            )
        return RoutingDecision(
            agent_id=self._config.fallback_agent_id,
            confidence=0.0,
            reasoning=reason,
            fallback=True,
        )


def _build_agent_prompt(agent: AgentCapability, request: str) -> str:
    return f"You are a specialized agent for: {agent.description}\n\nRequest: {request}"

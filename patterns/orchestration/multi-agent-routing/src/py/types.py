"""
Type definitions for the Multi-Agent Routing pattern.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class AgentCapability:
    """A registered agent and its routing metadata."""

    id: str
    """Unique identifier used in routing decisions and audit logs."""

    description: str
    """Natural language description of what this agent handles. Used in the router prompt."""

    examples: list[str]
    """
    Few-shot examples of requests this agent should handle.
    3–5 per agent is the sweet spot; more bloats the router prompt.
    """

    priority: int = 0
    """
    Tiebreaker when two agents have similar confidence scores.
    Higher number = higher priority. Use to prefer lower-cost agents.
    """


@dataclass
class RoutingDecision:
    """The router's classification decision for a single request."""

    agent_id: str
    """ID of the agent selected to handle this request."""

    confidence: float
    """Classification confidence, 0–1. Below threshold triggers fallback."""

    reasoning: str
    """Brief reasoning from the classification call, for audit logs."""

    fallback: bool
    """True if this decision used the fallback path (confidence below threshold)."""


@dataclass
class AgentResponse:
    """Response from a dispatched agent."""

    agent_id: str
    """The agent that handled the request."""

    content: str
    """The agent's output."""

    tokens_used: int
    """Tokens consumed by the agent (for cost tracking)."""

    latency_ms: float
    """Wall-clock execution time in milliseconds."""

    routing_decision: RoutingDecision
    """The routing decision that dispatched this agent."""


@dataclass
class RoutingAuditEntry:
    """Structured audit log entry for each routing decision."""

    timestamp: str
    request: str
    decision: RoutingDecision
    total_latency_ms: float
    agent_response: Optional[AgentResponse] = None


@dataclass
class RouterConfig:
    """Configuration for MultiAgentRouter."""

    confidence_threshold: float = 0.75
    """
    Minimum confidence required to route to a specific agent.
    Below this threshold, requests go to fallback_agent_id (or raise if not set).
    """

    fallback_agent_id: Optional[str] = None
    """
    Agent ID to use when confidence is below threshold.
    If None, low-confidence requests raise ValueError.
    """

    max_routing_tokens: int = 512
    """
    Maximum tokens for the classification call.
    Increase if the capability registry is large; decrease to reduce latency.
    """

    routing_model: Optional[str] = None
    """
    Model name for the classification call. Can be lighter/cheaper than agent models.
    If None, uses the provider default.
    """

    routing_timeout_ms: float = 5_000.0
    """
    Timeout in ms for the classification call.
    On timeout, falls back to fallback_agent_id if set, otherwise raises.
    """


@dataclass
class CompletionOptions:
    model: Optional[str] = None
    max_tokens: Optional[int] = None
    temperature: float = 0.0


@dataclass
class LLMCompletion:
    content: str
    tokens_used: int
    latency_ms: float


@dataclass
class RoutingStats:
    count: int = 0
    total_confidence: float = 0.0
    fallback_count: int = 0

    @property
    def avg_confidence(self) -> float:
        return self.total_confidence / self.count if self.count > 0 else 0.0

"""Type definitions for the Human-in-the-Loop pattern."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, Optional

ReviewTier = Literal["auto", "team", "escalate"]
ReviewOutcome = Literal["approved", "modified", "rejected"]
CheckpointStatus = Literal["pending", "decided", "timed_out", "escalated"]


@dataclass
class AgentAction:
    """An action proposed by an agent that may require human review."""

    id: str
    type: str
    payload: Any
    confidence: float  # [0, 1]
    affected_count: int
    irreversible: bool
    compliance_flags: list[str]
    reasoning_trace: str


@dataclass
class RoutingDecision:
    tier: ReviewTier
    reasons: list[str]


@dataclass
class ReviewDecision:
    review_id: str
    action_id: str
    outcome: ReviewOutcome
    # Only present when outcome == "modified"
    modified_payload: Optional[Any] = None
    rationale: Optional[str] = None
    reviewed_at: datetime = field(default_factory=datetime.now)
    reviewer_id: Optional[str] = None


@dataclass
class CheckpointedAction:
    review_id: str
    action: AgentAction
    tier: ReviewTier
    enqueued_at: datetime
    sla_deadline: datetime
    status: CheckpointStatus = "pending"
    decision: Optional[ReviewDecision] = None


@dataclass
class ActionOutcome:
    action_id: str
    review_id: str
    execution_success: bool
    executed_at: datetime
    error_message: Optional[str] = None


@dataclass
class CalibrationRecord:
    confidence: float
    correct: bool
    action_type: str
    recorded_at: datetime


@dataclass
class HumanInTheLoopConfig:
    """Configuration for the HITL gate.

    Defaults represent a moderate-sensitivity system. Calibrate after 30 days
    using Expected Calibration Error on reviewer outcomes.
    """

    auto_approve_threshold: float = 0.85
    escalate_threshold: float = 0.60
    # SLAs in seconds (Python datetime arithmetic uses timedelta)
    team_review_sla_s: float = 4 * 60 * 60.0   # 4 hours
    escalation_sla_s: float = 1 * 60 * 60.0     # 1 hour
    blast_radius_threshold: int = 100
    mandatory_escalation_categories: list[str] = field(
        default_factory=lambda: ["financial", "medical", "legal"]
    )
    # None = allow all action types; set = only registered types allowed
    registered_action_types: Optional[set[str]] = None

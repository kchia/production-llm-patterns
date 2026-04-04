"""Human-in-the-Loop gate for LLM agent systems.

Classify agent actions by risk (irreversibility, blast radius, confidence,
compliance), route to the appropriate review tier, persist state for durability,
and record outcomes for ECE calibration.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from datetime import datetime, timedelta
from typing import Any, Awaitable, Callable, Optional

from .mock_provider import MockStateStore
from .hitl_types import (
    ActionOutcome,
    AgentAction,
    CalibrationRecord,
    CheckpointedAction,
    HumanInTheLoopConfig,
    ReviewDecision,
    ReviewTier,
    RoutingDecision,
)

# Reviewer callable: async function that takes a checkpoint and returns a decision
ReviewerFn = Callable[[CheckpointedAction], Awaitable[ReviewDecision]]


class TimeoutError(Exception):
    """Raised when a review SLA is exceeded and await_decision is called directly."""

    def __init__(self, review_id: str, tier: ReviewTier) -> None:
        super().__init__(f"Review {review_id} (tier: {tier}) exceeded SLA")
        self.review_id = review_id
        self.tier = tier


class UnregisteredActionTypeError(Exception):
    """Raised when an action type is not in the compliance registry."""

    def __init__(self, action_type: str) -> None:
        super().__init__(
            f'Action type "{action_type}" is not registered in the compliance registry'
        )
        self.action_type = action_type


class HumanInTheLoopGate:
    """Human-in-the-Loop gate.

    Classify actions by risk, route to the appropriate review tier,
    persist state for durability, and record outcomes for calibration.
    """

    def __init__(
        self,
        config: Optional[HumanInTheLoopConfig] = None,
        state_store: Optional[MockStateStore] = None,
        reviewer_fn: Optional[ReviewerFn] = None,
    ) -> None:
        self._config = config or HumanInTheLoopConfig()
        self._store = state_store or MockStateStore()
        self._reviewer_fn = reviewer_fn
        self._calibration_log: list[CalibrationRecord] = []
        self._outcome_log: list[ActionOutcome] = []

    def evaluate(self, action: AgentAction) -> RoutingDecision:
        """Evaluate an action and return a routing decision.

        Raises UnregisteredActionTypeError if registered_action_types is set
        and the action type isn't in the set.
        """
        reasons: list[str] = []

        # Unregistered action types always raise — unknown compliance risk
        if (
            self._config.registered_action_types is not None
            and action.type not in self._config.registered_action_types
        ):
            raise UnregisteredActionTypeError(action.type)

        # Compliance flags override confidence entirely
        has_compliance_flag = any(
            flag in self._config.mandatory_escalation_categories
            for flag in action.compliance_flags
        )
        if has_compliance_flag:
            reasons.append(f"compliance flag: {', '.join(action.compliance_flags)}")
            return RoutingDecision(tier="escalate", reasons=reasons)

        # High blast radius overrides confidence — bulk operations warrant review
        if action.affected_count > self._config.blast_radius_threshold:
            reasons.append(
                f"blast radius {action.affected_count} > threshold "
                f"{self._config.blast_radius_threshold}"
            )
            return RoutingDecision(tier="team", reasons=reasons)

        # Route by confidence score
        if action.confidence < self._config.escalate_threshold:
            reasons.append(
                f"confidence {action.confidence:.2f} < escalate threshold "
                f"{self._config.escalate_threshold}"
            )
            return RoutingDecision(tier="escalate", reasons=reasons)

        if action.confidence < self._config.auto_approve_threshold:
            reasons.append(
                f"confidence {action.confidence:.2f} < auto-approve threshold "
                f"{self._config.auto_approve_threshold}"
            )
            # Irreversible actions in the middle band go to escalation for safety
            if action.irreversible:
                reasons.append("irreversible action in confidence band → escalating")
                return RoutingDecision(tier="escalate", reasons=reasons)
            return RoutingDecision(tier="team", reasons=reasons)

        reasons.append(
            f"confidence {action.confidence:.2f} >= auto-approve threshold"
        )
        return RoutingDecision(tier="auto", reasons=reasons)

    def enqueue(self, action: AgentAction, tier: ReviewTier) -> str:
        """Checkpoint the action and enqueue it for review.

        Checkpointing happens before returning — state survives process restart.
        Returns the review_id.
        """
        review_id = str(uuid.uuid4())
        now = datetime.now()
        sla_s = (
            self._config.escalation_sla_s
            if tier == "escalate"
            else self._config.team_review_sla_s
        )

        checkpoint = CheckpointedAction(
            review_id=review_id,
            action=action,
            tier=tier,
            enqueued_at=now,
            sla_deadline=now + timedelta(seconds=sla_s),
        )
        self._store.save(checkpoint)
        return review_id

    async def await_decision(
        self,
        review_id: str,
        reviewer_fn: Optional[ReviewerFn] = None,
    ) -> ReviewDecision:
        """Wait for a reviewer decision, raising TimeoutError if SLA expires."""
        checkpoint = self._store.load(review_id)
        if checkpoint is None:
            raise KeyError(f"Review {review_id} not found")

        fn = reviewer_fn or self._reviewer_fn
        if fn is None:
            raise ValueError("No reviewer function provided")

        timeout_s = (checkpoint.sla_deadline - datetime.now()).total_seconds()
        if timeout_s <= 0:
            self._store.update(review_id, status="timed_out")
            raise TimeoutError(review_id, checkpoint.tier)

        try:
            # asyncio.wait_for cancels the coroutine on timeout — clean race semantics
            decision = await asyncio.wait_for(fn(checkpoint), timeout=timeout_s)
        except asyncio.TimeoutError:
            self._store.update(review_id, status="timed_out")
            raise TimeoutError(review_id, checkpoint.tier)

        self._store.update(review_id, decision=decision, status="decided")
        return decision

    async def process(
        self,
        action: AgentAction,
        reviewer_fn: Optional[ReviewerFn] = None,
    ) -> Optional[dict[str, Any]]:
        """Full gate flow: evaluate → enqueue (if needed) → await decision.

        Returns a dict with 'payload', 'review_id', and 'tier' on success,
        or None if the action was rejected (by reviewer or timeout).
        """
        routing = self.evaluate(action)

        if routing.tier == "auto":
            return {"payload": action.payload, "review_id": None, "tier": "auto"}

        review_id = self.enqueue(action, routing.tier)
        decision: ReviewDecision

        try:
            decision = await self.await_decision(review_id, reviewer_fn)
        except TimeoutError:
            if action.irreversible:
                return None  # default-reject irreversible actions on timeout
            if routing.tier == "team":
                # Escalate reversible team-queue actions after SLA breach
                escalation_id = self.enqueue(action, "escalate")
                try:
                    decision = await self.await_decision(escalation_id, reviewer_fn)
                except TimeoutError:
                    return None  # escalation also timed out → reject
            else:
                return None  # escalation tier timed out → reject

        if decision.outcome == "rejected":
            return None

        resolved_payload = (
            decision.modified_payload
            if decision.outcome == "modified" and decision.modified_payload is not None
            else action.payload
        )

        return {"payload": resolved_payload, "review_id": review_id, "tier": routing.tier}

    def record_outcome(self, review_id: str, outcome: ActionOutcome) -> None:
        """Record execution outcome for ECE calibration."""
        self._outcome_log.append(outcome)

        checkpoint = self._store.load(review_id)
        if checkpoint is None:
            return

        self._calibration_log.append(
            CalibrationRecord(
                confidence=checkpoint.action.confidence,
                correct=outcome.execution_success,
                action_type=checkpoint.action.type,
                recorded_at=datetime.now(),
            )
        )

    def compute_ece(self, bins: int = 10) -> float:
        """Compute Expected Calibration Error over recorded calibration pairs.

        ECE = weighted avg |confidence - accuracy| across equal-width bins.
        A score of 0.10 means items labeled "90% confident" are accurate only 80% of the time.
        """
        if not self._calibration_log:
            return 0.0

        bin_size = 1.0 / bins
        weighted_error = 0.0
        total_count = 0

        for b in range(bins):
            lo = b * bin_size
            hi = lo + bin_size
            in_bin = [r for r in self._calibration_log if lo <= r.confidence < hi]
            if not in_bin:
                continue

            avg_confidence = sum(r.confidence for r in in_bin) / len(in_bin)
            accuracy = sum(1 for r in in_bin if r.correct) / len(in_bin)
            weighted_error += len(in_bin) * abs(avg_confidence - accuracy)
            total_count += len(in_bin)

        return weighted_error / total_count if total_count > 0 else 0.0

    def get_calibration_log(self) -> list[CalibrationRecord]:
        return list(self._calibration_log)

    def get_outcome_log(self) -> list[ActionOutcome]:
        return list(self._outcome_log)

    def get_queue_snapshot(self) -> list[CheckpointedAction]:
        return self._store.all()

    def get_queue_depth_by_tier(self) -> dict[ReviewTier, int]:
        pending = [c for c in self._store.all() if c.status == "pending"]
        return {
            "auto": 0,
            "team": sum(1 for c in pending if c.tier == "team"),
            "escalate": sum(1 for c in pending if c.tier == "escalate"),
        }

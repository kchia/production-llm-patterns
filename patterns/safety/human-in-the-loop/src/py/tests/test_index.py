"""Tests for the Human-in-the-Loop gate — Python implementation.

Three test categories:
  1. Unit: risk classifier routing logic
  2. Failure mode: queue flooding, SLA breach, calibration drift, compliance registry
  3. Integration: full approve/modify/reject flows with mock reviewer
"""

from __future__ import annotations

import asyncio
from datetime import datetime

import pytest

from .. import (
    HumanInTheLoopGate,
    TimeoutError,
    UnregisteredActionTypeError,
)
from ..mock_provider import MockReviewer, MockStateStore
from ..hitl_types import (
    ActionOutcome,
    AgentAction,
    HumanInTheLoopConfig,
    ReviewDecision,
)


# ---- Fixtures ----------------------------------------------------------------


def make_action(**kwargs) -> AgentAction:
    defaults = dict(
        id="test-action-1",
        type="send_notification",
        payload={"message": "hello"},
        confidence=0.9,
        affected_count=1,
        irreversible=False,
        compliance_flags=[],
        reasoning_trace="test trace",
    )
    defaults.update(kwargs)
    return AgentAction(**defaults)


# ---- Unit: Risk Classifier ---------------------------------------------------


class TestEvaluateRouting:
    def test_high_confidence_routes_auto(self):
        gate = HumanInTheLoopGate()
        result = gate.evaluate(make_action(confidence=0.92))
        assert result.tier == "auto"

    def test_mid_confidence_reversible_routes_team(self):
        gate = HumanInTheLoopGate()
        result = gate.evaluate(make_action(confidence=0.72, irreversible=False))
        assert result.tier == "team"

    def test_mid_confidence_irreversible_routes_escalate(self):
        gate = HumanInTheLoopGate()
        result = gate.evaluate(make_action(confidence=0.72, irreversible=True))
        assert result.tier == "escalate"

    def test_low_confidence_routes_escalate(self):
        gate = HumanInTheLoopGate()
        result = gate.evaluate(make_action(confidence=0.45))
        assert result.tier == "escalate"

    def test_compliance_flag_escalates_regardless_of_confidence(self):
        gate = HumanInTheLoopGate()
        result = gate.evaluate(
            make_action(confidence=0.95, compliance_flags=["financial"])
        )
        assert result.tier == "escalate"
        assert any("compliance flag" in r for r in result.reasons)

    def test_high_blast_radius_routes_team(self):
        gate = HumanInTheLoopGate()
        result = gate.evaluate(make_action(confidence=0.9, affected_count=500))
        assert result.tier == "team"
        assert any("blast radius" in r for r in result.reasons)

    def test_custom_threshold_respected(self):
        config = HumanInTheLoopConfig(auto_approve_threshold=0.95)
        gate = HumanInTheLoopGate(config=config)
        # 0.92 is below strict threshold → team review
        assert gate.evaluate(make_action(confidence=0.92)).tier == "team"

    def test_reasons_populated(self):
        gate = HumanInTheLoopGate()
        result = gate.evaluate(make_action(confidence=0.9))
        assert len(result.reasons) > 0


# ---- Unit: Unregistered Action Type -----------------------------------------


class TestRegisteredActionTypes:
    def test_raises_for_unknown_type(self):
        config = HumanInTheLoopConfig(
            registered_action_types={"send_notification"}
        )
        gate = HumanInTheLoopGate(config=config)
        with pytest.raises(UnregisteredActionTypeError):
            gate.evaluate(make_action(type="delete_record"))

    def test_allows_all_when_none(self):
        config = HumanInTheLoopConfig(registered_action_types=None)
        gate = HumanInTheLoopGate(config=config)
        gate.evaluate(make_action(type="any_action"))  # should not raise


# ---- Unit: Enqueue & State Store --------------------------------------------


class TestEnqueue:
    def test_persists_checkpoint_and_returns_review_id(self):
        store = MockStateStore()
        gate = HumanInTheLoopGate(state_store=store)
        action = make_action(confidence=0.72)
        review_id = gate.enqueue(action, "team")

        checkpoint = store.load(review_id)
        assert checkpoint is not None
        assert checkpoint.action.id == action.id
        assert checkpoint.tier == "team"
        assert checkpoint.status == "pending"

    def test_sla_deadline_matches_tier(self):
        sla_s = 4 * 60 * 60.0
        config = HumanInTheLoopConfig(team_review_sla_s=sla_s)
        store = MockStateStore()
        gate = HumanInTheLoopGate(config=config, state_store=store)
        review_id = gate.enqueue(make_action(confidence=0.72), "team")

        checkpoint = store.load(review_id)
        delta = (checkpoint.sla_deadline - checkpoint.enqueued_at).total_seconds()
        assert abs(delta - sla_s) < 1.0  # within 1s tolerance


# ---- Integration: Full Flow -------------------------------------------------


class TestProcessHappyPath:
    async def test_auto_approves_without_reviewer(self):
        reviewer = MockReviewer(default_approval_rate=1.0)
        gate = HumanInTheLoopGate()
        action = make_action(confidence=0.95)

        result = await gate.process(action, reviewer.decide)
        assert result is not None
        assert result["tier"] == "auto"
        assert reviewer.call_count == 0

    async def test_team_review_returns_approved_payload(self):
        reviewer = MockReviewer(default_approval_rate=1.0)
        gate = HumanInTheLoopGate()
        action = make_action(confidence=0.72)

        result = await gate.process(action, reviewer.decide)
        assert result is not None
        assert result["tier"] == "team"
        assert reviewer.call_count == 1

    async def test_returns_none_when_rejected(self):
        reviewer = MockReviewer(
            action_type_outcomes={"send_notification": "rejected"}
        )
        gate = HumanInTheLoopGate()

        result = await gate.process(make_action(confidence=0.72), reviewer.decide)
        assert result is None

    async def test_returns_modified_payload_on_modify(self):
        modified_payload = {"message": "reviewed"}
        action = make_action(confidence=0.72)

        async def mock_reviewer(checkpoint):
            return ReviewDecision(
                review_id=checkpoint.review_id,
                action_id=action.id,
                outcome="modified",
                modified_payload=modified_payload,
            )

        gate = HumanInTheLoopGate()
        result = await gate.process(action, mock_reviewer)
        assert result is not None
        assert result["payload"] == modified_payload


# ---- Failure Mode: SLA Breach -----------------------------------------------


class TestSLABreach:
    async def test_irreversible_action_default_rejects_on_timeout(self):
        config = HumanInTheLoopConfig(
            team_review_sla_s=0.001, escalation_sla_s=0.001
        )
        gate = HumanInTheLoopGate(config=config)
        action = make_action(confidence=0.72, irreversible=True)

        reviewer = MockReviewer(decision_latency_s=0.1)
        result = await gate.process(action, reviewer.decide)
        assert result is None  # irreversible → default-reject, not throw

    async def test_await_decision_raises_timeout_error_directly(self):
        config = HumanInTheLoopConfig(escalation_sla_s=0.001)
        gate = HumanInTheLoopGate(config=config)
        action = make_action(confidence=0.45)
        review_id = gate.enqueue(action, "escalate")

        await asyncio.sleep(0.01)  # let SLA expire
        reviewer = MockReviewer(decision_latency_s=0.1)
        with pytest.raises(TimeoutError):
            await gate.await_decision(review_id, reviewer.decide)

    async def test_reversible_team_action_escalates_after_sla_breach(self):
        config = HumanInTheLoopConfig(
            team_review_sla_s=0.001,
            escalation_sla_s=2.0,
        )
        gate = HumanInTheLoopGate(config=config)
        action = make_action(confidence=0.72, irreversible=False)

        # Fast enough for escalation SLA, misses team SLA
        reviewer = MockReviewer(decision_latency_s=0.05, default_approval_rate=1.0)
        result = await gate.process(action, reviewer.decide)
        assert result is not None  # escalated and approved


# ---- Failure Mode: Queue Flooding -------------------------------------------


class TestQueueDepthTracking:
    def test_tracks_pending_items_by_tier(self):
        gate = HumanInTheLoopGate()
        gate.enqueue(make_action(id="1", confidence=0.72), "team")
        gate.enqueue(make_action(id="2", confidence=0.45), "escalate")
        gate.enqueue(make_action(id="3", confidence=0.72), "team")

        depth = gate.get_queue_depth_by_tier()
        assert depth["team"] == 2
        assert depth["escalate"] == 1


# ---- Failure Mode: Compliance Registry Missing ------------------------------


class TestUnregisteredActionType:
    def test_blocks_unregistered_type(self):
        config = HumanInTheLoopConfig(
            registered_action_types={"send_notification"}
        )
        gate = HumanInTheLoopGate(config=config)
        with pytest.raises(UnregisteredActionTypeError):
            gate.evaluate(make_action(type="cancel_subscription"))


# ---- Failure Mode: Silent Threshold Drift (ECE) -----------------------------


class TestECECalibration:
    def test_ece_zero_on_empty_log(self):
        gate = HumanInTheLoopGate()
        assert gate.compute_ece() == 0.0

    async def test_ece_detects_drift_via_full_round_trip(self):
        config = HumanInTheLoopConfig(team_review_sla_s=5.0)
        gate = HumanInTheLoopGate(config=config)
        reviewer = MockReviewer(default_approval_rate=1.0, decision_latency_s=0.01)

        for i in range(6):
            action = make_action(id=f"a{i}", confidence=0.72, irreversible=False)
            result = await gate.process(action, reviewer.decide)
            if result and result["review_id"]:
                gate.record_outcome(
                    result["review_id"],
                    ActionOutcome(
                        action_id=action.id,
                        review_id=result["review_id"],
                        execution_success=(i % 2 == 0),  # 50% accuracy
                        executed_at=datetime.now(),
                    ),
                )

        ece = gate.compute_ece()
        # confidence=0.72, ~50% accuracy → |0.72 - 0.5| = 0.22 ECE
        assert ece > 0.1


# ---- Unit: record_outcome & calibration log ---------------------------------


class TestRecordOutcome:
    async def test_stores_outcome_and_calibration(self):
        config = HumanInTheLoopConfig(team_review_sla_s=5.0)
        gate = HumanInTheLoopGate(config=config)
        reviewer = MockReviewer(default_approval_rate=1.0, decision_latency_s=0.01)
        action = make_action(confidence=0.72)

        result = await gate.process(action, reviewer.decide)
        assert result is not None

        gate.record_outcome(
            result["review_id"],
            ActionOutcome(
                action_id=action.id,
                review_id=result["review_id"],
                execution_success=True,
                executed_at=datetime.now(),
            ),
        )

        assert len(gate.get_outcome_log()) == 1
        assert len(gate.get_calibration_log()) == 1
        record = gate.get_calibration_log()[0]
        assert record.confidence == 0.72
        assert record.correct is True

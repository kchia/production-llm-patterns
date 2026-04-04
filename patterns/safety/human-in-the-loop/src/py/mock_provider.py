"""Mock reviewer and state store for testing and benchmarks."""

from __future__ import annotations

import asyncio
import copy
import time
from typing import Optional

from .hitl_types import (
    CheckpointedAction,
    CheckpointStatus,
    ReviewDecision,
    ReviewOutcome,
)


class MockStateStore:
    """In-memory checkpoint store simulating a durable backend (PostgreSQL, Redis).

    Production systems would persist here before the process pauses for review.
    """

    def __init__(self) -> None:
        self._store: dict[str, CheckpointedAction] = {}

    def save(self, checkpoint: CheckpointedAction) -> None:
        self._store[checkpoint.review_id] = copy.deepcopy(checkpoint)

    def load(self, review_id: str) -> Optional[CheckpointedAction]:
        item = self._store.get(review_id)
        return copy.deepcopy(item) if item is not None else None

    def update(self, review_id: str, **kwargs: object) -> None:
        existing = self._store.get(review_id)
        if existing is None:
            raise KeyError(f"Review {review_id} not found in state store")
        for key, value in kwargs.items():
            setattr(existing, key, value)

    def all(self) -> list[CheckpointedAction]:
        return [copy.deepcopy(c) for c in self._store.values()]

    def size(self) -> int:
        return len(self._store)


class MockReviewer:
    """Simulates a human reviewer for tests and benchmarks.

    Supports configurable latency, forced outcomes per action type,
    and SLA breach simulation.
    """

    def __init__(
        self,
        decision_latency_s: float = 0.01,
        action_type_outcomes: Optional[dict[str, ReviewOutcome]] = None,
        default_approval_rate: float = 0.9,
        simulate_sla_breach: bool = False,
        reviewer_id: str = "mock-reviewer-1",
    ) -> None:
        self.decision_latency_s = decision_latency_s
        self.action_type_outcomes = action_type_outcomes or {}
        self.default_approval_rate = default_approval_rate
        self.simulate_sla_breach = simulate_sla_breach
        self.reviewer_id = reviewer_id
        self._call_count = 0

    async def decide(self, checkpoint: CheckpointedAction) -> ReviewDecision:
        self._call_count += 1

        if self.simulate_sla_breach:
            # Sleep past the deadline to trigger SLA timeout in the gate
            deadline = checkpoint.sla_deadline.timestamp()
            sleep_s = max(0, deadline - time.time()) + 1.0
            await asyncio.sleep(sleep_s)
        else:
            await asyncio.sleep(self.decision_latency_s)

        outcome = self._resolve_outcome(checkpoint.action.type)
        return ReviewDecision(
            review_id=checkpoint.review_id,
            action_id=checkpoint.action.id,
            outcome=outcome,
            rationale=f"Mock reviewer: {outcome}",
            reviewer_id=self.reviewer_id,
        )

    def _resolve_outcome(self, action_type: str) -> ReviewOutcome:
        if action_type in self.action_type_outcomes:
            return self.action_type_outcomes[action_type]
        import random
        return "approved" if random.random() < self.default_approval_rate else "rejected"

    @property
    def call_count(self) -> int:
        return self._call_count

    def reset(self) -> None:
        self._call_count = 0

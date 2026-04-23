"""
cost-tracker — Unit Tests (Python)

Covers: price lookup, cost computation, token estimation,
        CostTracker.record/estimate, SpendAccumulator add/snapshot/global.
"""

import math
import pytest
from .. import (
    BUILT_IN_PRICES,
    CostTracker,
    SpendAccumulator,
    compute_cost,
    estimate_tokens,
)
from ..types import ModelPrice


# ─── compute_cost ─────────────────────────────────────────────────────────────

class TestComputeCost:
    def _gpt4o(self) -> ModelPrice:
        return next(p for p in BUILT_IN_PRICES if p.model == "gpt-4o")

    def test_zero_tokens(self):
        assert compute_cost(0, 0, self._gpt4o()) == 0.0

    def test_input_cost_only(self):
        # 1M input tokens at $2.50/1M = $2.50
        result = compute_cost(1_000_000, 0, self._gpt4o())
        assert abs(result - 2.50) < 1e-6

    def test_output_cost_only(self):
        # 1M output tokens at $10/1M = $10.00
        result = compute_cost(0, 1_000_000, self._gpt4o())
        assert abs(result - 10.00) < 1e-6

    def test_combined_cost(self):
        # 500K input at $2.50/1M = $1.25; 100K output at $10/1M = $1.00; total = $2.25
        result = compute_cost(500_000, 100_000, self._gpt4o())
        assert abs(result - 2.25) < 1e-6

    def test_small_token_counts(self):
        price = ModelPrice("test", input_price_per_million=2.50, output_price_per_million=10.00)
        result = compute_cost(1_000, 0, price)
        assert abs(result - 0.0025) < 1e-7


# ─── estimate_tokens ──────────────────────────────────────────────────────────

class TestEstimateTokens:
    def test_empty_string(self):
        assert estimate_tokens("") == 0

    def test_ceiling_behavior(self):
        # "Hello" = 5 chars → ceil(5/4) = 2
        assert estimate_tokens("Hello") == 2

    def test_exact_multiple(self):
        assert estimate_tokens("test") == 1   # 4 chars → 1
        assert estimate_tokens("12345678") == 2  # 8 chars → 2

    def test_over_estimates_for_safety(self):
        text = "Hello"
        estimated = estimate_tokens(text)
        assert estimated >= len(text) / 4


# ─── CostTracker ──────────────────────────────────────────────────────────────

class TestCostTracker:
    def setup_method(self):
        self.tracker = CostTracker()

    def test_get_price_known_model(self):
        price = self.tracker.get_price("gpt-4o")
        assert price.input_price_per_million == 2.50
        assert price.output_price_per_million == 10.00

    def test_get_price_unknown_model_does_not_raise(self):
        price = self.tracker.get_price("future-model-xyz")
        assert price.input_price_per_million > 0
        assert price.model == "future-model-xyz"

    def test_record_token_totals(self):
        record = self.tracker.record(
            model="gpt-4o-mini",
            input_tokens=1000,
            output_tokens=200,
        )
        assert record.usage.input_tokens == 1000
        assert record.usage.output_tokens == 200
        assert record.usage.total_tokens == 1200

    def test_record_cost_gpt4o_mini(self):
        # 1000 input at $0.15/1M = $0.00015; 200 output at $0.60/1M = $0.00012
        record = self.tracker.record(
            model="gpt-4o-mini",
            input_tokens=1000,
            output_tokens=200,
        )
        assert abs(record.cost_usd - 0.00027) < 1e-7

    def test_record_label(self):
        record = self.tracker.record(
            model="gpt-4o",
            input_tokens=100,
            output_tokens=50,
            label="feature-x",
        )
        assert record.label == "feature-x"

    def test_record_custom_timestamp(self):
        ts = 1700000000.0
        record = self.tracker.record(
            model="gpt-4o",
            input_tokens=100,
            output_tokens=50,
            timestamp=ts,
        )
        assert record.timestamp == ts

    def test_record_default_timestamp(self):
        import time
        before = time.time()
        record = self.tracker.record(model="gpt-4o", input_tokens=10, output_tokens=10)
        after = time.time()
        assert before <= record.timestamp <= after

    def test_estimate_returns_positive_values(self):
        result = self.tracker.estimate(
            model="gpt-4o",
            prompt_text="This is a test prompt.",
        )
        assert result["estimated_input_tokens"] > 0
        assert result["estimated_output_tokens"] > 0
        assert result["estimated_cost_usd"] > 0

    def test_estimate_custom_output_tokens(self):
        result = self.tracker.estimate(
            model="gpt-4o",
            prompt_text="Short.",
            expected_output_tokens=1000,
        )
        assert result["estimated_output_tokens"] == 1000

    def test_custom_price_table(self):
        tracker = CostTracker(
            prices=[ModelPrice("my-model", input_price_per_million=1.0, output_price_per_million=2.0)]
        )
        record = tracker.record(model="my-model", input_tokens=1_000_000, output_tokens=0)
        assert abs(record.cost_usd - 1.0) < 1e-6


# ─── SpendAccumulator ─────────────────────────────────────────────────────────

class TestSpendAccumulator:
    def setup_method(self):
        self.tracker = CostTracker()
        self.accumulator = SpendAccumulator()

    def test_zero_snapshot_for_unknown_label(self):
        snap = self.accumulator.snapshot("nobody")
        assert snap.total_cost_usd == 0.0
        assert snap.total_requests == 0

    def test_accumulates_costs_for_label(self):
        r1 = self.tracker.record(model="gpt-4o-mini", input_tokens=500, output_tokens=100, label="user-a")
        r2 = self.tracker.record(model="gpt-4o-mini", input_tokens=500, output_tokens=100, label="user-a")
        self.accumulator.add(r1)
        self.accumulator.add(r2)

        snap = self.accumulator.snapshot("user-a")
        assert snap.total_requests == 2
        assert snap.total_input_tokens == 1000
        assert snap.total_output_tokens == 200
        assert abs(snap.total_cost_usd - r1.cost_usd * 2) < 1e-9

    def test_separate_totals_per_label(self):
        self.accumulator.add(
            self.tracker.record(model="gpt-4o", input_tokens=1000, output_tokens=100, label="a")
        )
        self.accumulator.add(
            self.tracker.record(model="gpt-4o-mini", input_tokens=1000, output_tokens=100, label="b")
        )

        snap_a = self.accumulator.snapshot("a")
        snap_b = self.accumulator.snapshot("b")
        assert snap_a.total_cost_usd > snap_b.total_cost_usd
        assert snap_a.total_requests == 1
        assert snap_b.total_requests == 1

    def test_unlabeled_records_bucket(self):
        self.accumulator.add(
            self.tracker.record(model="gpt-4o", input_tokens=100, output_tokens=50)
        )
        snap = self.accumulator.snapshot("unlabeled")
        assert snap.total_requests == 1

    def test_global_total(self):
        self.accumulator.add(
            self.tracker.record(model="gpt-4o", input_tokens=1000, output_tokens=100, label="x")
        )
        self.accumulator.add(
            self.tracker.record(model="gpt-4o", input_tokens=1000, output_tokens=100, label="y")
        )

        total = self.accumulator.global_total()
        assert total.total_requests == 2
        assert total.total_input_tokens == 2000

    def test_reset_clears_state(self):
        self.accumulator.add(
            self.tracker.record(model="gpt-4o", input_tokens=100, output_tokens=50, label="a")
        )
        self.accumulator.reset()

        assert self.accumulator.all_snapshots() == []
        assert self.accumulator.global_total().total_cost_usd == 0.0

    def test_all_snapshots_one_per_label(self):
        for _ in range(2):
            self.accumulator.add(
                self.tracker.record(model="gpt-4o", input_tokens=100, output_tokens=50, label="a")
            )
        self.accumulator.add(
            self.tracker.record(model="gpt-4o", input_tokens=100, output_tokens=50, label="b")
        )

        snapshots = self.accumulator.all_snapshots()
        assert len(snapshots) == 2
        labels = sorted(s.label for s in snapshots)
        assert labels == ["a", "b"]

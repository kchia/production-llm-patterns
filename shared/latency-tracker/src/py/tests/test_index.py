"""
latency-tracker — Python Unit Tests

Covers: Stopwatch timing, compute_stats percentiles, LatencyAccumulator
        accumulation/grouping/reset, SlidingWindowRecorder window eviction.
"""

import time
import pytest

from .. import (
    Stopwatch,
    compute_stats,
    LatencyAccumulator,
    SlidingWindowRecorder,
)


# ─── Stopwatch ────────────────────────────────────────────────────────────────


class TestStopwatch:
    def test_elapsed_increases_over_time(self):
        sw = Stopwatch()
        time.sleep(0.02)
        assert sw.elapsed() > 10  # > 10ms

    def test_stop_returns_elapsed_and_freezes(self):
        sw = Stopwatch()
        time.sleep(0.02)
        stopped = sw.stop()
        assert stopped > 10
        # elapsed() after stop() returns same frozen value
        assert sw.elapsed() == stopped

    def test_stop_called_twice_returns_same_value(self):
        sw = Stopwatch()
        first = sw.stop()
        time.sleep(0.01)
        second = sw.stop()
        assert second == first

    def test_classmethod_start_is_equivalent(self):
        sw = Stopwatch.start()
        time.sleep(0.015)
        assert sw.elapsed() > 10


# ─── compute_stats ────────────────────────────────────────────────────────────


class TestComputeStats:
    def test_returns_zeros_for_empty_list(self):
        stats = compute_stats([])
        assert stats.count == 0
        assert stats.min_ms == 0.0
        assert stats.max_ms == 0.0
        assert stats.mean_ms == 0.0
        assert stats.p50_ms == 0.0
        assert stats.p99_ms == 0.0

    def test_single_element(self):
        stats = compute_stats([42.0])
        assert stats.count == 1
        assert stats.min_ms == 42.0
        assert stats.max_ms == 42.0
        assert stats.mean_ms == 42.0
        assert stats.p50_ms == 42.0
        assert stats.p99_ms == 42.0

    def test_min_max_mean(self):
        stats = compute_stats([10.0, 20.0, 30.0, 40.0, 50.0])
        assert stats.min_ms == 10.0
        assert stats.max_ms == 50.0
        assert stats.mean_ms == pytest.approx(30.0)
        assert stats.count == 5

    def test_does_not_mutate_input(self):
        samples = [30.0, 10.0, 20.0]
        compute_stats(samples)
        assert samples == [30.0, 10.0, 20.0]

    def test_p50_is_median_for_odd_length(self):
        # [10, 20, 30] sorted — median = 20
        stats = compute_stats([30.0, 10.0, 20.0])
        assert stats.p50_ms == pytest.approx(20.0)

    def test_p50_interpolates_for_even_length(self):
        # [10, 20, 30, 40] — p50 idx = 1.5, interpolates 20 and 30 → 25
        stats = compute_stats([10.0, 20.0, 30.0, 40.0])
        assert stats.p50_ms == pytest.approx(25.0)

    def test_percentile_ordering(self):
        # p99 >= p95 >= p50 >= min for any input
        samples = [5.0, 2.0, 8.0, 1.0, 9.0, 3.0, 7.0, 4.0, 6.0, 10.0]
        stats = compute_stats(samples)
        assert stats.p99_ms >= stats.p95_ms
        assert stats.p95_ms >= stats.p50_ms
        assert stats.p50_ms >= stats.min_ms

    def test_uniform_distribution_percentiles(self):
        # 100 uniform samples [1..100]
        samples = [float(i) for i in range(1, 101)]
        stats = compute_stats(samples)
        assert stats.p95_ms == pytest.approx(95.05, abs=0.1)
        assert stats.p99_ms == pytest.approx(99.01, abs=0.1)

    def test_duplicate_values(self):
        stats = compute_stats([100.0, 100.0, 100.0, 100.0])
        assert stats.min_ms == 100.0
        assert stats.max_ms == 100.0
        assert stats.mean_ms == 100.0
        assert stats.p99_ms == 100.0


# ─── LatencyAccumulator ───────────────────────────────────────────────────────


class TestLatencyAccumulator:
    def setup_method(self):
        self.acc = LatencyAccumulator()

    def test_returns_zero_stats_for_unknown_label(self):
        stats = self.acc.stats("nobody")
        assert stats.count == 0
        assert stats.mean_ms == 0.0

    def test_record_returns_latency_record(self):
        record = self.acc.record(123.0, "provider-a")
        assert record.latency_ms == 123.0
        assert record.label == "provider-a"
        assert isinstance(record.timestamp, float)

    def test_accumulates_under_same_label(self):
        self.acc.record(100.0, "svc")
        self.acc.record(200.0, "svc")
        self.acc.record(300.0, "svc")

        stats = self.acc.stats("svc")
        assert stats.count == 3
        assert stats.mean_ms == pytest.approx(200.0)
        assert stats.min_ms == 100.0
        assert stats.max_ms == 300.0

    def test_keeps_separate_samples_per_label(self):
        self.acc.record(10.0, "fast")
        self.acc.record(1000.0, "slow")

        assert self.acc.stats("fast").mean_ms == 10.0
        assert self.acc.stats("slow").mean_ms == 1000.0

    def test_unlabeled_goes_to_unlabeled_bucket(self):
        self.acc.record(50.0)
        stats = self.acc.stats("unlabeled")
        assert stats.count == 1
        assert stats.mean_ms == 50.0

    def test_all_stats_returns_one_entry_per_label(self):
        self.acc.record(100.0, "a")
        self.acc.record(200.0, "a")
        self.acc.record(300.0, "b")

        all_stats = self.acc.all_stats()
        assert len(all_stats) == 2
        labels = sorted(s.label for s in all_stats)
        assert labels == ["a", "b"]

    def test_total_count_sums_across_labels(self):
        self.acc.record(100.0, "a")
        self.acc.record(200.0, "a")
        self.acc.record(300.0, "b")

        assert self.acc.total_count() == 3

    def test_reset_clears_all_state(self):
        self.acc.record(100.0, "a")
        self.acc.record(200.0, "b")
        self.acc.reset()

        assert self.acc.all_stats() == []
        assert self.acc.total_count() == 0
        assert self.acc.stats("a").count == 0


# ─── SlidingWindowRecorder ───────────────────────────────────────────────────


class TestSlidingWindowRecorder:
    def test_starts_with_count_zero(self):
        w = SlidingWindowRecorder(10)
        assert w.count == 0
        assert w.stats().count == 0

    def test_records_up_to_max_size(self):
        w = SlidingWindowRecorder(5)
        for i in range(1, 6):
            w.record(float(i * 10))
        assert w.count == 5

    def test_evicts_oldest_when_full(self):
        w = SlidingWindowRecorder(3)
        w.record(1.0)
        w.record(2.0)
        w.record(3.0)
        w.record(100.0)  # evicts 1.0

        stats = w.stats()
        assert stats.count == 3
        assert stats.min_ms == 2.0  # 1.0 was evicted
        assert stats.max_ms == 100.0

    def test_stats_reflects_current_window_only(self):
        w = SlidingWindowRecorder(2)
        w.record(10.0)
        w.record(20.0)
        w.record(30.0)  # evicts 10.0

        stats = w.stats()
        assert stats.min_ms == 20.0
        assert stats.mean_ms == pytest.approx(25.0)

    def test_reset_clears_window(self):
        w = SlidingWindowRecorder(5)
        w.record(100.0)
        w.record(200.0)
        w.reset()

        assert w.count == 0
        assert w.stats().count == 0

    def test_raises_for_max_size_less_than_one(self):
        with pytest.raises(ValueError):
            SlidingWindowRecorder(0)

    def test_window_of_size_one_holds_only_latest(self):
        w = SlidingWindowRecorder(1)
        w.record(50.0)
        w.record(999.0)

        stats = w.stats()
        assert stats.count == 1
        assert stats.p99_ms == 999.0

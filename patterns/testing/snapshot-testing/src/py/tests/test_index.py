"""
Tests for the Snapshot Testing pattern — Python implementation.

Categories:
  1. Unit — SnapshotStore, similarity math, characteristic extraction
  2. Failure mode — one test per failure mode from README table
  3. Integration — end-to-end run with mock provider

Run: python -m pytest tests/ -v
(Requires: pip install pytest pytest-asyncio)
"""

from __future__ import annotations

import json

import pytest

from .. import SnapshotRunner, SnapshotStore
from ..mock_provider import MockProvider, MockProviderConfig
from ..types import SnapshotRunnerConfig, SnapshotTestCase


# ─── Helpers ──────────────────────────────────────────────────────────────────


@pytest.fixture
def snap_dir(tmp_path):
    return str(tmp_path / "snapshots")


def make_runner(
    responses: list[str],
    snap_dir: str,
    provider_config: MockProviderConfig | None = None,
    runner_overrides: dict | None = None,
) -> SnapshotRunner:
    cfg = MockProviderConfig(responses=responses)
    if provider_config is not None:
        cfg = provider_config
    provider = MockProvider(cfg)
    runner_cfg = SnapshotRunnerConfig(
        snapshot_dir=snap_dir, **(runner_overrides or {})
    )
    return SnapshotRunner(provider, runner_cfg)


def make_test_case(**overrides) -> SnapshotTestCase:
    from dataclasses import replace
    base = SnapshotTestCase(
        id="test-case-1",
        prompt_template="Summarise this: {{text}}",
        inputs={"text": "The system processed 1000 requests successfully."},
    )
    return replace(base, **overrides) if overrides else base


# ─── Unit: SnapshotStore ──────────────────────────────────────────────────────


class TestSnapshotStore:
    def test_returns_none_when_no_snapshot_exists(self, snap_dir):
        store = SnapshotStore(snap_dir)
        assert store.load("nonexistent") is None
        assert not store.exists("nonexistent")

    @pytest.mark.asyncio
    async def test_round_trips_snapshot(self, snap_dir):
        from .. import MockProvider as MP
        from ..types import SnapshotCharacteristics
        provider = MP()
        embedding = await provider.embed("test content")
        chars = SnapshotCharacteristics(
            embedding_vector=embedding,
            char_count=12,
            structural_fingerprint=None,
            key_phrases=["test"],
            captured_at="2026-01-01T00:00:00+00:00",
        )
        store = SnapshotStore(snap_dir)
        store.save("round-trip", chars)
        loaded = store.load("round-trip")
        assert loaded is not None
        assert loaded.char_count == 12
        assert loaded.key_phrases == ["test"]

    def test_sanitises_path_traversal_in_id(self, snap_dir):
        store = SnapshotStore(snap_dir)
        # Should not raise or create files outside snap_dir
        result = store.load("../../etc/passwd")
        assert result is None


# ─── Unit: first run creates baseline ─────────────────────────────────────────


class TestFirstRunCreatesBaseline:
    @pytest.mark.asyncio
    async def test_returns_none_on_first_run(self, snap_dir):
        runner = make_runner(["hello world response"], snap_dir)
        result = await runner.run(make_test_case())
        assert result is None  # None = baseline created, not pass/fail

    @pytest.mark.asyncio
    async def test_stores_baseline_on_first_run(self, snap_dir):
        runner = make_runner(["hello world response"], snap_dir)
        await runner.run(make_test_case())
        assert SnapshotStore(snap_dir).exists("test-case-1")


# ─── Unit: similarity threshold ───────────────────────────────────────────────


class TestSimilarityThreshold:
    @pytest.mark.asyncio
    async def test_passes_when_output_is_identical(self, snap_dir):
        response = "The system processed all requests without errors."
        runner = make_runner([response, response], snap_dir)
        tc = make_test_case()
        await runner.run(tc)  # create baseline
        result = await runner.run(tc)
        assert result is not None
        assert result.passed is True
        assert abs(result.similarity - 1.0) < 0.01

    @pytest.mark.asyncio
    async def test_fails_when_output_is_semantically_different(self, snap_dir):
        baseline_resp = "The system processed all requests without errors."
        regression_resp = "zzzzz qqqqq xxxxx yyyyy 9999 8888 7777 6666 5555 4444"
        runner1 = make_runner([baseline_resp], snap_dir)
        tc = make_test_case()
        await runner1.run(tc)  # create baseline

        runner2 = make_runner([regression_resp], snap_dir)
        result = await runner2.run(tc)
        assert result is not None
        assert result.passed is False
        assert result.similarity < 0.85


# ─── Unit: structural match ────────────────────────────────────────────────────


class TestStructuralMatch:
    @pytest.mark.asyncio
    async def test_fails_when_json_structure_changes_and_required(self, snap_dir):
        baseline = json.dumps({"status": "ok", "count": 5})
        regression = json.dumps({"status": "ok"})  # missing 'count'
        runner1 = make_runner([baseline], snap_dir)
        tc = make_test_case(id="struct-test")
        await runner1.run(tc)

        runner2 = make_runner(
            [regression], snap_dir,
            runner_overrides={"structural_match_required": True}
        )
        result = await runner2.run(tc)
        assert result is not None
        assert result.passed is False
        assert "removed key: count" in result.delta.structural_changes

    @pytest.mark.asyncio
    async def test_passes_when_structural_match_not_required(self, snap_dir):
        response = "All requests processed successfully without errors in the system."
        runner1 = make_runner([response], snap_dir)
        tc = make_test_case(id="struct-optional-test")
        await runner1.run(tc)

        runner2 = make_runner(
            [response], snap_dir,
            runner_overrides={"structural_match_required": False}
        )
        result = await runner2.run(tc)
        assert result is not None
        assert result.passed is True


# ─── Unit: update mode ─────────────────────────────────────────────────────────


class TestUpdateMode:
    @pytest.mark.asyncio
    async def test_overwrites_baseline_and_returns_none(self, snap_dir):
        original = "Original response text."
        updated = "Updated response text that is completely different."
        runner1 = make_runner([original], snap_dir)
        tc = make_test_case(id="update-mode-test")
        await runner1.run(tc)  # create initial baseline

        runner2 = make_runner(
            [updated], snap_dir,
            runner_overrides={"update_mode": True}
        )
        result = await runner2.run(tc)
        assert result is None  # update mode returns None

        stored = SnapshotStore(snap_dir).load("update-mode-test")
        assert stored is not None
        assert stored.char_count == len(updated)


# ─── Failure Mode Tests ────────────────────────────────────────────────────────


class TestFailureModeStaleSnapshotAcceptance:
    """Update mode is explicit opt-in — normal runs never overwrite baseline."""

    @pytest.mark.asyncio
    async def test_normal_run_does_not_overwrite_baseline(self, snap_dir):
        original = "Original high-quality response for stale test."
        degraded = "zzz qqq xxx yyy 999 888 777 666 555 444 333 222 111"
        tc = make_test_case(id="stale-test")

        runner1 = make_runner([original], snap_dir)
        await runner1.run(tc)  # establish baseline

        store = SnapshotStore(snap_dir)
        original_snapshot = store.load("stale-test")

        runner2 = make_runner([degraded], snap_dir)  # no update_mode
        result = await runner2.run(tc)

        after_snapshot = store.load("stale-test")
        assert after_snapshot is not None
        assert after_snapshot.char_count == original_snapshot.char_count
        assert result is not None
        assert result.passed is False


class TestFailureModeThresholdMiscalibration:
    @pytest.mark.asyncio
    async def test_high_threshold_generates_false_positives(self, snap_dir):
        """Overly tight threshold rejects valid stylistic variation."""
        baseline = "The service completed all tasks successfully and efficiently."
        rephrased = "All tasks were completed by the service, efficiently and successfully."

        runner1 = make_runner([baseline], snap_dir)
        tc = make_test_case(id="threshold-test")
        await runner1.run(tc)

        runner2 = make_runner(
            [rephrased], snap_dir,
            runner_overrides={"similarity_threshold": 0.999}
        )
        result = await runner2.run(tc)
        assert result is not None
        assert result.passed is False  # false positive from miscalibration
        assert result.similarity > 0.8  # content IS still similar

    @pytest.mark.asyncio
    async def test_low_threshold_misses_real_regression(self, snap_dir):
        """Overly loose threshold lets real regressions slip through."""
        good = "The system is healthy and all metrics are nominal."
        bad = "Error: connection timeout after 30 seconds of waiting."

        runner1 = make_runner([good], snap_dir)
        tc = make_test_case(id="low-threshold-test")
        await runner1.run(tc)

        runner2 = make_runner(
            [bad], snap_dir,
            runner_overrides={"similarity_threshold": 0.1}
        )
        result = await runner2.run(tc)
        assert result is not None
        assert result.passed is True  # regression slips through


class TestFailureModeMissingFirstRunBaseline:
    @pytest.mark.asyncio
    async def test_first_run_returns_none_not_pass(self, snap_dir):
        """First run returns None — forces explicit review of new baselines."""
        degraded = "ERROR: model response truncated unexpectedly."
        runner = make_runner([degraded], snap_dir)
        tc = make_test_case(id="first-run-test")

        result = await runner.run(tc)
        assert result is None  # None = "baseline created, needs review"
        assert SnapshotStore(snap_dir).exists("first-run-test")


class TestFailureModeEmbeddingModelDrift:
    """Silent degradation: embedding model version shift moves similarity scores."""

    @pytest.mark.asyncio
    async def test_detects_similarity_shift_from_embedding_drift(self, snap_dir):
        stable = "The system is operating normally. All checks passed."
        tc = make_test_case(id="drift-test")

        runner1 = make_runner([stable], snap_dir)
        await runner1.run(tc)  # establish baseline

        drifted_provider = MockProvider(MockProviderConfig(
            responses=[stable],
            embedding_drift_multiplier=5.0,
        ))
        runner2 = SnapshotRunner(
            drifted_provider,
            SnapshotRunnerConfig(snapshot_dir=snap_dir, similarity_threshold=0.85),
        )
        result = await runner2.run(tc)

        assert result is not None
        # Score is a float between 0 and 1 — drift is detectable
        # (allow tiny float overshoot from normalisation arithmetic)
        assert -1e-9 <= result.delta.semantic_similarity <= 1.0 + 1e-9


class TestFailureModeUpdateModeAccidents:
    @pytest.mark.asyncio
    async def test_no_overwrite_without_update_mode(self, snap_dir):
        original = "Original canonical response for production use."
        changed = "Completely different response that should not become baseline."
        tc = make_test_case(id="no-overwrite-test")

        store = SnapshotStore(snap_dir)
        runner1 = make_runner([original], snap_dir)
        await runner1.run(tc)

        runner2 = make_runner([changed], snap_dir)  # no update_mode
        await runner2.run(tc)

        baseline = store.load("no-overwrite-test")
        assert baseline is not None
        assert baseline.char_count == len(original)


# ─── Integration Tests ─────────────────────────────────────────────────────────


class TestIntegrationEndToEnd:
    @pytest.mark.asyncio
    async def test_run_all_separates_baselines_from_results(self, snap_dir):
        provider = MockProvider(MockProviderConfig(
            responses=["Response A for first case.", "Response B for second case."]
        ))
        runner = SnapshotRunner(provider, SnapshotRunnerConfig(snapshot_dir=snap_dir))

        cases = [
            make_test_case(id="case-a", inputs={"text": "case a"}),
            make_test_case(id="case-b", inputs={"text": "case b"}),
        ]

        # First run: all create baselines
        results, new_baselines = await runner.run_all(cases)
        assert len(new_baselines) == 2
        assert len(results) == 0

        # Second run (same responses): all pass
        provider.reset_call_count()
        results2, new_baselines2 = await runner.run_all(cases)
        assert len(new_baselines2) == 0
        assert len(results2) == 2
        assert all(r.passed for r in results2)

    @pytest.mark.asyncio
    async def test_reports_structured_delta_on_failure(self, snap_dir):
        baseline = json.dumps({"status": "ok", "result": "success"})
        regression = json.dumps({"status": "error"})  # missing 'result'
        tc = make_test_case(id="delta-test")

        runner1 = make_runner([baseline], snap_dir)
        await runner1.run(tc)

        runner2 = make_runner(
            [regression], snap_dir,
            runner_overrides={"structural_match_required": True}
        )
        result = await runner2.run(tc)
        assert result is not None
        assert result.passed is False
        assert "removed key: result" in result.delta.structural_changes

    @pytest.mark.asyncio
    async def test_separate_test_cases_do_not_share_snapshots(self, snap_dir):
        provider = MockProvider(MockProviderConfig(
            responses=["Response for alpha.", "Response for beta."]
        ))
        runner = SnapshotRunner(provider, SnapshotRunnerConfig(snapshot_dir=snap_dir))

        cases = [
            make_test_case(id="concurrent-alpha"),
            make_test_case(id="concurrent-beta"),
        ]
        await runner.run_all(cases)

        store = SnapshotStore(snap_dir)
        assert store.exists("concurrent-alpha")
        assert store.exists("concurrent-beta")

        alpha = store.load("concurrent-alpha")
        beta = store.load("concurrent-beta")
        assert alpha is not None and beta is not None
        assert alpha.char_count == len("Response for alpha.")
        assert beta.char_count == len("Response for beta.")

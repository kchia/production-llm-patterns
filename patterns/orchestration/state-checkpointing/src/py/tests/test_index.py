"""
Tests for state-checkpointing Python implementation.

Unit, failure mode, and integration tests mirror the TypeScript test suite.
Run: pytest src/py/tests/
"""
from __future__ import annotations

import time
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from src.py import CheckpointedWorkflow, InMemoryCheckpointStore
from src.py.mock_provider import MockLLMProvider, MockProviderConfig
from src.py.stores import InMemoryCheckpointStore
from src.py.types import CheckpointConfig, StepResult, WorkflowCheckpoint, WorkflowStep


# ── Helpers ──────────────────────────────────────────────────────────────────


class SimpleStep(WorkflowStep[dict, str]):
    def __init__(self, step_id: str, provider: MockLLMProvider, prompt: str = "test") -> None:
        self._id = step_id
        self._provider = provider
        self._prompt = prompt

    @property
    def id(self) -> str:
        return self._id

    async def execute(self, context: dict, previous_outputs: dict[str, Any]) -> str:
        res = await self._provider.complete(self._prompt)
        return res.content


def make_workflow(
    steps: list[WorkflowStep],
    store: InMemoryCheckpointStore,
    version: str = "1.0.0",
    max_retries: int = 2,
    retry_delay: float = 0.0,
    ttl: float = 60.0,
) -> CheckpointedWorkflow[dict, list[str]]:
    config = CheckpointConfig(
        store=store,
        workflow_version=version,
        max_retries_per_step=max_retries,
        retry_delay_s=retry_delay,
        step_ttl_s=ttl,
    )
    return CheckpointedWorkflow(
        steps=steps,
        assembler=lambda outputs, ctx: [outputs[s.id] for s in steps],
        config=config,
    )


# ── Unit tests ───────────────────────────────────────────────────────────────


class TestUnit:
    @pytest.mark.asyncio
    async def test_executes_all_steps_on_first_run(self):
        store = InMemoryCheckpointStore()
        provider = MockLLMProvider(MockProviderConfig(latency_s=0, latency_jitter_s=0))
        steps = [SimpleStep(f"s{i}", provider) for i in range(1, 4)]
        wf = make_workflow(steps, store)

        result = await wf.execute("wf-1", {})

        assert result.steps_executed == 3
        assert result.steps_skipped == 0
        assert len(result.output) == 3
        assert provider.total_calls == 3

    @pytest.mark.asyncio
    async def test_persists_checkpoint_after_each_step(self):
        store = InMemoryCheckpointStore()
        provider = MockLLMProvider(MockProviderConfig(latency_s=0, latency_jitter_s=0))
        steps = [SimpleStep("s1", provider), SimpleStep("s2", provider)]
        wf = make_workflow(steps, store)

        await wf.execute("wf-persist", {})

        checkpoint = await store.load("wf-persist")
        assert checkpoint is not None
        assert "s1" in checkpoint.steps
        assert "s2" in checkpoint.steps
        assert checkpoint.status == "completed"

    @pytest.mark.asyncio
    async def test_skips_completed_steps_on_resume(self):
        store = InMemoryCheckpointStore()
        provider = MockLLMProvider(MockProviderConfig(latency_s=0, latency_jitter_s=0))
        steps = [SimpleStep("s1", provider), SimpleStep("s2", provider)]
        wf = make_workflow(steps, store)

        await wf.execute("wf-resume", {})
        assert provider.total_calls == 2

        provider.reset()
        result = await wf.execute("wf-resume", {})

        assert result.steps_skipped == 2
        assert result.steps_executed == 0
        assert provider.total_calls == 0

    @pytest.mark.asyncio
    async def test_resumes_from_first_incomplete_step(self):
        store = InMemoryCheckpointStore()
        provider = MockLLMProvider(MockProviderConfig(latency_s=0, latency_jitter_s=0))
        call_count = {"n": 0}

        class FailOnceStep(WorkflowStep[dict, str]):
            @property
            def id(self) -> str:
                return "s2-fail"

            async def execute(self, context: dict, previous_outputs: dict[str, Any]) -> str:
                call_count["n"] += 1
                if call_count["n"] == 1:
                    raise RuntimeError("Simulated failure at step 2")
                return "step-2-result"

        steps: list[WorkflowStep] = [
            SimpleStep("s1", provider),
            FailOnceStep(),
            SimpleStep("s3", provider),
        ]
        wf = make_workflow(steps, store, max_retries=1)

        with pytest.raises(RuntimeError, match="Simulated failure at step 2"):
            await wf.execute("wf-mid-fail", {})

        checkpoint = await store.load("wf-mid-fail")
        assert "s1" in checkpoint.steps
        assert "s2-fail" not in checkpoint.steps

        provider.reset()
        result = await wf.execute("wf-mid-fail", {})

        assert result.steps_skipped == 1
        assert result.steps_executed == 2
        assert provider.total_calls == 1  # only s3 used provider

    @pytest.mark.asyncio
    async def test_loads_saved_output_from_partial_checkpoint(self):
        store = InMemoryCheckpointStore()
        provider = MockLLMProvider(MockProviderConfig(latency_s=0, latency_jitter_s=0))
        steps = [SimpleStep("s1", provider), SimpleStep("s2", provider)]
        wf = make_workflow(steps, store)

        # Inject partial checkpoint (s1 done)
        await store.save("wf-partial", WorkflowCheckpoint(
            workflow_id="wf-partial",
            workflow_version="1.0.0",
            started_at=time.time() - 5,
            updated_at=time.time() - 5,
            steps={"s1": StepResult(output="saved-output", completed_at=time.time() - 5, duration_s=0.1)},
            status="running",
            resume_from=1,
        ))

        result = await wf.execute("wf-partial", {})
        assert result.steps_skipped == 1
        assert result.output[0] == "saved-output"
        assert provider.total_calls == 1  # only s2 ran

    @pytest.mark.asyncio
    async def test_store_save_load_clear(self):
        store = InMemoryCheckpointStore()
        cp = WorkflowCheckpoint(
            workflow_id="test",
            workflow_version="1.0.0",
            started_at=1000.0,
            updated_at=2000.0,
            steps={"s1": StepResult(output="x", completed_at=1500.0, duration_s=0.5)},
            status="running",
            resume_from=1,
        )
        await store.save("test", cp)
        loaded = await store.load("test")
        assert loaded is not None
        assert loaded.workflow_id == "test"
        assert loaded is not cp  # deep copy

        await store.clear("test")
        assert await store.load("test") is None


# ── Failure mode tests ────────────────────────────────────────────────────────


class TestFailureModes:
    @pytest.mark.asyncio
    async def test_rejects_incompatible_workflow_version(self):
        store = InMemoryCheckpointStore()
        provider = MockLLMProvider(MockProviderConfig(latency_s=0, latency_jitter_s=0))
        steps = [SimpleStep("s1", provider)]

        wf_v1 = make_workflow(steps, store, version="1.0.0")
        await wf_v1.execute("wf-version", {})

        wf_v2 = make_workflow(steps, store, version="2.0.0")
        with pytest.raises(ValueError, match="Checkpoint version mismatch"):
            await wf_v2.execute("wf-version", {})

    @pytest.mark.asyncio
    async def test_fails_fast_when_store_load_raises(self):
        store = InMemoryCheckpointStore()
        provider = MockLLMProvider(MockProviderConfig(latency_s=0, latency_jitter_s=0))
        steps = [SimpleStep("s1", provider)]
        wf = make_workflow(steps, store)

        with patch.object(store, "load", new_callable=AsyncMock) as mock_load:
            mock_load.side_effect = RuntimeError("Store unavailable")
            with pytest.raises(RuntimeError, match="Store unavailable"):
                await wf.execute("wf-broken", {})

    @pytest.mark.asyncio
    async def test_propagates_checkpoint_write_failure(self):
        store = InMemoryCheckpointStore()
        provider = MockLLMProvider(MockProviderConfig(latency_s=0, latency_jitter_s=0))
        steps = [SimpleStep("s1", provider), SimpleStep("s2", provider)]
        wf = make_workflow(steps, store)

        save_count = {"n": 0}
        original_save = store.save

        async def failing_save(workflow_id, checkpoint):
            save_count["n"] += 1
            if save_count["n"] == 2:
                raise RuntimeError("Write failed")
            return await original_save(workflow_id, checkpoint)

        with patch.object(store, "save", side_effect=failing_save):
            with pytest.raises(RuntimeError, match="Write failed"):
                await wf.execute("wf-write-fail", {})

    @pytest.mark.asyncio
    async def test_unknown_workflow_id_starts_fresh(self):
        store = InMemoryCheckpointStore()
        provider = MockLLMProvider(MockProviderConfig(latency_s=0, latency_jitter_s=0))
        steps = [SimpleStep("s1", provider)]
        wf = make_workflow(steps, store)

        await wf.execute("wf-A", {})
        provider.reset()

        result = await wf.execute("wf-B", {})
        assert result.steps_skipped == 0
        assert provider.total_calls == 1

    @pytest.mark.asyncio
    async def test_clear_removes_checkpoint(self):
        store = InMemoryCheckpointStore()
        provider = MockLLMProvider(MockProviderConfig(latency_s=0, latency_jitter_s=0))
        steps = [SimpleStep("s1", provider)]
        wf = make_workflow(steps, store)

        await wf.execute("wf-cleanup", {})
        assert store.size() == 1

        await store.clear("wf-cleanup")
        assert store.size() == 0
        assert await store.load("wf-cleanup") is None

    @pytest.mark.asyncio
    async def test_throws_after_max_retries_exhausted(self):
        class AlwaysFailStep(WorkflowStep[dict, str]):
            @property
            def id(self) -> str:
                return "always-fail"

            async def execute(self, context: dict, previous_outputs: dict[str, Any]) -> str:
                raise RuntimeError("Persistent step failure")

        store = InMemoryCheckpointStore()
        wf = make_workflow([AlwaysFailStep()], store, max_retries=2, retry_delay=0.0)

        with pytest.raises(RuntimeError, match="Persistent step failure"):
            await wf.execute("wf-exhausted", {})

    @pytest.mark.asyncio
    async def test_re_executes_expired_steps(self):
        store = InMemoryCheckpointStore()
        provider = MockLLMProvider(MockProviderConfig(latency_s=0, latency_jitter_s=0))
        steps = [SimpleStep("s1", provider)]

        # Inject expired checkpoint (completed 2 hours ago, TTL=1 hour)
        await store.save("wf-expired", WorkflowCheckpoint(
            workflow_id="wf-expired",
            workflow_version="1.0.0",
            started_at=time.time() - 7200,
            updated_at=time.time() - 7200,
            steps={"s1": StepResult(output="stale", completed_at=time.time() - 7200, duration_s=0.1)},
            status="running",
            resume_from=0,
        ))

        wf = make_workflow(steps, store, ttl=3600.0)  # TTL = 1 hour
        result = await wf.execute("wf-expired", {})

        assert result.steps_skipped == 0
        assert result.steps_executed == 1
        assert result.output[0] != "stale"


# ── Integration tests ─────────────────────────────────────────────────────────


class TestIntegration:
    @pytest.mark.asyncio
    async def test_full_workflow_five_steps(self):
        store = InMemoryCheckpointStore()
        provider = MockLLMProvider(
            MockProviderConfig(
                latency_s=0.005,
                latency_jitter_s=0,
                responses=[f"result-{i}" for i in range(1, 6)],
            )
        )
        steps = [SimpleStep(f"step-{i}", provider, f"prompt {i}") for i in range(1, 6)]
        wf = make_workflow(steps, store)

        result = await wf.execute("wf-full", {"input": "test"})

        assert result.steps_executed == 5
        assert result.steps_skipped == 0
        assert len(result.output) == 5
        assert provider.total_calls == 5

    @pytest.mark.asyncio
    async def test_concurrent_workflows_separate_namespaces(self):
        store = InMemoryCheckpointStore()
        provider = MockLLMProvider(MockProviderConfig(latency_s=0.01, latency_jitter_s=0))
        import asyncio

        async def run_workflow(wf_id: str) -> None:
            steps = [SimpleStep("s1", provider)]
            wf = make_workflow(steps, store)
            await wf.execute(wf_id, {})

        await asyncio.gather(
            run_workflow("concurrent-1"),
            run_workflow("concurrent-2"),
            run_workflow("concurrent-3"),
        )

        assert store.size() == 3
        assert "concurrent-1" in store.keys()
        assert "concurrent-2" in store.keys()
        assert "concurrent-3" in store.keys()

    @pytest.mark.asyncio
    async def test_get_checkpoint_reflects_partial_state(self):
        store = InMemoryCheckpointStore()
        provider = MockLLMProvider(MockProviderConfig(latency_s=0, latency_jitter_s=0))
        fail_first = {"v": True}

        class FailOnceStep(WorkflowStep[dict, str]):
            @property
            def id(self) -> str:
                return "s2"

            async def execute(self, context: dict, previous_outputs: dict[str, Any]) -> str:
                if fail_first["v"]:
                    fail_first["v"] = False
                    raise RuntimeError("First attempt fails")
                return "s2-success"

        steps: list[WorkflowStep] = [SimpleStep("s1", provider), FailOnceStep()]
        wf = make_workflow(steps, store, max_retries=1)

        with pytest.raises(RuntimeError):
            await wf.execute("wf-partial", {})

        checkpoint = await wf.get_checkpoint("wf-partial")
        assert checkpoint is not None
        assert "s1" in checkpoint.steps
        assert "s2" not in checkpoint.steps
        assert checkpoint.resume_from == 1

        result = await wf.execute("wf-partial", {})
        assert result.steps_skipped == 1
        assert result.output[1] == "s2-success"

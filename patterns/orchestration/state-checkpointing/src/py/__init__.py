"""
State Checkpointing — Python implementation.

Durable state persistence for long-running LLM workflows. When a workflow
fails partway through, checkpointing allows it to resume from the last
completed step rather than restarting from scratch.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Callable, Generic, TypeVar

from .stores import InMemoryCheckpointStore
from .types import (
    CheckpointConfig,
    CheckpointStore,
    StepResult,
    WorkflowCheckpoint,
    WorkflowResult,
    WorkflowStep,
)

__all__ = [
    "CheckpointedWorkflow",
    "CheckpointConfig",
    "CheckpointStore",
    "WorkflowCheckpoint",
    "WorkflowStep",
    "WorkflowResult",
    "StepResult",
    "InMemoryCheckpointStore",
]

TContext = TypeVar("TContext")
TResult = TypeVar("TResult")

_DEFAULT_CONFIG = CheckpointConfig(
    store=None,  # type: ignore[arg-type] — replaced by caller
    workflow_version="1.0.0",
    step_ttl_s=86400.0,
    max_retries_per_step=3,
    retry_delay_s=1.0,
    checksum_context=False,
)


class CheckpointedWorkflow(Generic[TContext, TResult]):
    """
    Wraps a sequence of workflow steps with durable state persistence.

    On first run: executes all steps in order, saving a checkpoint after each.
    On retry: loads the last checkpoint, skips completed steps, resumes from
    the first incomplete step. Completed steps return their saved outputs
    without re-executing — each LLM call is paid for exactly once.

    Usage:
        store = InMemoryCheckpointStore()
        workflow = CheckpointedWorkflow(
            steps=[step1, step2, step3],
            assembler=lambda outputs, ctx: [outputs["s1"], outputs["s2"]],
            config=CheckpointConfig(store=store),
        )
        result = await workflow.execute("job-123", context)
    """

    def __init__(
        self,
        steps: list[WorkflowStep[TContext, Any]],
        assembler: Callable[[dict[str, Any], TContext], TResult],
        config: CheckpointConfig,
    ) -> None:
        self._steps = steps
        self._assembler = assembler
        self._config = config

    async def execute(self, workflow_id: str, context: TContext) -> WorkflowResult[TResult]:
        start = time.monotonic()

        existing = await self._config.store.load(workflow_id)
        checkpoint = self._init_checkpoint(workflow_id, existing)

        steps_executed = 0
        steps_skipped = 0
        previous_outputs: dict[str, Any] = {}

        # Seed previous_outputs from any already-completed steps
        for step in self._steps:
            saved = checkpoint.steps.get(step.id)
            if saved:
                previous_outputs[step.id] = saved.output

        for i in range(checkpoint.resume_from, len(self._steps)):
            step = self._steps[i]
            saved = checkpoint.steps.get(step.id)

            if saved and not self._is_expired(saved.completed_at):
                previous_outputs[step.id] = saved.output
                steps_skipped += 1
                continue

            output = await self._execute_with_retry(step, context, previous_outputs)
            previous_outputs[step.id] = output

            completed_at = time.time()
            checkpoint.steps[step.id] = StepResult(
                output=output,
                completed_at=completed_at,
                duration_s=time.monotonic() - start,
            )
            checkpoint.resume_from = i + 1
            checkpoint.updated_at = time.time()

            await self._config.store.save(workflow_id, checkpoint)
            steps_executed += 1

        checkpoint.status = "completed"
        checkpoint.updated_at = time.time()
        await self._config.store.save(workflow_id, checkpoint)

        result = self._assembler(previous_outputs, context)
        return WorkflowResult(
            output=result,
            workflow_id=workflow_id,
            steps_executed=steps_executed,
            steps_skipped=steps_skipped,
            total_duration_s=time.monotonic() - start,
        )

    async def resume(self, workflow_id: str, context: TContext) -> WorkflowResult[TResult]:
        """
        Resume a previously started workflow. Raises if no checkpoint exists.
        """
        checkpoint = await self._config.store.load(workflow_id)
        if checkpoint is None:
            raise ValueError(f"No checkpoint found for workflow: {workflow_id}")
        return await self.execute(workflow_id, context)

    async def get_checkpoint(self, workflow_id: str) -> WorkflowCheckpoint | None:
        return await self._config.store.load(workflow_id)

    def _init_checkpoint(
        self, workflow_id: str, existing: WorkflowCheckpoint | None
    ) -> WorkflowCheckpoint:
        if existing is not None:
            # Reject checkpoints from incompatible workflow versions to prevent
            # silently mixing outputs from different schemas
            if existing.workflow_version != self._config.workflow_version:
                raise ValueError(
                    f"Checkpoint version mismatch: checkpoint is v{existing.workflow_version}, "
                    f"workflow is v{self._config.workflow_version}. "
                    f"Clear the checkpoint before running the updated workflow."
                )
            return existing

        now = time.time()
        return WorkflowCheckpoint(
            workflow_id=workflow_id,
            workflow_version=self._config.workflow_version,
            started_at=now,
            updated_at=now,
        )

    def _is_expired(self, completed_at: float) -> bool:
        return (time.time() - completed_at) > self._config.step_ttl_s

    async def _execute_with_retry(
        self,
        step: WorkflowStep[TContext, Any],
        context: TContext,
        previous_outputs: dict[str, Any],
    ) -> Any:
        last_error: Exception | None = None

        for attempt in range(self._config.max_retries_per_step):
            try:
                return await step.execute(context, previous_outputs)
            except Exception as exc:
                last_error = exc
                if attempt < self._config.max_retries_per_step - 1:
                    # Exponential backoff: retry_delay_s * 2^attempt
                    delay = self._config.retry_delay_s * (2**attempt)
                    await asyncio.sleep(delay)

        raise last_error or RuntimeError(
            f"Step {step.id} failed after {self._config.max_retries_per_step} attempts"
        )

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Generic, Protocol, TypeVar

TContext = TypeVar("TContext")
TOutput = TypeVar("TOutput")
TResult = TypeVar("TResult")


@dataclass
class StepResult:
    output: Any
    completed_at: float  # Unix timestamp (seconds)
    duration_s: float
    input_hash: str | None = None  # optional: for drift detection


@dataclass
class WorkflowCheckpoint:
    workflow_id: str
    workflow_version: str
    started_at: float
    updated_at: float
    steps: dict[str, StepResult] = field(default_factory=dict)
    status: str = "running"  # "running" | "completed" | "failed"
    resume_from: int = 0
    context_hash: str | None = None


@dataclass
class WorkflowResult(Generic[TResult]):
    output: TResult
    workflow_id: str
    steps_executed: int
    steps_skipped: int
    total_duration_s: float


@dataclass
class LLMResponse:
    content: str
    input_tokens: int
    output_tokens: int
    latency_s: float


class CheckpointStore(ABC):
    @abstractmethod
    async def save(self, workflow_id: str, checkpoint: WorkflowCheckpoint) -> None: ...

    @abstractmethod
    async def load(self, workflow_id: str) -> WorkflowCheckpoint | None: ...

    @abstractmethod
    async def clear(self, workflow_id: str) -> None: ...


class WorkflowStep(ABC, Generic[TContext, TOutput]):
    @property
    @abstractmethod
    def id(self) -> str: ...

    @abstractmethod
    async def execute(
        self, context: TContext, previous_outputs: dict[str, Any]
    ) -> TOutput: ...


class LLMProvider(Protocol):
    async def complete(self, prompt: str, **kwargs: Any) -> LLMResponse: ...


@dataclass
class CheckpointConfig:
    store: CheckpointStore
    workflow_version: str = "1.0.0"
    step_ttl_s: float = 86400.0  # 24 hours
    max_retries_per_step: int = 3
    retry_delay_s: float = 1.0
    checksum_context: bool = False

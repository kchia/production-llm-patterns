from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any


class Severity(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"


class HunkType(str, Enum):
    ADDED = "added"
    REMOVED = "removed"
    UNCHANGED = "unchanged"


class DiffGranularity(str, Enum):
    WORD = "word"
    SENTENCE = "sentence"
    PARAGRAPH = "paragraph"


@dataclass
class DiffHunk:
    type: HunkType
    value: str


@dataclass
class PromptDiff:
    version_a: str
    version_b: str
    prompt_name: str
    hunks: list[DiffHunk]
    severity: Severity
    semantic_distance: float
    added_tokens: int
    removed_tokens: int
    summary: str
    timestamp: datetime = field(default_factory=datetime.utcnow)


@dataclass
class QualityMetrics:
    prompt_version: str
    window_start: datetime
    window_end: datetime
    # Caller-defined quality signals stored as extra kwargs
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class CorrelationReport:
    diff: PromptDiff
    metrics: QualityMetrics | None
    correlation_available: bool
    note: str | None = None


@dataclass
class PromptDifferConfig:
    diff_granularity: DiffGranularity = DiffGranularity.WORD
    high_severity_threshold: float = 0.15
    medium_severity_threshold: float = 0.05
    include_unchanged: bool = False
    max_hunk_context: int = 3
    # Correlation window in seconds — quality metrics may lag by hours after a deploy
    correlation_window_seconds: float = 4 * 60 * 60


@dataclass
class PromptVersion:
    id: str
    name: str
    content: str
    created_at: datetime = field(default_factory=datetime.utcnow)
    metadata: dict[str, Any] | None = None


class PromptRegistry(ABC):
    @abstractmethod
    async def get(self, version_id: str) -> PromptVersion | None: ...

    @abstractmethod
    async def get_latest(self, prompt_name: str) -> PromptVersion | None: ...

    @abstractmethod
    async def get_previous(self, version_id: str) -> PromptVersion | None: ...

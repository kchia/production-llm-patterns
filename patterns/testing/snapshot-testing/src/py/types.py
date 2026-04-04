"""
Type definitions for the Snapshot Testing pattern.

Python idioms:
- dataclasses for value objects (immutable state, no methods)
- TypedDict for config (easy dict ↔ object interop)
- Protocol for the LLMProvider interface (duck typing friendly)
"""

from __future__ import annotations

import typing
from dataclasses import dataclass, field
from typing import Optional, Protocol, runtime_checkable


@dataclass(frozen=True)
class StructuralFingerprint:
    """JSON structure fingerprint: present top-level keys and their value types."""
    top_level_keys: tuple[str, ...]
    key_types: dict[str, str]  # key -> "string" | "number" | "array" | "object" | "null" | "boolean"


@dataclass
class SnapshotCharacteristics:
    """Derived characteristics stored as the baseline for a test case.

    Storing characteristics rather than raw output makes comparisons
    reproducible and cheap — no re-embedding on every test run.
    """
    embedding_vector: list[float]
    char_count: int
    structural_fingerprint: Optional[StructuralFingerprint]
    key_phrases: list[str]
    captured_at: str  # ISO 8601 timestamp


@dataclass(frozen=True)
class SnapshotDelta:
    """Structured diff between baseline and live characteristics."""
    semantic_similarity: float         # cosine similarity, 0–1
    length_ratio_change: float         # (live / baseline) - 1; positive = longer
    missing_key_phrases: list[str]     # phrases in baseline not in live
    structural_changes: list[str]      # human-readable change descriptions


@dataclass(frozen=True)
class SnapshotTestCase:
    """A single test case for the snapshot runner."""
    id: str                            # Unique, stable identifier — storage key
    prompt_template: str               # Prompt with {{variable}} placeholders
    inputs: dict[str, object]          # Values to interpolate into the template
    # Optional: override stored baseline for this run only
    expected_characteristics: Optional[dict[str, object]] = None


@dataclass(frozen=True)
class SnapshotResult:
    """Result of comparing a live output against a stored baseline."""
    test_case_id: str
    passed: bool
    similarity: float                  # cosine similarity to baseline
    delta: SnapshotDelta
    baseline: SnapshotCharacteristics
    live: SnapshotCharacteristics


@dataclass
class SnapshotRunnerConfig:
    """Configuration for SnapshotRunner with sensible defaults."""
    snapshot_dir: str = ".snapshots"
    # 0.85 suits free-form prose; raise toward 0.92 for structured outputs
    similarity_threshold: float = 0.85
    # Set False for free-form prose where JSON structure isn't expected
    structural_match_required: bool = True
    # Set True when all key phrases from baseline must be present
    key_phrases_required: bool = False
    # When True, overwrite stored baselines — explicit opt-in only
    update_mode: bool = False


@runtime_checkable
class LLMProvider(Protocol):
    """Protocol interface for LLM providers (real or mock)."""

    async def complete(self, prompt: str) -> str:
        """Generate a completion for the given prompt."""
        ...

    async def embed(self, text: str) -> list[float]:
        """Return an embedding vector for the given text."""
        ...

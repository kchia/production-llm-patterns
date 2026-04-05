"""Prompt Diffing pattern — Python implementation.

Computes structural (word/sentence/paragraph) and semantic (cosine distance)
diffs between prompt versions, then classifies change severity for production
monitoring and quality correlation.
"""
from __future__ import annotations

import asyncio
import math
import re
from datetime import datetime
from difflib import SequenceMatcher
from typing import Protocol

try:
    from .models import (
        CorrelationReport,
        DiffGranularity,
        DiffHunk,
        HunkType,
        PromptDiff,
        PromptDifferConfig,
        PromptRegistry,
        PromptVersion,
        QualityMetrics,
        Severity,
    )
except ImportError:
    # Fallback for direct file loading (importlib, scripts, etc.)
    from models import (  # type: ignore[no-redef]
        CorrelationReport,
        DiffGranularity,
        DiffHunk,
        HunkType,
        PromptDiff,
        PromptDifferConfig,
        PromptRegistry,
        PromptVersion,
        QualityMetrics,
        Severity,
    )

__all__ = [
    "PromptDiffer",
    "cosine_distance",
    "tokenize",
    "diff_hunks",
    "merge_consecutive",
    "PromptDifferConfig",
]


class EmbeddingProvider(Protocol):
    async def embed(self, text: str) -> list[float]: ...


_DEFAULTS = PromptDifferConfig()


class PromptDiffer:
    def __init__(
        self,
        registry: PromptRegistry,
        embedder: EmbeddingProvider,
        config: PromptDifferConfig | None = None,
    ) -> None:
        self._registry = registry
        self._embedder = embedder
        self._config = config or _DEFAULTS

    async def diff(self, version_a_id: str, version_b_id: str) -> PromptDiff:
        """Diff two specific versions by ID. Raises if either version is missing."""
        v_a, v_b = await asyncio.gather(
            self._fetch_or_raise(version_a_id),
            self._fetch_or_raise(version_b_id),
        )
        return await self._compute_diff(v_a, v_b)

    async def diff_latest(self, prompt_name: str) -> PromptDiff:
        """Diff the latest version against its predecessor. Safe for post-save hooks."""
        latest = await self._registry.get_latest(prompt_name)
        if latest is None:
            raise ValueError(f"No versions found for prompt {prompt_name!r}")
        previous = await self._registry.get_previous(latest.id)
        if previous is None:
            return _empty_diff(latest.name, latest.id, latest.id)
        return await self._compute_diff(previous, latest)

    def correlate(
        self, diff: PromptDiff, metrics: QualityMetrics | None
    ) -> CorrelationReport:
        """Join a diff with quality metrics. Correlation is best-effort; never block on it."""
        if metrics is None:
            return CorrelationReport(
                diff=diff,
                metrics=None,
                correlation_available=False,
                note=(
                    "No quality metrics provided — ensure metric pipeline "
                    "attaches prompt_version to each LLM span"
                ),
            )
        return CorrelationReport(diff=diff, metrics=metrics, correlation_available=True)

    async def _compute_diff(
        self, v_a: PromptVersion, v_b: PromptVersion
    ) -> PromptDiff:
        # Run structural diff and embedding calls concurrently
        # diff_hunks is sync; wrap in a coroutine for gather
        async def _run_diff() -> list[DiffHunk]:
            return diff_hunks(v_a.content, v_b.content, self._config)

        hunks, (emb_a, emb_b) = await asyncio.gather(
            _run_diff(),
            asyncio.gather(
                self._embedder.embed(v_a.content),
                self._embedder.embed(v_b.content),
            ),
        )

        semantic_dist = cosine_distance(emb_a, emb_b)
        severity = self._classify_severity(semantic_dist)

        added = sum(_word_count(h.value) for h in hunks if h.type == HunkType.ADDED)
        removed = sum(_word_count(h.value) for h in hunks if h.type == HunkType.REMOVED)

        filtered = (
            hunks
            if self._config.include_unchanged
            else [h for h in hunks if h.type != HunkType.UNCHANGED]
        )

        return PromptDiff(
            version_a=v_a.id,
            version_b=v_b.id,
            prompt_name=v_a.name,
            hunks=filtered,
            severity=severity,
            semantic_distance=semantic_dist,
            added_tokens=added,
            removed_tokens=removed,
            summary=_build_summary(severity, semantic_dist, added, removed),
            timestamp=datetime.utcnow(),
        )

    def _classify_severity(self, distance: float) -> Severity:
        if distance >= self._config.high_severity_threshold:
            return Severity.HIGH
        if distance >= self._config.medium_severity_threshold:
            return Severity.MEDIUM
        return Severity.LOW

    async def _fetch_or_raise(self, version_id: str) -> PromptVersion:
        version = await self._registry.get(version_id)
        if version is None:
            raise LookupError(f"Prompt version {version_id!r} not found in registry")
        return version


# ── Diff algorithm ────────────────────────────────────────────────────────────

def tokenize(text: str, granularity: DiffGranularity) -> list[str]:
    """Split text into tokens at the specified granularity."""
    if granularity == DiffGranularity.WORD:
        # Preserve whitespace as tokens for faithful reconstruction
        return [t for t in re.split(r"(\s+)", text) if t]
    elif granularity == DiffGranularity.SENTENCE:
        # Split after sentence-ending punctuation followed by whitespace
        parts = re.split(r"(?<=[.!?])\s+", text)
        return [p for p in parts if p]
    else:  # PARAGRAPH
        parts = re.split(r"\n\n+", text)
        return [p for p in parts if p]


def diff_hunks(
    text_a: str, text_b: str, config: PromptDifferConfig
) -> list[DiffHunk]:
    """
    Produce add/remove/unchanged hunks.

    Uses difflib.SequenceMatcher — idiomatic Python stdlib — rather than
    a hand-rolled LCS. Behaviour is equivalent but the implementation is
    cleaner and handles edge-cases (empty sequences, long texts) robustly.
    """
    tokens_a = tokenize(text_a, config.diff_granularity)
    tokens_b = tokenize(text_b, config.diff_granularity)

    matcher = SequenceMatcher(None, tokens_a, tokens_b, autojunk=False)
    hunks: list[DiffHunk] = []

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            hunks.append(DiffHunk(HunkType.UNCHANGED, "".join(tokens_a[i1:i2])))
        elif tag == "insert":
            hunks.append(DiffHunk(HunkType.ADDED, "".join(tokens_b[j1:j2])))
        elif tag == "delete":
            hunks.append(DiffHunk(HunkType.REMOVED, "".join(tokens_a[i1:i2])))
        elif tag == "replace":
            hunks.append(DiffHunk(HunkType.REMOVED, "".join(tokens_a[i1:i2])))
            hunks.append(DiffHunk(HunkType.ADDED, "".join(tokens_b[j1:j2])))

    return merge_consecutive(hunks)


def merge_consecutive(hunks: list[DiffHunk]) -> list[DiffHunk]:
    """Merge adjacent hunks of the same type for cleaner output."""
    if not hunks:
        return hunks
    merged = [DiffHunk(hunks[0].type, hunks[0].value)]
    for hunk in hunks[1:]:
        if merged[-1].type == hunk.type:
            merged[-1] = DiffHunk(merged[-1].type, merged[-1].value + hunk.value)
        else:
            merged.append(DiffHunk(hunk.type, hunk.value))
    return merged


# ── Embedding utilities ───────────────────────────────────────────────────────

def cosine_distance(a: list[float], b: list[float]) -> float:
    if len(a) != len(b):
        raise ValueError("Embedding dimension mismatch")
    dot = sum(x * y for x, y in zip(a, b))
    mag_a = math.sqrt(sum(x * x for x in a))
    mag_b = math.sqrt(sum(y * y for y in b))
    if mag_a == 0 or mag_b == 0:
        return 1.0  # maximally distant for zero vectors
    return 1.0 - dot / (mag_a * mag_b)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _word_count(text: str) -> int:
    return len(text.split())


def _build_summary(
    severity: Severity, distance: float, added: int, removed: int
) -> str:
    parts = [f"[{severity.value}]"]
    if added:
        parts.append(f"+{added} words")
    if removed:
        parts.append(f"-{removed} words")
    parts.append(f"semantic distance: {distance:.3f}")
    return " — ".join(parts)


def _empty_diff(prompt_name: str, version_id: str, prev_id: str) -> PromptDiff:
    return PromptDiff(
        version_a=prev_id,
        version_b=version_id,
        prompt_name=prompt_name,
        hunks=[],
        severity=Severity.LOW,
        semantic_distance=0.0,
        added_tokens=0,
        removed_tokens=0,
        summary="[LOW] — first version, no previous to compare",
    )

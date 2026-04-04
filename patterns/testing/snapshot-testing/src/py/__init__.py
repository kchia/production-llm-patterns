"""
Snapshot Testing pattern — Python implementation.

Core flow:
  1. Run the prompt with test inputs to get a live output
  2. Extract characteristics (embedding, structure, key phrases, length)
  3. Compare against stored baseline characteristics
  4. Pass if similarity >= threshold AND structural/phrase constraints hold
  5. Fail with a structured delta showing exactly what changed

On first run (no stored baseline), the live characteristics are stored
as the baseline and the test returns None — callers treat None as
"baseline created, needs review" rather than a test failure.

Python-specific choices vs. TypeScript:
- dataclasses replace TypeScript interfaces (frozen=True for immutability)
- pathlib.Path replaces node's path module
- re.findall replaces regex + array iteration
- json.loads raises ValueError on failure (caught as plain Exception)
- asyncio.run() for test/script entry points (TypeScript handles this implicitly)
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Optional

from .mock_provider import MockProvider, MockProviderConfig
from .types import (
    LLMProvider,
    SnapshotCharacteristics,
    SnapshotDelta,
    SnapshotResult,
    SnapshotRunnerConfig,
    SnapshotTestCase,
    StructuralFingerprint,
)

__all__ = [
    "SnapshotRunner",
    "SnapshotStore",
    "MockProvider",
    "MockProviderConfig",
    "SnapshotTestCase",
    "SnapshotCharacteristics",
    "SnapshotDelta",
    "SnapshotResult",
    "SnapshotRunnerConfig",
    "StructuralFingerprint",
    "LLMProvider",
]

# ─── Characteristic Extraction ────────────────────────────────────────────────


def _interpolate_template(template: str, inputs: dict[str, object]) -> str:
    """Replace {{variable}} placeholders in the template with input values."""
    return re.sub(
        r"\{\{(\w+)\}\}",
        lambda m: str(inputs.get(m.group(1), m.group(0))),
        template,
    )


def _extract_structural_fingerprint(text: str) -> Optional[StructuralFingerprint]:
    """Parse JSON and extract top-level key structure. Returns None for non-JSON."""
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None

    if not isinstance(parsed, dict):
        return None

    top_level_keys = tuple(sorted(parsed.keys()))
    key_types: dict[str, str] = {}
    for key, val in parsed.items():
        if val is None:
            key_types[key] = "null"
        elif isinstance(val, bool):
            key_types[key] = "boolean"
        elif isinstance(val, list):
            key_types[key] = "array"
        elif isinstance(val, dict):
            key_types[key] = "object"
        elif isinstance(val, (int, float)):
            key_types[key] = "number"
        else:
            key_types[key] = "string"

    return StructuralFingerprint(top_level_keys=top_level_keys, key_types=key_types)


def _extract_key_phrases(text: str) -> list[str]:
    """Extract high-frequency words (>= 4 chars, appearing >= 2 times), capped at 20."""
    words = re.findall(r"\b[a-z]{4,}\b", text.lower())
    freq: dict[str, int] = {}
    for word in words:
        freq[word] = freq.get(word, 0) + 1
    phrases = [w for w, count in freq.items() if count >= 2]
    return phrases[:20]


async def _extract_characteristics(
    text: str, provider: LLMProvider
) -> SnapshotCharacteristics:
    from datetime import datetime, timezone

    embedding_vector = await provider.embed(text)
    return SnapshotCharacteristics(
        embedding_vector=embedding_vector,
        char_count=len(text),
        structural_fingerprint=_extract_structural_fingerprint(text),
        key_phrases=_extract_key_phrases(text),
        captured_at=datetime.now(timezone.utc).isoformat(),
    )


# ─── Similarity Computation ────────────────────────────────────────────────────


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    if len(a) != len(b) or not a:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    mag_a = math.sqrt(sum(x * x for x in a))
    mag_b = math.sqrt(sum(x * x for x in b))
    denom = mag_a * mag_b
    return 0.0 if denom == 0 else dot / denom


# ─── Delta Computation ────────────────────────────────────────────────────────


def _compute_delta(
    baseline: SnapshotCharacteristics, live: SnapshotCharacteristics
) -> SnapshotDelta:
    semantic_similarity = _cosine_similarity(
        baseline.embedding_vector, live.embedding_vector
    )

    length_ratio_change = (
        live.char_count / baseline.char_count - 1 if baseline.char_count > 0 else 0.0
    )

    live_phrases_set = set(live.key_phrases)
    missing_key_phrases = [p for p in baseline.key_phrases if p not in live_phrases_set]

    structural_changes: list[str] = []
    b_fp = baseline.structural_fingerprint
    l_fp = live.structural_fingerprint

    if b_fp and l_fp:
        b_keys = set(b_fp.top_level_keys)
        l_keys = set(l_fp.top_level_keys)
        for k in b_keys - l_keys:
            structural_changes.append(f"removed key: {k}")
        for k in l_keys - b_keys:
            structural_changes.append(f"added key: {k}")
        for k in b_keys & l_keys:
            if b_fp.key_types.get(k) != l_fp.key_types.get(k):
                structural_changes.append(
                    f'type change for "{k}": {b_fp.key_types.get(k)} → {l_fp.key_types.get(k)}'
                )
    elif b_fp and not l_fp:
        structural_changes.append("output is no longer valid JSON")
    elif not b_fp and l_fp:
        structural_changes.append("output is now valid JSON (was plain text)")

    return SnapshotDelta(
        semantic_similarity=semantic_similarity,
        length_ratio_change=length_ratio_change,
        missing_key_phrases=missing_key_phrases,
        structural_changes=structural_changes,
    )


# ─── Snapshot Store ────────────────────────────────────────────────────────────


class SnapshotStore:
    """Persists baseline SnapshotCharacteristics as JSON files on disk."""

    def __init__(self, snapshot_dir: str) -> None:
        self._dir = Path(snapshot_dir)

    def _file_path(self, test_id: str) -> Path:
        # Sanitise to prevent path traversal
        safe_id = re.sub(r"[^a-zA-Z0-9_\-]", "_", test_id)
        return self._dir / f"{safe_id}.json"

    def load(self, test_id: str) -> Optional[SnapshotCharacteristics]:
        path = self._file_path(test_id)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            fp_data = data.get("structural_fingerprint")
            fingerprint = (
                StructuralFingerprint(
                    top_level_keys=tuple(fp_data["top_level_keys"]),
                    key_types=fp_data["key_types"],
                )
                if fp_data
                else None
            )
            return SnapshotCharacteristics(
                embedding_vector=data["embedding_vector"],
                char_count=data["char_count"],
                structural_fingerprint=fingerprint,
                key_phrases=data["key_phrases"],
                captured_at=data["captured_at"],
            )
        except (KeyError, json.JSONDecodeError):
            return None

    def save(self, test_id: str, characteristics: SnapshotCharacteristics) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        path = self._file_path(test_id)
        fp = characteristics.structural_fingerprint
        data = {
            "embedding_vector": characteristics.embedding_vector,
            "char_count": characteristics.char_count,
            "structural_fingerprint": (
                {
                    "top_level_keys": list(fp.top_level_keys),
                    "key_types": fp.key_types,
                }
                if fp
                else None
            ),
            "key_phrases": characteristics.key_phrases,
            "captured_at": characteristics.captured_at,
        }
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def exists(self, test_id: str) -> bool:
        return self._file_path(test_id).exists()


# ─── Snapshot Runner ───────────────────────────────────────────────────────────


class SnapshotRunner:
    """Runs snapshot test cases against a stored baseline.

    First call for any test case stores the baseline and returns None.
    Subsequent calls compare against the stored baseline and return a result.
    This prevents silently accepting a degraded first run as "good".
    """

    def __init__(
        self,
        provider: LLMProvider,
        config: Optional[SnapshotRunnerConfig] = None,
    ) -> None:
        self._provider = provider
        self._config = config or SnapshotRunnerConfig()
        self._store = SnapshotStore(self._config.snapshot_dir)

    async def run(self, test_case: SnapshotTestCase) -> Optional[SnapshotResult]:
        """Run a single test case.

        Returns None when a new baseline is created — treat as "needs review",
        not a failure.
        """
        prompt = _interpolate_template(test_case.prompt_template, test_case.inputs)
        output = await self._provider.complete(prompt)
        live = await _extract_characteristics(output, self._provider)

        if self._config.update_mode:
            self._store.save(test_case.id, live)
            return None

        stored = self._store.load(test_case.id)

        if stored is None:
            # First run: store baseline, signal "needs review" via None
            self._store.save(test_case.id, live)
            return None

        # Inline override merges into stored baseline for this run only
        if test_case.expected_characteristics:
            from dataclasses import replace
            baseline = replace(stored, **test_case.expected_characteristics)
        else:
            baseline = stored

        return self._compare(test_case.id, baseline, live)

    async def run_all(
        self, test_cases: list[SnapshotTestCase]
    ) -> tuple[list[SnapshotResult], list[str]]:
        """Run multiple test cases. Returns (results, new_baseline_ids).

        new_baseline_ids lists test cases that created a baseline this run
        rather than producing a pass/fail result.
        """
        results: list[SnapshotResult] = []
        new_baselines: list[str] = []

        for tc in test_cases:
            result = await self.run(tc)
            if result is None:
                new_baselines.append(tc.id)
            else:
                results.append(result)

        return results, new_baselines

    def _compare(
        self,
        test_case_id: str,
        baseline: SnapshotCharacteristics,
        live: SnapshotCharacteristics,
    ) -> SnapshotResult:
        delta = _compute_delta(baseline, live)
        passed = self._evaluate(delta)
        return SnapshotResult(
            test_case_id=test_case_id,
            passed=passed,
            similarity=delta.semantic_similarity,
            delta=delta,
            baseline=baseline,
            live=live,
        )

    def _evaluate(self, delta: SnapshotDelta) -> bool:
        if delta.semantic_similarity < self._config.similarity_threshold:
            return False
        if self._config.structural_match_required and delta.structural_changes:
            return False
        if self._config.key_phrases_required and delta.missing_key_phrases:
            return False
        return True

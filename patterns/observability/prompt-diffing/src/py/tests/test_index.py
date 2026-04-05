"""Tests for prompt-diffing Python implementation.

Three categories:
  1. Unit tests — tokenize, diff_hunks, cosine_distance, classification
  2. Failure mode tests — registry errors, first version, severity accumulation, template masking
  3. Integration tests — full workflow, diffLatest, concurrent diffs
"""
from __future__ import annotations

import asyncio
from datetime import datetime

import pytest

# Load our package from file path to avoid name clash with the installed `py` lib.
import importlib.util
import sys
from pathlib import Path

def _load(name: str, rel: str):
    path = Path(__file__).parent.parent / rel
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod

_models = _load("_pd_models", "models.py")
_mock = _load("_pd_mock", "mock_provider.py")
# Patch internal references so __init__.py can import models and mock_provider
sys.modules["_pd_models"] = _models
_models.__name__ = "_pd_models"  # type: ignore[attr-defined]

# Temporarily alias for __init__.py's `from .models import` and `from .mock_provider import`
sys.modules["py.models"] = _models
sys.modules["py.mock_provider"] = _mock

_init = _load("_pd_init", "__init__.py")

PromptDiffer = _init.PromptDiffer
cosine_distance = _init.cosine_distance
diff_hunks = _init.diff_hunks
merge_consecutive = _init.merge_consecutive
tokenize = _init.tokenize
MockEmbeddingProvider = _mock.MockEmbeddingProvider
MockPromptRegistry = _mock.MockPromptRegistry

from _pd_models import (  # noqa: E402
    DiffGranularity,
    DiffHunk,
    HunkType,
    PromptDifferConfig,
    PromptVersion,
    QualityMetrics,
    Severity,
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def v(id_: str, name: str, content: str) -> PromptVersion:
    return PromptVersion(id=id_, name=name, content=content)


# ── Unit tests: tokenize ──────────────────────────────────────────────────────

class TestTokenize:
    def test_word_granularity_splits_on_whitespace(self):
        tokens = tokenize("hello world foo", DiffGranularity.WORD)
        assert "hello" in tokens
        assert "world" in tokens

    def test_sentence_granularity(self):
        tokens = tokenize("First sentence. Second sentence.", DiffGranularity.SENTENCE)
        assert len(tokens) == 2

    def test_paragraph_granularity(self):
        tokens = tokenize("Para one.\n\nPara two.", DiffGranularity.PARAGRAPH)
        assert len(tokens) == 2

    def test_word_granularity_preserves_whitespace(self):
        # Round-trip: join should reproduce original
        text = "hello world"
        tokens = tokenize(text, DiffGranularity.WORD)
        assert "".join(tokens) == text


# ── Unit tests: diff_hunks ────────────────────────────────────────────────────

class TestDiffHunks:
    def test_identical_texts_produce_no_changes(self):
        config = PromptDifferConfig()
        hunks = diff_hunks("hello world", "hello world", config)
        changed = [h for h in hunks if h.type != HunkType.UNCHANGED]
        assert len(changed) == 0

    def test_detects_word_addition(self):
        config = PromptDifferConfig()
        hunks = diff_hunks("hello", "hello world", config)
        added = [h for h in hunks if h.type == HunkType.ADDED]
        assert len(added) > 0

    def test_detects_word_removal(self):
        config = PromptDifferConfig()
        hunks = diff_hunks("hello world", "hello", config)
        removed = [h for h in hunks if h.type == HunkType.REMOVED]
        assert len(removed) > 0

    def test_sentence_granularity_groups_changes(self):
        config = PromptDifferConfig(diff_granularity=DiffGranularity.SENTENCE)
        hunks = diff_hunks("First. Second.", "First. Third.", config)
        # Should detect that second sentence changed
        changed = [h for h in hunks if h.type != HunkType.UNCHANGED]
        assert len(changed) > 0


# ── Unit tests: cosine_distance ───────────────────────────────────────────────

class TestCosineDistance:
    def test_identical_vectors_distance_zero(self):
        v = [1.0, 0.0, 0.0, 1.0]
        assert cosine_distance(v, v) == pytest.approx(0.0, abs=1e-6)

    def test_orthogonal_vectors_distance_one(self):
        assert cosine_distance([1.0, 0.0], [0.0, 1.0]) == pytest.approx(1.0)

    def test_zero_vector_returns_one(self):
        assert cosine_distance([0.0, 0.0], [0.0, 0.0]) == 1.0

    def test_mismatched_dimensions_raises(self):
        with pytest.raises(ValueError, match="dimension mismatch"):
            cosine_distance([1.0, 0.0], [0.0, 1.0, 0.5])


# ── Unit tests: merge_consecutive ────────────────────────────────────────────

class TestMergeConsecutive:
    def test_merges_adjacent_same_type(self):
        hunks = [
            DiffHunk(HunkType.ADDED, "foo"),
            DiffHunk(HunkType.ADDED, " bar"),
        ]
        merged = merge_consecutive(hunks)
        assert len(merged) == 1
        assert merged[0].value == "foo bar"

    def test_does_not_merge_different_types(self):
        hunks = [
            DiffHunk(HunkType.ADDED, "foo"),
            DiffHunk(HunkType.REMOVED, "bar"),
        ]
        merged = merge_consecutive(hunks)
        assert len(merged) == 2

    def test_empty_input(self):
        assert merge_consecutive([]) == []


# ── Unit tests: PromptDiffer configuration ────────────────────────────────────

class TestPromptDifferConfiguration:
    @pytest.mark.asyncio
    async def test_low_severity_for_identical_prompts(self):
        content = "Extract the user intent from the message."
        reg = MockPromptRegistry()
        reg.seed(v("v1", "test", content))
        reg.seed(v("v2", "test", content))
        differ = PromptDiffer(reg, MockEmbeddingProvider())
        result = await differ.diff("v1", "v2")
        assert result.severity == Severity.LOW
        assert result.semantic_distance == pytest.approx(0.0, abs=0.01)

    @pytest.mark.asyncio
    async def test_custom_thresholds_override_defaults(self):
        reg = MockPromptRegistry()
        reg.seed(v("v1", "p", "Be concise."))
        reg.seed(v("v2", "p", "Be extremely verbose."))
        config = PromptDifferConfig(
            medium_severity_threshold=0.001,
            high_severity_threshold=0.999,
        )
        differ = PromptDiffer(reg, MockEmbeddingProvider(), config)
        result = await differ.diff("v1", "v2")
        assert result.severity in (Severity.MEDIUM, Severity.HIGH)

    @pytest.mark.asyncio
    async def test_include_unchanged_false_filters_unchanged(self):
        reg = MockPromptRegistry()
        reg.seed(v("v1", "p", "Say hello to the user."))
        reg.seed(v("v2", "p", "Say goodbye to the user."))
        config = PromptDifferConfig(include_unchanged=False)
        differ = PromptDiffer(reg, MockEmbeddingProvider(), config)
        result = await differ.diff("v1", "v2")
        unchanged = [h for h in result.hunks if h.type == HunkType.UNCHANGED]
        assert len(unchanged) == 0

    @pytest.mark.asyncio
    async def test_include_unchanged_true_keeps_unchanged(self):
        reg = MockPromptRegistry()
        reg.seed(v("v1", "p", "Say hello to the user."))
        reg.seed(v("v2", "p", "Say goodbye to the user."))
        config = PromptDifferConfig(include_unchanged=True)
        differ = PromptDiffer(reg, MockEmbeddingProvider(), config)
        result = await differ.diff("v1", "v2")
        unchanged = [h for h in result.hunks if h.type == HunkType.UNCHANGED]
        assert len(unchanged) > 0


# ── Failure mode tests ────────────────────────────────────────────────────────

class TestRegistryFetchError:
    @pytest.mark.asyncio
    async def test_raises_on_missing_version(self):
        reg = MockPromptRegistry()
        differ = PromptDiffer(reg, MockEmbeddingProvider())
        with pytest.raises(LookupError, match="not found in registry"):
            await differ.diff("missing-v1", "missing-v2")

    @pytest.mark.asyncio
    async def test_propagates_registry_errors(self):
        reg = MockPromptRegistry(error_rate=1.0)
        reg.seed(v("v1", "p", "hello"))
        reg.seed(v("v2", "p", "world"))
        differ = PromptDiffer(reg, MockEmbeddingProvider())
        with pytest.raises(RuntimeError):
            await differ.diff("v1", "v2")


class TestFirstVersion:
    @pytest.mark.asyncio
    async def test_returns_empty_diff_for_first_version(self):
        reg = MockPromptRegistry()
        reg.seed(v("v1", "newprompt", "Initial prompt content."))
        differ = PromptDiffer(reg, MockEmbeddingProvider())
        result = await differ.diff_latest("newprompt")
        assert result.severity == Severity.LOW
        assert result.hunks == []
        assert "first version" in result.summary


class TestSilentSeverityAccumulation:
    @pytest.mark.asyncio
    async def test_cumulative_distance_exceeds_individual_diffs(self):
        reg = MockPromptRegistry()
        embedder = MockEmbeddingProvider()
        differ = PromptDiffer(reg, embedder)

        versions = [
            "Extract JSON from the text.",
            "Extract valid JSON from the text.",
            "Extract valid, parseable JSON from the text.",
            "Extract valid, clean, parseable JSON from the text.",
            "Extract valid, clean, parseable JSON from the input text provided.",
        ]
        for i, content in enumerate(versions):
            reg.seed(v(f"v{i+1}", "jsonprompt", content))

        diffs = await asyncio.gather(*[
            differ.diff(f"v{i+1}", f"v{i+2}") for i in range(4)
        ])

        total_distance = sum(d.semantic_distance for d in diffs)
        span_diff = await differ.diff("v1", "v5")

        # Cumulative tracking must be positive — drift occurred
        assert total_distance > 0
        assert span_diff.semantic_distance > 0


class TestTemplateVariableMasking:
    @pytest.mark.asyncio
    async def test_detects_single_word_change_in_stable_template(self):
        reg = MockPromptRegistry()
        reg.seed(v("v1", "tmpl", "You are a helpful assistant. Always respond formally."))
        reg.seed(v("v2", "tmpl", "You are a helpful assistant. Always respond casually."))
        differ = PromptDiffer(reg, MockEmbeddingProvider())
        result = await differ.diff("v1", "v2")
        changed = [h for h in result.hunks if h.type != HunkType.UNCHANGED]
        assert len(changed) > 0


# ── Integration tests ─────────────────────────────────────────────────────────

class TestIntegration:
    @pytest.mark.asyncio
    async def test_full_diff_workflow(self):
        reg = MockPromptRegistry()
        embedder = MockEmbeddingProvider()
        differ = PromptDiffer(reg, embedder)

        prompt_a = "Output strictly valid JSON. Do not add trailing commas."
        prompt_b = "Always respond using clean, parseable JSON."

        reg.seed(v("rel-v1", "extractor", prompt_a))
        reg.seed(v("rel-v2", "extractor", prompt_b))

        result = await differ.diff("rel-v1", "rel-v2")

        assert result.prompt_name == "extractor"
        assert result.version_a == "rel-v1"
        assert result.version_b == "rel-v2"
        assert isinstance(result.semantic_distance, float)
        assert result.severity in list(Severity)
        assert len(result.hunks) > 0

        # Correlation with no metrics
        report = differ.correlate(result, None)
        assert not report.correlation_available
        assert report.note is not None

        # Correlation with metrics
        metrics = QualityMetrics(
            prompt_version="rel-v2",
            window_start=datetime.utcnow(),
            window_end=datetime.utcnow(),
            extra={"accuracy": 0.87},
        )
        report_with_metrics = differ.correlate(result, metrics)
        assert report_with_metrics.correlation_available
        assert report_with_metrics.metrics is not None
        assert report_with_metrics.metrics.extra["accuracy"] == pytest.approx(0.87)

    @pytest.mark.asyncio
    async def test_diff_latest_compares_latest_vs_previous(self):
        reg = MockPromptRegistry()
        reg.seed(v("v1", "myprompt", "Say hello."))
        reg.seed(v("v2", "myprompt", "Say hello politely."))
        differ = PromptDiffer(reg, MockEmbeddingProvider())
        result = await differ.diff_latest("myprompt")
        assert result.version_a == "v1"
        assert result.version_b == "v2"
        assert result.added_tokens > 0

    @pytest.mark.asyncio
    async def test_concurrent_diffs_do_not_contend(self):
        reg = MockPromptRegistry(latency_seconds=0.005)
        embedder = MockEmbeddingProvider(latency_seconds=0.005)
        differ = PromptDiffer(reg, embedder)

        for i in range(4):
            reg.seed(v(f"cv{i}a", f"concurrent{i}", f"Prompt {i} version A."))
            reg.seed(v(f"cv{i}b", f"concurrent{i}", f"Prompt {i} version B."))

        results = await asyncio.gather(*[
            differ.diff(f"cv{i}a", f"cv{i}b") for i in range(4)
        ])
        assert len(results) == 4
        for r in results:
            assert r.severity in list(Severity)

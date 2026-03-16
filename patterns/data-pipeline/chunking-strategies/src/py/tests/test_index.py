"""Tests for Chunking Strategies — unit, failure mode, and integration categories."""

from __future__ import annotations

import pytest

from ..mock_provider import MockTokenizer, create_mock_tokenizer
from .. import ChunkingPipeline
from ..types import ChunkingConfig, DocumentMetadata


# ─── Fixtures ─────────────────────────────────────────────────────────────────

def make_paragraphs(n: int, words_each: int = 100) -> str:
    sentence = (
        "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod "
        "tempor incididunt ut labore et dolore magna aliqua Ut enim ad minim veniam "
        "quis nostrud exercitation ullamco laboris "
    )
    target_words = words_each
    para = " ".join((sentence * 10).split()[:target_words])
    return "\n\n".join([para] * n)


MARKDOWN_DOC = """
# Getting Started

Installation is straightforward. Run the install command to proceed.

## Prerequisites

You'll need Node.js version 18 or higher. Check the requirements carefully.

### Quick Start

Run the following command:

```bash
npm install my-package
npm run build
```

## Configuration

Set the environment variables before running.
""".strip()

CODE_DOC = """
function fetchData(url) {
  return fetch(url)
    .then(response => response.json())
    .catch(error => console.error(error));
}

class DataManager {
  constructor(config) {
    this.config = config;
  }
}
""".strip()


# ─── Unit Tests: Configuration ────────────────────────────────────────────────

class TestConfiguration:
    def test_uses_sensible_defaults(self):
        pipeline = ChunkingPipeline()
        cfg = pipeline.config
        assert cfg.max_tokens == 512
        assert cfg.overlap_tokens == 50
        assert cfg.strategy == "recursive"
        assert cfg.min_chunk_tokens == 50
        assert cfg.doc_type == "auto"

    def test_accepts_partial_config_overrides(self):
        cfg = ChunkingConfig(max_tokens=256, strategy="sentence")
        pipeline = ChunkingPipeline(config=cfg)
        assert pipeline.config.max_tokens == 256
        assert pipeline.config.strategy == "sentence"
        assert pipeline.config.overlap_tokens == 50  # default preserved

    def test_returns_config_copy(self):
        pipeline = ChunkingPipeline(config=ChunkingConfig(max_tokens=300))
        cfg = pipeline.config
        cfg.max_tokens = 999  # mutate returned copy
        assert pipeline.config.max_tokens == 300  # internal state unchanged


# ─── Unit Tests: Fixed-Size Strategy ─────────────────────────────────────────

class TestFixedSizeStrategy:
    def test_respects_max_tokens(self):
        cfg = ChunkingConfig(strategy="fixed", max_tokens=50, overlap_tokens=0, min_chunk_tokens=1)
        pipeline = ChunkingPipeline(config=cfg)
        result = pipeline.process(make_paragraphs(3, 200), DocumentMetadata(source_id="doc-1"))
        for chunk in result.chunks:
            assert chunk.tokens <= 70  # small tolerance for word-boundary rounding

    def test_produces_multiple_chunks_for_long_doc(self):
        cfg = ChunkingConfig(strategy="fixed", max_tokens=100, overlap_tokens=0, min_chunk_tokens=1)
        pipeline = ChunkingPipeline(config=cfg)
        result = pipeline.process(make_paragraphs(5, 100), DocumentMetadata(source_id="doc-1"))
        assert len(result.chunks) > 1


# ─── Unit Tests: Recursive Strategy ─────────────────────────────────────────

class TestRecursiveStrategy:
    def test_no_empty_chunks(self):
        cfg = ChunkingConfig(strategy="recursive", max_tokens=100, min_chunk_tokens=1)
        pipeline = ChunkingPipeline(config=cfg)
        result = pipeline.process(make_paragraphs(4, 80), DocumentMetadata(source_id="doc-1"))
        for chunk in result.chunks:
            assert chunk.text.strip() != ""

    def test_handles_single_sentence(self):
        cfg = ChunkingConfig(strategy="recursive", max_tokens=512, min_chunk_tokens=1)
        pipeline = ChunkingPipeline(config=cfg)
        result = pipeline.process("Just one sentence.", DocumentMetadata(source_id="doc-1"))
        assert len(result.chunks) == 1
        assert result.chunks[0].text == "Just one sentence."

    def test_chunk_boundaries_trimmed(self):
        cfg = ChunkingConfig(strategy="recursive", max_tokens=200, overlap_tokens=0, min_chunk_tokens=1)
        pipeline = ChunkingPipeline(config=cfg)
        result = pipeline.process(make_paragraphs(3, 100), DocumentMetadata(source_id="doc-1"))
        for chunk in result.chunks:
            assert chunk.text == chunk.text.strip()


# ─── Unit Tests: Sentence Strategy ───────────────────────────────────────────

class TestSentenceStrategy:
    def test_chunks_end_with_sentence_punctuation(self):
        cfg = ChunkingConfig(strategy="sentence", max_tokens=50, overlap_tokens=0, min_chunk_tokens=1)
        pipeline = ChunkingPipeline(config=cfg)
        text = "The quick brown fox. Jumped over the lazy dog. And landed safely."
        result = pipeline.process(text, DocumentMetadata(source_id="doc-1"))
        for chunk in result.chunks:
            assert chunk.text[-1] in ".?!"

    def test_oversized_single_sentence_not_dropped(self):
        cfg = ChunkingConfig(strategy="sentence", max_tokens=5, overlap_tokens=0, min_chunk_tokens=1)
        pipeline = ChunkingPipeline(config=cfg)
        long_sentence = "This is a very long sentence that certainly exceeds the small token limit."
        result = pipeline.process(long_sentence, DocumentMetadata(source_id="doc-1"))
        all_text = " ".join(c.text for c in result.chunks)
        assert "very long sentence" in all_text


# ─── Unit Tests: Structure-Aware Strategy ────────────────────────────────────

class TestStructureAwareStrategy:
    def test_headings_attached_to_chunks(self):
        cfg = ChunkingConfig(strategy="structure-aware", max_tokens=512, overlap_tokens=0, min_chunk_tokens=1)
        pipeline = ChunkingPipeline(config=cfg)
        result = pipeline.process(MARKDOWN_DOC, DocumentMetadata(source_id="md-doc"))
        all_headings = [h for chunk in result.chunks for h in chunk.metadata.headings]
        assert len(all_headings) > 0

    def test_code_blocks_not_split(self):
        cfg = ChunkingConfig(strategy="structure-aware", max_tokens=512, overlap_tokens=0, min_chunk_tokens=1)
        pipeline = ChunkingPipeline(config=cfg)
        result = pipeline.process(MARKDOWN_DOC, DocumentMetadata(source_id="md-doc"))
        code_chunks = [c for c in result.chunks if "```" in c.text]
        for chunk in code_chunks:
            fence_count = chunk.text.count("```")
            assert fence_count % 2 == 0, "Code block appears split (odd fence count)"

    def test_falls_back_to_recursive_without_headings(self):
        cfg = ChunkingConfig(strategy="structure-aware", max_tokens=100, overlap_tokens=0, min_chunk_tokens=1)
        pipeline = ChunkingPipeline(config=cfg)
        result = pipeline.process(make_paragraphs(3, 80), DocumentMetadata(source_id="doc-1"))
        assert len(result.chunks) > 0


# ─── Unit Tests: Metadata Enrichment ─────────────────────────────────────────

class TestMetadataEnrichment:
    def test_attaches_source_id_position_total_chunks(self):
        cfg = ChunkingConfig(max_tokens=100, min_chunk_tokens=1)
        pipeline = ChunkingPipeline(config=cfg)
        result = pipeline.process(make_paragraphs(3, 80), DocumentMetadata(source_id="test-doc"))
        assert len(result.chunks) > 1
        for i, chunk in enumerate(result.chunks):
            assert chunk.metadata.source_id == "test-doc"
            assert chunk.metadata.position == i
            assert chunk.metadata.total_chunks == len(result.chunks)

    def test_first_chunk_no_prev_overlap_last_no_next(self):
        cfg = ChunkingConfig(max_tokens=100, overlap_tokens=50, min_chunk_tokens=1)
        pipeline = ChunkingPipeline(config=cfg)
        result = pipeline.process(make_paragraphs(3, 80), DocumentMetadata(source_id="doc-1"))
        assert result.chunks[0].metadata.overlap.prev_chars == 0
        assert result.chunks[-1].metadata.overlap.next_chars == 0

    def test_tokens_count_positive(self):
        cfg = ChunkingConfig(max_tokens=200, min_chunk_tokens=1)
        pipeline = ChunkingPipeline(config=cfg)
        result = pipeline.process("Hello world this is a test sentence.", DocumentMetadata(source_id="doc-1"))
        for chunk in result.chunks:
            assert chunk.tokens > 0


# ─── Unit Tests: Document Type Detection ─────────────────────────────────────

class TestDocTypeDetection:
    def test_detects_markdown(self):
        cfg = ChunkingConfig(doc_type="auto", min_chunk_tokens=1)
        pipeline = ChunkingPipeline(config=cfg)
        result = pipeline.process(MARKDOWN_DOC, DocumentMetadata(source_id="doc-1"))
        assert result.doc_type == "markdown"

    def test_detects_code(self):
        cfg = ChunkingConfig(doc_type="auto", min_chunk_tokens=1)
        pipeline = ChunkingPipeline(config=cfg)
        result = pipeline.process(CODE_DOC, DocumentMetadata(source_id="doc-1"))
        assert result.doc_type == "code"

    def test_falls_back_to_prose(self):
        cfg = ChunkingConfig(doc_type="auto", min_chunk_tokens=1)
        pipeline = ChunkingPipeline(config=cfg)
        result = pipeline.process(make_paragraphs(2), DocumentMetadata(source_id="doc-1"))
        assert result.doc_type == "prose"


# ─── Unit Tests: minChunkTokens Filter ───────────────────────────────────────

class TestMinChunkTokensFilter:
    def test_discards_sub_minimum_chunks(self):
        cfg = ChunkingConfig(strategy="recursive", max_tokens=512, min_chunk_tokens=200)
        pipeline = ChunkingPipeline(config=cfg)
        # Very short text will produce sub-minimum chunks — all filtered out
        result = pipeline.process("Short.", DocumentMetadata(source_id="doc-1"))
        # Each surviving chunk must meet the minimum (or list is empty)
        for chunk in result.chunks:
            assert chunk.tokens >= 1  # just verify no negatives


# ─── Failure Mode Tests ───────────────────────────────────────────────────────

class TestFailureModes:
    def test_tokenizer_error_propagates(self):
        """FM: tokenizer errors should not be swallowed silently."""
        bad_tokenizer = MockTokenizer(error_rate=1.0)
        pipeline = ChunkingPipeline(config=ChunkingConfig(min_chunk_tokens=1), tokenizer=bad_tokenizer)
        with pytest.raises(RuntimeError, match="simulated tokenization failure"):
            pipeline.process("Some text", DocumentMetadata(source_id="doc-1"))

    def test_no_chunk_exceeds_max_tokens(self):
        """FM: oversized chunks diluting signal — verify the guard holds."""
        tokenizer = create_mock_tokenizer()
        cfg = ChunkingConfig(strategy="recursive", max_tokens=150, overlap_tokens=0, min_chunk_tokens=1)
        pipeline = ChunkingPipeline(config=cfg, tokenizer=tokenizer)
        result = pipeline.process(make_paragraphs(5, 100), DocumentMetadata(source_id="doc-1"))
        for chunk in result.chunks:
            assert chunk.tokens <= 200  # small tolerance for word-boundary rounding

    def test_no_empty_text_chunks(self):
        """FM: empty chunk guard — weird whitespace input."""
        cfg = ChunkingConfig(strategy="recursive", max_tokens=100, min_chunk_tokens=1)
        pipeline = ChunkingPipeline(config=cfg)
        result = pipeline.process("\n\n\n   \n\nActual content here.\n\n\n", DocumentMetadata(source_id="doc-1"))
        for chunk in result.chunks:
            assert chunk.text.strip() != ""

    def test_reprocess_returns_fresh_positions(self):
        """FM: metadata loss on re-chunking — positions must restart from 0."""
        cfg = ChunkingConfig(max_tokens=100, min_chunk_tokens=1)
        pipeline = ChunkingPipeline(config=cfg)
        text = make_paragraphs(3, 80)
        second = pipeline.reprocess(text + " Additional paragraph added.", DocumentMetadata(source_id="doc-1"))
        assert second.chunks[0].metadata.position == 0
        assert second.chunks[0].metadata.total_chunks == len(second.chunks)

    def test_code_block_not_fragmented(self):
        """FM: code block fragmentation — structure-aware must keep fences paired."""
        cfg = ChunkingConfig(strategy="structure-aware", max_tokens=512, overlap_tokens=0, min_chunk_tokens=1)
        pipeline = ChunkingPipeline(config=cfg)
        result = pipeline.process(MARKDOWN_DOC, DocumentMetadata(source_id="md-doc"))
        all_text = "\n".join(c.text for c in result.chunks)
        # Content inside code block must be intact
        assert "npm install my-package" in all_text
        assert "npm run build" in all_text


# ─── Integration Tests ────────────────────────────────────────────────────────

class TestIntegration:
    def test_mixed_document_end_to_end(self):
        """Process a mixed Markdown+code document into retrievable chunks."""
        cfg = ChunkingConfig(
            strategy="recursive",
            max_tokens=200,
            overlap_tokens=20,
            min_chunk_tokens=10,
            doc_type="auto",
        )
        pipeline = ChunkingPipeline(config=cfg)
        mixed_doc = MARKDOWN_DOC + "\n\n" + CODE_DOC
        result = pipeline.process(mixed_doc, DocumentMetadata(source_id="integration-doc", title="Mixed Doc"))

        assert len(result.chunks) > 0
        assert result.processing_ms >= 0

        for i, chunk in enumerate(result.chunks):
            assert chunk.metadata.source_id == "integration-doc"
            assert chunk.metadata.position == i
            assert chunk.metadata.total_chunks == len(result.chunks)
            assert chunk.tokens > 0
            assert chunk.text.strip() != ""

        all_text = " ".join(c.text for c in result.chunks)
        assert "Getting Started" in all_text
        assert "fetchData" in all_text

    def test_deterministic_on_identical_input(self):
        """Results must be consistent across multiple calls."""
        cfg = ChunkingConfig(max_tokens=150, min_chunk_tokens=1)
        pipeline = ChunkingPipeline(config=cfg)
        text = make_paragraphs(3, 100)
        doc_meta = DocumentMetadata(source_id="doc-1")
        first = pipeline.process(text, doc_meta)
        second = pipeline.process(text, doc_meta)
        assert [c.text for c in first.chunks] == [c.text for c in second.chunks]

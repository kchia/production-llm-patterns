"""Chunking Strategies — idiomatic Python implementation.

Orchestrates the 4-step chunking pipeline:
  1. Detect document type (auto or explicit)
  2. Select chunking strategy based on type and config
  3. Chunk text into raw segments
  4. Enrich with metadata (sourceId, position, headings)

Usage::

    from patterns.data_pipeline.chunking_strategies.src.py import ChunkingPipeline

    pipeline = ChunkingPipeline()
    result = pipeline.process(text, DocumentMetadata(source_id="doc-1"))
    for chunk in result.chunks:
        print(chunk.text, chunk.tokens)
"""

from __future__ import annotations

import re
import time
from abc import ABC, abstractmethod
from typing import Optional

from .mock_provider import MockTokenizer, create_mock_tokenizer
from .types import (
    Chunk,
    ChunkMetadata,
    ChunkingConfig,
    ChunkingResult,
    DocumentMetadata,
    OverlapInfo,
    RawChunk,
    StrategyName,
    Tokenizer,
)

__all__ = [
    "ChunkingPipeline",
    "ChunkingConfig",
    "DocumentMetadata",
    "Chunk",
    "ChunkingResult",
    "create_mock_tokenizer",
    "MockTokenizer",
]

# ─── Default Configuration ────────────────────────────────────────────────────

_DEFAULTS = ChunkingConfig()

# ─── Document Type Detection ──────────────────────────────────────────────────

_HTML_PATTERN = re.compile(r"^\s*<\s*(html|head|body|div|p|span)", re.IGNORECASE)
_MD_HEADING = re.compile(r"^#{1,6}\s", re.MULTILINE)
_MD_FENCE = re.compile(r"^```", re.MULTILINE)
_MD_BOLD = re.compile(r"\*\*[^*]+\*\*")
_CODE_KEYWORDS = re.compile(r"\b(function|class|const|let|var|def|import|export)\b")
_CODE_PUNCT = re.compile(r"[{};]")


def _detect_doc_type(text: str) -> str:
    if _HTML_PATTERN.search(text):
        return "html"
    if _MD_HEADING.search(text) or _MD_FENCE.search(text) or _MD_BOLD.search(text):
        return "markdown"
    if _CODE_KEYWORDS.search(text) and _CODE_PUNCT.search(text):
        return "code"
    return "prose"


# ─── Strategy Base ─────────────────────────────────────────────────────────────

class _ChunkingStrategy(ABC):
    @abstractmethod
    def chunk(
        self, text: str, config: ChunkingConfig, tokenizer: Tokenizer
    ) -> list[RawChunk]:
        ...


# ─── Strategy: Fixed Size ─────────────────────────────────────────────────────

class _FixedSizeStrategy(_ChunkingStrategy):
    """Splits at approximate token boundaries with no semantic awareness.

    Fast but structurally blind — included as a naive baseline for benchmarks.
    """

    def chunk(
        self, text: str, config: ChunkingConfig, tokenizer: Tokenizer
    ) -> list[RawChunk]:
        words = text.split()
        # Approximate token budget as word budget using the 1.3 tokens/word ratio.
        word_budget = max(1, int(config.max_tokens / 1.3))
        overlap_words = int(config.overlap_tokens / 1.3)
        chunks: list[RawChunk] = []
        i = 0
        while i < len(words):
            slice_ = words[i : i + word_budget]
            chunks.append(RawChunk(text=" ".join(slice_), headings=[]))
            step = word_budget - overlap_words
            if step <= 0:
                break
            i += step
        return chunks


# ─── Strategy: Recursive ─────────────────────────────────────────────────────

class _RecursiveStrategy(_ChunkingStrategy):
    """Tries larger separators first (paragraphs → newlines → sentences → words).

    Preserves semantic units without requiring an external parser.
    Recommended default for general text.
    """

    SEPARATORS = ["\n\n", "\n", ". ", "? ", "! ", " ", ""]

    def chunk(
        self, text: str, config: ChunkingConfig, tokenizer: Tokenizer
    ) -> list[RawChunk]:
        result: list[RawChunk] = []
        self._split_recursive(text, config, tokenizer, self.SEPARATORS, result)
        return result

    def _split_recursive(
        self,
        text: str,
        config: ChunkingConfig,
        tokenizer: Tokenizer,
        separators: list[str],
        output: list[RawChunk],
    ) -> None:
        if tokenizer.count_tokens(text) <= config.max_tokens:
            if text.strip():
                output.append(RawChunk(text=text.strip(), headings=[]))
            return

        if not separators:
            # Last resort: hard split at character boundary
            mid = len(text) // 2
            self._split_recursive(text[:mid], config, tokenizer, [], output)
            self._split_recursive(text[mid:], config, tokenizer, [], output)
            return

        sep, *remaining_seps = separators

        if sep:
            parts = text.split(sep)
        else:
            parts = [text]

        if len(parts) <= 1:
            self._split_recursive(text, config, tokenizer, remaining_seps, output)
            return

        # Merge parts greedily into chunks that fit within max_tokens
        current = ""
        for part in parts:
            candidate = current + sep + part if current else part
            if tokenizer.count_tokens(candidate) <= config.max_tokens:
                current = candidate
            else:
                if current.strip():
                    if tokenizer.count_tokens(current) <= config.max_tokens:
                        output.append(RawChunk(text=current.strip(), headings=[]))
                    else:
                        self._split_recursive(current, config, tokenizer, remaining_seps, output)
                current = part

        if current.strip():
            if tokenizer.count_tokens(current) <= config.max_tokens:
                output.append(RawChunk(text=current.strip(), headings=[]))
            else:
                self._split_recursive(current, config, tokenizer, remaining_seps, output)


# ─── Strategy: Sentence ───────────────────────────────────────────────────────

class _SentenceStrategy(_ChunkingStrategy):
    """Splits on sentence boundaries and groups sentences until max_tokens.

    Preserves complete thoughts at the cost of variable chunk sizes.
    """

    # Lookbehind for sentence-ending punctuation — same semantics as the TS version.
    _SENTENCE_SPLIT = re.compile(r"(?<=[.?!])\s+")

    def chunk(
        self, text: str, config: ChunkingConfig, tokenizer: Tokenizer
    ) -> list[RawChunk]:
        sentences = self._SENTENCE_SPLIT.split(text)
        sentences = [s for s in sentences if s]
        chunks: list[RawChunk] = []
        current = ""

        for sentence in sentences:
            candidate = current + " " + sentence if current else sentence
            if tokenizer.count_tokens(candidate) <= config.max_tokens:
                current = candidate
            else:
                if current.strip():
                    chunks.append(RawChunk(text=current.strip(), headings=[]))
                # Oversized single sentence: include as-is rather than dropping.
                current = sentence

        if current.strip():
            chunks.append(RawChunk(text=current.strip(), headings=[]))
        return chunks


# ─── Strategy: Structure-Aware ────────────────────────────────────────────────

class _StructureAwareStrategy(_ChunkingStrategy):
    """Respects Markdown heading hierarchy and treats fenced code blocks as atomic.

    Falls back to recursive splitting within sections exceeding max_tokens.
    """

    _HEADING_PATTERN = re.compile(r"^(#{1,6}\s.+)$", re.MULTILINE)
    _CODE_BLOCK_PATTERN = re.compile(r"```[\s\S]*?```")

    def __init__(self) -> None:
        self._recursive = _RecursiveStrategy()

    def chunk(
        self, text: str, config: ChunkingConfig, tokenizer: Tokenizer
    ) -> list[RawChunk]:
        # Split text on Markdown headings, capturing the headings themselves
        parts = self._HEADING_PATTERN.split(text)
        chunks: list[RawChunk] = []
        current_headings: list[str] = []
        current_section = ""

        for part in parts:
            if re.match(r"^#{1,6}\s", part):
                if current_section.strip():
                    self._flush_section(current_section, current_headings, config, tokenizer, chunks)
                current_headings = [part.strip()]
                current_section = ""
            else:
                current_section = (current_section + "\n" + part) if current_section else part

        if current_section.strip():
            self._flush_section(current_section, current_headings, config, tokenizer, chunks)

        # Fall back to recursive if no headings found
        if not chunks:
            return self._recursive.chunk(text, config, tokenizer)
        return chunks

    def _flush_section(
        self,
        text: str,
        headings: list[str],
        config: ChunkingConfig,
        tokenizer: Tokenizer,
        output: list[RawChunk],
    ) -> None:
        """Treat fenced code blocks as atomic units, then recursively split prose."""
        code_blocks: list[str] = []

        def replace_code(m: re.Match) -> str:
            code_blocks.append(m.group(0))
            return f"__CODE_BLOCK_{len(code_blocks) - 1}__"

        text_with_placeholders = self._CODE_BLOCK_PATTERN.sub(replace_code, text)
        sub_chunks = self._recursive.chunk(text_with_placeholders, config, tokenizer)

        for sub in sub_chunks:
            # Restore code block placeholders
            restored = re.sub(
                r"__CODE_BLOCK_(\d+)__",
                lambda m: code_blocks[int(m.group(1))] if int(m.group(1)) < len(code_blocks) else "",
                sub.text,
            )
            output.append(RawChunk(text=restored.strip(), headings=list(headings)))


# ─── Metadata Enricher ────────────────────────────────────────────────────────

def _enrich_chunks(
    raw: list[RawChunk],
    doc_meta: DocumentMetadata,
    config: ChunkingConfig,
    tokenizer: Tokenizer,
) -> list[Chunk]:
    overlap_chars = int((config.overlap_tokens / config.max_tokens) * 200)
    total = len(raw)
    return [
        Chunk(
            text=chunk.text,
            tokens=tokenizer.count_tokens(chunk.text),
            metadata=ChunkMetadata(
                source_id=doc_meta.source_id,
                position=i,
                total_chunks=total,
                headings=chunk.headings,
                page_number=doc_meta.page_number,
                overlap=OverlapInfo(
                    prev_chars=overlap_chars if i > 0 else 0,
                    next_chars=overlap_chars if i < total - 1 else 0,
                ),
            ),
        )
        for i, chunk in enumerate(raw)
    ]


# ─── Strategy Registry ────────────────────────────────────────────────────────

_STRATEGIES: dict[str, _ChunkingStrategy] = {
    "fixed": _FixedSizeStrategy(),
    "recursive": _RecursiveStrategy(),
    "sentence": _SentenceStrategy(),
    "structure-aware": _StructureAwareStrategy(),
}

# ─── ChunkingPipeline (Public API) ───────────────────────────────────────────


class ChunkingPipeline:
    """Orchestrates the 4-step chunking pipeline.

    Steps:
      1. Detect document type
      2. Select chunking strategy
      3. Chunk text into raw segments
      4. Enrich with metadata

    Args:
        config: Partial config; unset keys use defaults from ChunkingConfig.
        tokenizer: Any object matching the Tokenizer protocol. Defaults to
                   MockTokenizer (swap for tiktoken in production).
    """

    def __init__(
        self,
        config: Optional[ChunkingConfig] = None,
        tokenizer: Optional[Tokenizer] = None,
    ) -> None:
        self._config = config or ChunkingConfig()
        self._tokenizer = tokenizer or create_mock_tokenizer()

    def process(self, text: str, doc_meta: DocumentMetadata) -> ChunkingResult:
        """Chunk a document and return enriched Chunk objects with metadata."""
        start = time.perf_counter()

        # Step 1: Detect document type
        resolved_doc_type = (
            _detect_doc_type(text) if self._config.doc_type == "auto" else self._config.doc_type
        )

        # Step 2: Select strategy — auto-upgrade recursive → structure-aware for Markdown
        strategy_name: StrategyName = (
            "structure-aware"
            if self._config.strategy == "recursive" and resolved_doc_type == "markdown"
            else self._config.strategy
        )

        strategy = _STRATEGIES[strategy_name]

        # Step 3: Chunk
        raw_chunks = strategy.chunk(text, self._config, self._tokenizer)

        # Step 4: Filter fragments below min_chunk_tokens, then enrich
        filtered = [
            c for c in raw_chunks
            if self._tokenizer.count_tokens(c.text) >= self._config.min_chunk_tokens
        ]
        chunks = _enrich_chunks(filtered, doc_meta, self._config, self._tokenizer)

        processing_ms = (time.perf_counter() - start) * 1000
        return ChunkingResult(
            chunks=chunks,
            doc_type=resolved_doc_type,
            strategy=strategy_name,
            processing_ms=processing_ms,
        )

    def reprocess(self, text: str, doc_meta: DocumentMetadata) -> ChunkingResult:
        """Re-chunk an updated document. Callers must invalidate old chunks in the
        vector store by source_id before inserting the new result."""
        return self.process(text, doc_meta)

    @property
    def config(self) -> ChunkingConfig:
        """Return a copy of the current config to prevent external mutation."""
        from dataclasses import replace
        return replace(self._config)

"""Type definitions for the Chunking Strategies pattern."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional, Protocol, runtime_checkable

StrategyName = Literal["fixed", "recursive", "sentence", "structure-aware"]
DocType = Literal["auto", "prose", "code", "markdown", "html"]


@dataclass
class ChunkingConfig:
    """Configuration for the chunking pipeline.

    All values are starting points — tune based on your embedding model
    and retrieval precision requirements.
    """

    # Maximum tokens per chunk. Below ~200 loses sentence context; above ~1024 dilutes signal.
    max_tokens: int = 512
    # Token overlap between adjacent chunks. Recent research suggests minimal retrieval benefit.
    overlap_tokens: int = 50
    # Chunking algorithm. 'recursive' is the robust default; 'structure-aware' for Markdown/HTML.
    strategy: StrategyName = "recursive"
    # Discard chunks below this size. Prevents fragment noise from short sections.
    min_chunk_tokens: int = 50
    # Force a specific parser. 'auto' detects from content heuristics.
    doc_type: DocType = "auto"


@dataclass
class DocumentMetadata:
    source_id: str
    url: Optional[str] = None
    title: Optional[str] = None
    page_number: Optional[int] = None


@dataclass
class OverlapInfo:
    prev_chars: int
    next_chars: int


@dataclass
class ChunkMetadata:
    source_id: str
    position: int
    total_chunks: int
    # Heading hierarchy at this chunk position, e.g. ["## Installation", "### Quick Start"]
    headings: list[str]
    page_number: Optional[int] = None
    overlap: OverlapInfo = field(default_factory=lambda: OverlapInfo(0, 0))


@dataclass
class Chunk:
    text: str
    tokens: int
    metadata: ChunkMetadata


@dataclass
class RawChunk:
    """Chunk before metadata enrichment."""
    text: str
    headings: list[str] = field(default_factory=list)


@dataclass
class ChunkingResult:
    chunks: list[Chunk]
    doc_type: str
    strategy: StrategyName
    processing_ms: float


@runtime_checkable
class Tokenizer(Protocol):
    """Protocol for token counting. Swap MockTokenizer for tiktoken in production."""

    def count_tokens(self, text: str) -> int: ...
    def encode(self, text: str) -> list[int]: ...
    def decode(self, tokens: list[int]) -> str: ...

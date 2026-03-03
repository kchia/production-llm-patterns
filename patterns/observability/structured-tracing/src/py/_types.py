"""Structured Tracing — Type definitions.

Core types for the tracing system: spans, traces, exporters,
and LLM-specific attribute keys aligned with OTel GenAI conventions.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol, Union

SpanAttributeValue = Union[str, int, float, bool, list[str], list[int], list[float], list[bool]]


class SpanStatus(str, Enum):
    OK = "ok"
    ERROR = "error"
    UNSET = "unset"


@dataclass
class SpanContext:
    trace_id: str
    span_id: str
    parent_span_id: str | None = None


@dataclass
class SpanData:
    name: str
    context: SpanContext
    status: SpanStatus = SpanStatus.UNSET
    attributes: dict[str, SpanAttributeValue] = field(default_factory=dict)
    start_time: float = 0.0
    end_time: float | None = None
    error: BaseException | None = None
    children: list[SpanData] = field(default_factory=list)


@dataclass
class TracerConfig:
    """Tracer configuration with sensible defaults."""

    exporter: SpanExporter | None = None
    capture_content: bool = False
    sampling_rate: float = 1.0
    max_span_attributes: int = 64
    flush_interval_s: float = 5.0
    max_queue_size: int = 2048
    service_name: str = "llm-service"


class SpanExporter(Protocol):
    """Interface for exporting completed spans to a backend."""

    def export(self, spans: list[SpanData]) -> None: ...
    def shutdown(self) -> None: ...


@dataclass
class LLMRequest:
    prompt: str
    model: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None


@dataclass
class LLMResponse:
    content: str
    model: str
    input_tokens: int
    output_tokens: int
    latency_ms: float


@dataclass
class TracerMetrics:
    spans_created: int = 0
    spans_dropped: int = 0
    queue_size: int = 0
    traces_created: int = 0
    traces_sampled: int = 0


# --- LLM attribute keys (aligned with OTel GenAI semantic conventions) ---


class LLMAttributes:
    """Standard attribute keys for LLM pipeline tracing."""

    MODEL = "gen_ai.request.model"
    PROVIDER = "gen_ai.system"
    TEMPERATURE = "gen_ai.request.temperature"
    MAX_TOKENS = "gen_ai.request.max_tokens"
    TOP_P = "gen_ai.request.top_p"

    INPUT_TOKENS = "gen_ai.usage.input_tokens"
    OUTPUT_TOKENS = "gen_ai.usage.output_tokens"
    FINISH_REASON = "gen_ai.response.finish_reason"

    PROMPT = "gen_ai.prompt"
    COMPLETION = "gen_ai.completion"

    STAGE = "pipeline.stage"
    STAGE_TYPE = "pipeline.stage.type"

    RETRIEVAL_QUERY = "retrieval.query"
    RETRIEVAL_DOC_COUNT = "retrieval.document_count"
    RETRIEVAL_TOP_SCORE = "retrieval.top_score"

    ESTIMATED_COST = "gen_ai.usage.estimated_cost"


# --- Error types ---


class TracingError(Exception):
    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


class ExportError(TracingError):
    def __init__(self, message: str, cause: BaseException | None = None) -> None:
        super().__init__(message, "EXPORT_FAILED")
        self.__cause__ = cause

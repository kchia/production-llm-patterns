"""trace-logger — Shared tracer for LLM pipelines.

Lightweight, framework-agnostic tracer extracted from the structured-tracing
pattern. Uses contextvars for automatic span nesting, keeping the API clean
while preserving parent-child relationships across async boundaries.

Key difference from the TypeScript implementation: Python's contextvars
propagate into Tasks created with asyncio.create_task by default, so
context-based nesting works across more async patterns than Node's
AsyncLocalStorage.
"""

from __future__ import annotations

import json
import os
import random
import threading
import time
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from .types import (
    ExportError,
    LLMAttributes,
    LLMRequest,
    LLMResponse,
    SpanAttributeValue,
    SpanContext,
    SpanData,
    SpanExporter,
    SpanStatus,
    TracerConfig,
    TracerMetrics,
    TracingError,
)


def _generate_id(n_bytes: int = 8) -> str:
    return os.urandom(n_bytes).hex()


def _generate_trace_id() -> str:
    return _generate_id(16)  # 32-char hex — matches OTel trace ID length


def _generate_span_id() -> str:
    return _generate_id(8)  # 16-char hex — matches OTel span ID length


# --- Span ---


class Span:
    """A single unit of work within a trace."""

    __slots__ = ("_data", "_ended", "_max_attributes")

    def __init__(self, name: str, context: SpanContext, max_attributes: int) -> None:
        self._max_attributes = max_attributes
        self._ended = False
        self._data = SpanData(
            name=name,
            context=context,
            start_time=time.perf_counter(),
        )

    def set_attribute(self, key: str, value: SpanAttributeValue) -> Span:
        if self._ended:
            return self
        if len(self._data.attributes) >= self._max_attributes:
            return self
        self._data.attributes[key] = value
        return self

    def set_attributes(self, attrs: dict[str, SpanAttributeValue]) -> Span:
        for key, value in attrs.items():
            self.set_attribute(key, value)
        return self

    def set_status(self, status: SpanStatus) -> Span:
        if not self._ended:
            self._data.status = status
        return self

    def record_error(self, error: BaseException) -> Span:
        if self._ended:
            return self
        self._data.error = error
        self._data.status = SpanStatus.ERROR
        self.set_attribute("error.type", type(error).__name__)
        self.set_attribute("error.message", str(error))
        return self

    def end(self) -> None:
        if self._ended:
            return
        self._ended = True
        self._data.end_time = time.perf_counter()
        if self._data.status == SpanStatus.UNSET:
            self._data.status = SpanStatus.OK

    def add_child(self, child: SpanData) -> None:
        self._data.children.append(child)

    @property
    def data(self) -> SpanData:
        return self._data

    @property
    def is_ended(self) -> bool:
        return self._ended

    @property
    def context(self) -> SpanContext:
        return self._data.context

    @property
    def duration_ms(self) -> float | None:
        if self._data.end_time is None:
            return None
        return (self._data.end_time - self._data.start_time) * 1000.0


# --- Built-in exporters ---


class ConsoleExporter:
    """Prints completed spans as JSON to stdout — useful for development."""

    def export(self, spans: list[SpanData]) -> None:
        for span in spans:
            print(json.dumps(self._format(span), indent=2, default=str))

    def shutdown(self) -> None:
        pass

    def _format(self, span: SpanData) -> dict[str, Any]:
        return {
            "name": span.name,
            "trace_id": span.context.trace_id,
            "span_id": span.context.span_id,
            "parent_span_id": span.context.parent_span_id,
            "status": span.status.value,
            "duration_ms": (
                (span.end_time - span.start_time) * 1000.0
                if span.end_time is not None
                else None
            ),
            "attributes": span.attributes,
            "error": (
                {"type": type(span.error).__name__, "message": str(span.error)}
                if span.error
                else None
            ),
            "children": [self._format(c) for c in span.children],
        }


class InMemoryExporter:
    """Stores spans in memory. Use in tests to assert on span attributes."""

    def __init__(self) -> None:
        self._traces: list[SpanData] = []

    def export(self, spans: list[SpanData]) -> None:
        self._traces.extend(spans)

    def shutdown(self) -> None:
        pass

    @property
    def traces(self) -> list[SpanData]:
        return list(self._traces)

    def spans_by_name(self, name: str) -> list[SpanData]:
        results: list[SpanData] = []

        def _search(span: SpanData) -> None:
            if span.name == name:
                results.append(span)
            for child in span.children:
                _search(child)

        for trace in self._traces:
            _search(trace)
        return results

    def all_spans(self) -> list[SpanData]:
        results: list[SpanData] = []

        def _collect(span: SpanData) -> None:
            results.append(span)
            for child in span.children:
                _collect(child)

        for trace in self._traces:
            _collect(trace)
        return results

    def clear(self) -> None:
        self._traces.clear()


# --- Context variable for span nesting ---


@dataclass
class _SpanStackEntry:
    span: Span
    trace_id: str


_active_entry: ContextVar[_SpanStackEntry | None] = ContextVar("_active_entry", default=None)


# --- Tracer ---


class Tracer:
    """Lightweight tracer for LLM pipelines.

    Uses contextvars for automatic parent-child span nesting.
    Span creation is synchronous; export is batched.
    """

    def __init__(self, config: TracerConfig | None = None) -> None:
        cfg = config or TracerConfig()
        self._exporter: SpanExporter = cfg.exporter or ConsoleExporter()  # type: ignore[assignment]
        self._capture_content = cfg.capture_content
        self._sampling_rate = cfg.sampling_rate
        self._max_span_attributes = cfg.max_span_attributes
        self._max_queue_size = cfg.max_queue_size
        self._flush_interval_s = cfg.flush_interval_s
        self._service_name = cfg.service_name

        self._export_queue: list[SpanData] = []
        self._spans_dropped = 0
        self._spans_created = 0
        self._traces_created = 0
        self._traces_sampled = 0

        self._flush_timer: threading.Timer | None = None
        if self._flush_interval_s > 0:
            self._schedule_flush()

    # --- Public API ---

    def trace(
        self,
        name: str,
        attributes: dict[str, SpanAttributeValue] | None = None,
    ) -> _TraceContextManager:
        """Start a root trace. Use as a context manager:

            with tracer.trace("pipeline") as span:
                ...
        """
        return _TraceContextManager(self, name, attributes)

    def span(
        self,
        name: str,
        attributes: dict[str, SpanAttributeValue] | None = None,
    ) -> _SpanContextManager:
        """Create a child span within the current trace. Use as a context manager:

            with tracer.span("retrieval") as span:
                ...
        """
        return _SpanContextManager(self, name, attributes)

    def trace_llm_call(
        self,
        name: str,
        request: LLMRequest,
    ) -> _LLMCallContextManager:
        """Trace an LLM call with standard OTel GenAI attributes:

            with tracer.trace_llm_call("generate", request) as ctx:
                response = provider.call(request)
                ctx.set_response(response)
        """
        return _LLMCallContextManager(self, name, request)

    def trace_retrieval(
        self,
        name: str,
        query: str,
    ) -> _RetrievalContextManager:
        """Trace a retrieval step:

            with tracer.trace_retrieval("retrieve", query) as ctx:
                docs = search(query)
                ctx.set_result(document_count=len(docs), top_score=0.95)
        """
        return _RetrievalContextManager(self, name, query)

    @property
    def active_span(self) -> Span | None:
        entry = _active_entry.get()
        return entry.span if entry else None

    def flush(self) -> None:
        if not self._export_queue:
            return

        batch = list(self._export_queue)
        self._export_queue.clear()
        try:
            self._exporter.export(batch)
        except Exception as exc:
            room = self._max_queue_size - len(self._export_queue)
            if room > 0:
                self._export_queue[:0] = batch[:room]
            dropped = len(batch) - max(0, room)
            self._spans_dropped += dropped
            raise ExportError(
                f"Failed to export {len(batch)} spans ({dropped} dropped)",
                cause=exc,
            ) from exc

    def shutdown(self) -> None:
        if self._flush_timer is not None:
            self._flush_timer.cancel()
            self._flush_timer = None
        self.flush()
        self._exporter.shutdown()

    def get_metrics(self) -> TracerMetrics:
        return TracerMetrics(
            spans_created=self._spans_created,
            spans_dropped=self._spans_dropped,
            queue_size=len(self._export_queue),
            traces_created=self._traces_created,
            traces_sampled=self._traces_sampled,
        )

    # --- Internal helpers ---

    def _start_trace(
        self,
        name: str,
        attributes: dict[str, SpanAttributeValue] | None,
    ) -> tuple[Span, Any]:
        self._traces_created += 1

        if self._sampling_rate < 1.0 and random.random() >= self._sampling_rate:
            noop = Span(name, SpanContext(trace_id="", span_id=""), 0)
            return noop, None

        self._traces_sampled += 1
        trace_id = _generate_trace_id()
        span_id = _generate_span_id()
        span = Span(
            name,
            SpanContext(trace_id=trace_id, span_id=span_id),
            self._max_span_attributes,
        )
        self._spans_created += 1

        if attributes:
            span.set_attributes(attributes)
        span.set_attribute("service.name", self._service_name)

        entry = _SpanStackEntry(span=span, trace_id=trace_id)
        token = _active_entry.set(entry)
        return span, token

    def _end_trace(self, span: Span, token: Any) -> None:
        span.end()
        if token is not None:
            _active_entry.reset(token)
            self._enqueue_span(span.data)

    def _start_child_span(
        self,
        name: str,
        attributes: dict[str, SpanAttributeValue] | None,
    ) -> tuple[Span, Any, _SpanStackEntry | None]:
        parent_entry = _active_entry.get()

        if parent_entry is None:
            noop = Span(name, SpanContext(trace_id="", span_id=""), 0)
            return noop, None, None

        span_id = _generate_span_id()
        span = Span(
            name,
            SpanContext(
                trace_id=parent_entry.trace_id,
                span_id=span_id,
                parent_span_id=parent_entry.span.context.span_id,
            ),
            self._max_span_attributes,
        )
        self._spans_created += 1

        if attributes:
            span.set_attributes(attributes)

        entry = _SpanStackEntry(span=span, trace_id=parent_entry.trace_id)
        token = _active_entry.set(entry)
        return span, token, parent_entry

    def _end_child_span(
        self,
        span: Span,
        token: Any,
        parent_entry: _SpanStackEntry | None,
    ) -> None:
        span.end()
        if token is not None:
            _active_entry.reset(token)
        if parent_entry is not None:
            parent_entry.span.add_child(span.data)

    def _enqueue_span(self, span: SpanData) -> None:
        if len(self._export_queue) >= self._max_queue_size:
            self._spans_dropped += 1
            return
        self._export_queue.append(span)

    def _schedule_flush(self) -> None:
        def _flush_and_reschedule() -> None:
            try:
                self.flush()
            except Exception:
                pass
            self._schedule_flush()

        self._flush_timer = threading.Timer(self._flush_interval_s, _flush_and_reschedule)
        self._flush_timer.daemon = True
        self._flush_timer.start()


# --- Context managers ---
# Python-idiomatic approach: context managers instead of callback functions.


class _TraceContextManager:
    def __init__(
        self,
        tracer: Tracer,
        name: str,
        attributes: dict[str, SpanAttributeValue] | None,
    ) -> None:
        self._tracer = tracer
        self._name = name
        self._attributes = attributes
        self._span: Span | None = None
        self._token: Any = None

    def __enter__(self) -> Span:
        self._span, self._token = self._tracer._start_trace(self._name, self._attributes)
        return self._span

    def __exit__(self, exc_type: type | None, exc_val: BaseException | None, exc_tb: Any) -> bool:
        span = self._span
        if span is None:
            return False
        if exc_val is not None:
            span.record_error(exc_val)
        else:
            span.set_status(SpanStatus.OK)
        self._tracer._end_trace(span, self._token)
        return False


class _SpanContextManager:
    def __init__(
        self,
        tracer: Tracer,
        name: str,
        attributes: dict[str, SpanAttributeValue] | None,
    ) -> None:
        self._tracer = tracer
        self._name = name
        self._attributes = attributes
        self._span: Span | None = None
        self._token: Any = None
        self._parent_entry: _SpanStackEntry | None = None

    def __enter__(self) -> Span:
        self._span, self._token, self._parent_entry = self._tracer._start_child_span(
            self._name, self._attributes
        )
        return self._span

    def __exit__(self, exc_type: type | None, exc_val: BaseException | None, exc_tb: Any) -> bool:
        span = self._span
        if span is None:
            return False
        if exc_val is not None:
            span.record_error(exc_val)
        else:
            span.set_status(SpanStatus.OK)
        self._tracer._end_child_span(span, self._token, self._parent_entry)
        return False


class _LLMCallContextManager:
    def __init__(self, tracer: Tracer, name: str, request: LLMRequest) -> None:
        self._tracer = tracer
        self._name = name
        self._request = request
        self._span_cm: _SpanContextManager | None = None
        self._span: Span | None = None

    def __enter__(self) -> _LLMCallContextManager:
        self._span_cm = self._tracer.span(self._name)
        self._span = self._span_cm.__enter__()

        self._span.set_attribute(LLMAttributes.MODEL, self._request.model or "unknown")
        if self._request.temperature is not None:
            self._span.set_attribute(LLMAttributes.TEMPERATURE, self._request.temperature)
        if self._request.max_tokens is not None:
            self._span.set_attribute(LLMAttributes.MAX_TOKENS, self._request.max_tokens)
        if self._tracer._capture_content:
            self._span.set_attribute(LLMAttributes.PROMPT, self._request.prompt)
        return self

    def set_response(self, response: LLMResponse) -> None:
        """Record response attributes on the span."""
        if self._span is None:
            return
        self._span.set_attribute(LLMAttributes.INPUT_TOKENS, response.input_tokens)
        self._span.set_attribute(LLMAttributes.OUTPUT_TOKENS, response.output_tokens)
        if self._tracer._capture_content:
            self._span.set_attribute(LLMAttributes.COMPLETION, response.content)

    def __exit__(self, exc_type: type | None, exc_val: BaseException | None, exc_tb: Any) -> bool:
        if self._span_cm is not None:
            return self._span_cm.__exit__(exc_type, exc_val, exc_tb)
        return False


class _RetrievalContextManager:
    def __init__(self, tracer: Tracer, name: str, query: str) -> None:
        self._tracer = tracer
        self._name = name
        self._query = query
        self._span_cm: _SpanContextManager | None = None
        self._span: Span | None = None

    def __enter__(self) -> _RetrievalContextManager:
        self._span_cm = self._tracer.span(self._name)
        self._span = self._span_cm.__enter__()

        self._span.set_attribute(LLMAttributes.STAGE_TYPE, "retrieval")
        if self._tracer._capture_content:
            self._span.set_attribute(LLMAttributes.RETRIEVAL_QUERY, self._query)
        return self

    def set_result(self, document_count: int, top_score: float | None = None) -> None:
        """Record retrieval result attributes on the span."""
        if self._span is None:
            return
        self._span.set_attribute(LLMAttributes.RETRIEVAL_DOC_COUNT, document_count)
        if top_score is not None:
            self._span.set_attribute(LLMAttributes.RETRIEVAL_TOP_SCORE, top_score)

    def __exit__(self, exc_type: type | None, exc_val: BaseException | None, exc_tb: Any) -> bool:
        if self._span_cm is not None:
            return self._span_cm.__exit__(exc_type, exc_val, exc_tb)
        return False


__all__ = [
    "Tracer",
    "Span",
    "ConsoleExporter",
    "InMemoryExporter",
    "TracerConfig",
    "TracerMetrics",
    "SpanData",
    "SpanContext",
    "SpanStatus",
    "SpanAttributeValue",
    "LLMAttributes",
    "LLMRequest",
    "LLMResponse",
    "TracingError",
    "ExportError",
]

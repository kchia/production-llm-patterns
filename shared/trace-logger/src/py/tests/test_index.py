"""Tests for shared/trace-logger.

Covers: Span, Tracer, InMemoryExporter, context-based nesting,
LLM/retrieval convenience helpers, failure modes, and integration scenarios.
"""

import pytest

from __init__ import (
    InMemoryExporter,
    LLMAttributes,
    LLMRequest,
    LLMResponse,
    Span,
    SpanContext,
    SpanStatus,
    Tracer,
    TracerConfig,
    ExportError,
)


# --- Helpers ---


def make_tracer(**kwargs) -> tuple[Tracer, InMemoryExporter]:
    exporter = InMemoryExporter()
    tracer = Tracer(TracerConfig(exporter=exporter, flush_interval_s=0, **kwargs))
    return tracer, exporter


# --- Unit: Span ---


class TestSpan:
    def test_set_attribute(self):
        span = Span("test", SpanContext("tid", "sid"), 64)
        span.set_attribute("key", "value")
        assert span.data.attributes["key"] == "value"

    def test_rejects_after_end(self):
        span = Span("test", SpanContext("tid", "sid"), 64)
        span.end()
        span.set_attribute("key", "late")
        assert "key" not in span.data.attributes

    def test_max_attributes_cap(self):
        span = Span("test", SpanContext("tid", "sid"), 2)
        span.set_attribute("a", 1)
        span.set_attribute("b", 2)
        span.set_attribute("c", 3)  # over cap — dropped
        assert len(span.data.attributes) == 2

    def test_status_ok_on_end(self):
        span = Span("test", SpanContext("tid", "sid"), 64)
        span.end()
        assert span.data.status == SpanStatus.OK

    def test_record_error(self):
        span = Span("test", SpanContext("tid", "sid"), 64)
        span.record_error(ValueError("boom"))
        assert span.data.status == SpanStatus.ERROR
        assert span.data.attributes["error.message"] == "boom"

    def test_duration_ms_after_end(self):
        span = Span("test", SpanContext("tid", "sid"), 64)
        span.end()
        assert span.duration_ms is not None
        assert span.duration_ms >= 0

    def test_duration_ms_before_end_is_none(self):
        span = Span("test", SpanContext("tid", "sid"), 64)
        assert span.duration_ms is None


# --- Unit: Tracer ---


class TestTracer:
    def test_creates_trace_with_ids(self):
        tracer, exporter = make_tracer()
        with tracer.trace("pipeline"):
            pass
        tracer.flush()
        traces = exporter.traces
        assert len(traces) == 1
        assert traces[0].context.trace_id != ""
        assert traces[0].context.span_id != ""

    def test_attaches_service_name(self):
        tracer, exporter = make_tracer(service_name="my-svc")
        with tracer.trace("pipeline"):
            pass
        tracer.flush()
        assert exporter.traces[0].attributes["service.name"] == "my-svc"

    def test_nests_child_spans(self):
        tracer, exporter = make_tracer()
        with tracer.trace("root"):
            with tracer.span("child"):
                pass
        tracer.flush()

        root = exporter.traces[0]
        assert len(root.children) == 1
        assert root.children[0].name == "child"
        assert root.children[0].context.parent_span_id == root.context.span_id

    def test_shared_trace_id_across_nesting(self):
        tracer, exporter = make_tracer()
        with tracer.trace("root"):
            with tracer.span("child"):
                pass
        tracer.flush()

        root = exporter.traces[0]
        assert root.children[0].context.trace_id == root.context.trace_id

    def test_span_outside_trace_is_noop(self):
        tracer, exporter = make_tracer()
        with tracer.span("orphan") as span:
            assert span.context.trace_id == ""  # noop span
        tracer.flush()
        assert len(exporter.all_spans()) == 0

    def test_error_sets_error_status(self):
        tracer, exporter = make_tracer()
        with pytest.raises(ValueError):
            with tracer.trace("failing"):
                raise ValueError("boom")
        tracer.flush()
        assert exporter.traces[0].status == SpanStatus.ERROR

    def test_sampling_rate_zero_records_nothing(self):
        tracer, exporter = make_tracer(sampling_rate=0.0)
        for _ in range(5):
            with tracer.trace("pipeline"):
                pass
        tracer.flush()
        assert exporter.traces == []
        assert tracer.get_metrics().traces_created == 5
        assert tracer.get_metrics().traces_sampled == 0

    def test_active_span_inside_trace(self):
        tracer, _ = make_tracer()
        with tracer.trace("root") as root_span:
            assert tracer.active_span is root_span

    def test_shutdown_flushes(self):
        tracer, exporter = make_tracer()
        with tracer.trace("pipeline"):
            pass
        # Don't flush manually — shutdown should
        tracer.shutdown()
        assert len(exporter.traces) == 1


# --- Unit: LLM convenience helpers ---


class TestTraceLLMCall:
    def test_attaches_model_and_tokens(self):
        tracer, exporter = make_tracer()
        with tracer.trace("root"):
            with tracer.trace_llm_call("generate", LLMRequest(prompt="hi", model="gpt-4o")) as ctx:
                ctx.set_response(
                    LLMResponse(
                        content="hello",
                        model="gpt-4o",
                        input_tokens=10,
                        output_tokens=5,
                        latency_ms=200,
                    )
                )
        tracer.flush()

        spans = exporter.spans_by_name("generate")
        assert len(spans) == 1
        assert spans[0].attributes[LLMAttributes.MODEL] == "gpt-4o"
        assert spans[0].attributes[LLMAttributes.INPUT_TOKENS] == 10
        assert spans[0].attributes[LLMAttributes.OUTPUT_TOKENS] == 5

    def test_no_content_by_default(self):
        tracer, exporter = make_tracer(capture_content=False)
        with tracer.trace("root"):
            with tracer.trace_llm_call(
                "generate", LLMRequest(prompt="secret", model="gpt-4o")
            ) as ctx:
                ctx.set_response(
                    LLMResponse("private", "gpt-4o", 5, 3, 100)
                )
        tracer.flush()

        span = exporter.spans_by_name("generate")[0]
        assert LLMAttributes.PROMPT not in span.attributes
        assert LLMAttributes.COMPLETION not in span.attributes

    def test_captures_content_when_enabled(self):
        tracer, exporter = make_tracer(capture_content=True)
        with tracer.trace("root"):
            with tracer.trace_llm_call(
                "generate", LLMRequest(prompt="hello", model="gpt-4o")
            ) as ctx:
                ctx.set_response(LLMResponse("world", "gpt-4o", 2, 1, 50))
        tracer.flush()

        span = exporter.spans_by_name("generate")[0]
        assert span.attributes[LLMAttributes.PROMPT] == "hello"
        assert span.attributes[LLMAttributes.COMPLETION] == "world"


class TestTraceRetrieval:
    def test_attaches_stage_type_and_doc_count(self):
        tracer, exporter = make_tracer()
        with tracer.trace("root"):
            with tracer.trace_retrieval("retrieve", "test query") as ctx:
                ctx.set_result(document_count=5, top_score=0.92)
        tracer.flush()

        span = exporter.spans_by_name("retrieve")[0]
        assert span.attributes[LLMAttributes.STAGE_TYPE] == "retrieval"
        assert span.attributes[LLMAttributes.RETRIEVAL_DOC_COUNT] == 5
        assert span.attributes[LLMAttributes.RETRIEVAL_TOP_SCORE] == 0.92


# --- Unit: Queue and backpressure ---


class TestQueueAndBackpressure:
    def test_drops_when_queue_full(self):
        tracer, _ = make_tracer(max_queue_size=1)
        with tracer.trace("first"):
            pass
        with tracer.trace("second"):
            pass
        metrics = tracer.get_metrics()
        assert metrics.spans_dropped > 0

    def test_export_failure_raises_export_error(self):
        class FailingExporter:
            def export(self, spans):
                raise RuntimeError("network error")
            def shutdown(self):
                pass

        tracer = Tracer(TracerConfig(exporter=FailingExporter(), flush_interval_s=0))
        with tracer.trace("pipeline"):
            pass
        with pytest.raises(ExportError):
            tracer.flush()


# --- Unit: InMemoryExporter ---


class TestInMemoryExporter:
    def test_stores_and_retrieves(self):
        tracer, exporter = make_tracer()
        with tracer.trace("root"):
            pass
        tracer.flush()
        assert len(exporter.traces) == 1

    def test_spans_by_name_traverses_children(self):
        tracer, exporter = make_tracer()
        with tracer.trace("root"):
            with tracer.span("target"):
                pass
        tracer.flush()
        found = exporter.spans_by_name("target")
        assert len(found) == 1
        assert found[0].name == "target"

    def test_all_spans_flattens_tree(self):
        tracer, exporter = make_tracer()
        with tracer.trace("root"):
            with tracer.span("child"):
                pass
        tracer.flush()
        assert len(exporter.all_spans()) == 2

    def test_clear(self):
        tracer, exporter = make_tracer()
        with tracer.trace("root"):
            pass
        tracer.flush()
        exporter.clear()
        assert exporter.traces == []


# --- Integration: full RAG pipeline ---


class TestIntegration:
    def test_full_rag_pipeline_trace_tree(self):
        tracer, exporter = make_tracer(service_name="rag-service")

        with tracer.trace("rag-pipeline") as root:
            root.set_attribute("user.id", "user-123")

            with tracer.trace_retrieval("retrieval", "structured tracing") as ctx:
                ctx.set_result(document_count=3, top_score=0.88)

            with tracer.trace_llm_call(
                "generation",
                LLMRequest(prompt="Context: ...\n\nQ: What?", model="gpt-4o-mini"),
            ) as llm_ctx:
                llm_ctx.set_response(
                    LLMResponse("Structured tracing is...", "gpt-4o-mini", 120, 80, 450)
                )

            with tracer.span("validation") as v:
                v.set_attribute("passed", True)

        tracer.flush()

        root_span = exporter.traces[0]
        assert root_span.name == "rag-pipeline"
        assert root_span.attributes["service.name"] == "rag-service"
        assert len(root_span.children) == 3

        retrieval, generation, validation = root_span.children
        assert retrieval.attributes[LLMAttributes.RETRIEVAL_DOC_COUNT] == 3
        assert generation.attributes[LLMAttributes.INPUT_TOKENS] == 120
        assert validation.attributes["passed"] is True

        # All spans share same trace ID
        all_spans = exporter.all_spans()
        trace_ids = {s.context.trace_id for s in all_spans}
        assert len(trace_ids) == 1

    def test_concurrent_traces_no_cross_contamination(self):
        """Each trace must keep its own context even when nested traces run together."""
        tracer, exporter = make_tracer()

        # Python threads share the same process context, but contextvars are per-task.
        # Here we test that two sequential trace calls produce independent traces.
        with tracer.trace("trace-a") as span_a:
            span_a.set_attribute("trace", "a")
            with tracer.span("child-a"):
                pass

        with tracer.trace("trace-b") as span_b:
            span_b.set_attribute("trace", "b")
            with tracer.span("child-b"):
                pass

        tracer.flush()

        traces = exporter.traces
        assert len(traces) == 2
        trace_a = next(t for t in traces if t.attributes.get("trace") == "a")
        trace_b = next(t for t in traces if t.attributes.get("trace") == "b")
        assert trace_a.context.trace_id != trace_b.context.trace_id
        assert trace_a.children[0].name == "child-a"
        assert trace_b.children[0].name == "child-b"


# --- Failure mode: silent sampling drift ---


class TestSilentSamplingDrift:
    def test_metrics_expose_sampling_ratio(self):
        tracer, _ = make_tracer(sampling_rate=0.5)
        for _ in range(100):
            with tracer.trace("pipeline"):
                pass
        tracer.flush()

        metrics = tracer.get_metrics()
        assert metrics.traces_created == 100
        assert 0 < metrics.traces_sampled < 100

    def test_traces_created_accurate_at_zero_sampling(self):
        tracer, _ = make_tracer(sampling_rate=0.0)
        for _ in range(5):
            with tracer.trace("pipeline"):
                pass
        metrics = tracer.get_metrics()
        assert metrics.traces_created == 5
        assert metrics.traces_sampled == 0

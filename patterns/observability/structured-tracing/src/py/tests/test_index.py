"""Structured Tracing — Test Suite (Python).

Three categories:
1. Unit tests — core tracing logic
2. Failure mode tests — one per Failure Modes table row
3. Integration tests — end-to-end pipeline with mock provider
"""

from __future__ import annotations

import asyncio
import time

import pytest

from .. import (
    ConsoleExporter,
    InMemoryExporter,
    Span,
    Tracer,
    TracerConfig,
)
from ..mock_provider import MockProvider, MockProviderConfig, ProviderError
from .._types import (
    ExportError,
    LLMAttributes,
    LLMRequest,
    SpanData,
    SpanExporter,
    SpanStatus,
)


# --- Helpers ---


def create_tracer(**overrides):
    exporter = InMemoryExporter()
    config = TracerConfig(exporter=exporter, flush_interval_s=0, **overrides)
    tracer = Tracer(config)
    return tracer, exporter


# =====================
# 1. Unit Tests
# =====================


class TestUnitSpan:
    def test_creates_span_with_correct_initial_state(self):
        tracer, exporter = create_tracer()
        with tracer.trace("root") as span:
            assert not span.is_ended
            assert span.data.status == SpanStatus.UNSET
        tracer.flush()
        traces = exporter.traces
        assert traces[0].status == SpanStatus.OK

    def test_sets_attributes_on_span(self):
        tracer, exporter = create_tracer()
        with tracer.trace("root") as span:
            span.set_attribute("key1", "value1")
            span.set_attribute("key2", 42)
            span.set_attribute("key3", True)
        tracer.flush()
        trace = exporter.traces[0]
        assert trace.attributes["key1"] == "value1"
        assert trace.attributes["key2"] == 42
        assert trace.attributes["key3"] is True

    def test_sets_multiple_attributes_at_once(self):
        tracer, exporter = create_tracer()
        with tracer.trace("root") as span:
            span.set_attributes({"a": 1, "b": "two", "c": False})
        tracer.flush()
        trace = exporter.traces[0]
        assert trace.attributes["a"] == 1
        assert trace.attributes["b"] == "two"
        assert trace.attributes["c"] is False

    def test_ignores_set_attribute_after_span_ends(self):
        tracer, exporter = create_tracer()
        with tracer.trace("root") as span:
            span.set_attribute("before", True)
        span.set_attribute("after", True)
        tracer.flush()
        trace = exporter.traces[0]
        assert trace.attributes["before"] is True
        assert "after" not in trace.attributes

    def test_records_errors_with_type_and_message(self):
        tracer, exporter = create_tracer()
        with pytest.raises(TypeError, match="bad type"):
            with tracer.trace("root"):
                raise TypeError("bad type")
        tracer.flush()
        trace = exporter.traces[0]
        assert trace.status == SpanStatus.ERROR
        assert trace.attributes["error.type"] == "TypeError"
        assert trace.attributes["error.message"] == "bad type"

    def test_computes_span_duration(self):
        tracer, exporter = create_tracer()
        with tracer.trace("root"):
            time.sleep(0.01)
        tracer.flush()
        trace = exporter.traces[0]
        assert trace.end_time is not None
        duration_s = trace.end_time - trace.start_time
        assert duration_s >= 0.005


class TestUnitTracerContext:
    def test_nests_child_spans_under_parent(self):
        tracer, exporter = create_tracer()
        with tracer.trace("pipeline"):
            with tracer.span("step1"):
                pass
            with tracer.span("step2"):
                pass
        tracer.flush()
        root = exporter.traces[0]
        assert len(root.children) == 2
        assert root.children[0].name == "step1"
        assert root.children[1].name == "step2"
        assert root.children[0].context.trace_id == root.context.trace_id
        assert root.children[0].context.parent_span_id == root.context.span_id

    def test_supports_deeply_nested_spans(self):
        tracer, exporter = create_tracer()
        with tracer.trace("level0"):
            with tracer.span("level1"):
                with tracer.span("level2"):
                    with tracer.span("level3"):
                        pass
        tracer.flush()
        root = exporter.traces[0]
        assert root.children[0].name == "level1"
        assert root.children[0].children[0].name == "level2"
        assert root.children[0].children[0].children[0].name == "level3"

    def test_span_outside_trace_runs_as_noop(self):
        tracer, exporter = create_tracer()
        with tracer.span("orphan") as span:
            pass  # should not crash
        tracer.flush()
        assert len(exporter.traces) == 0

    def test_provides_active_span_inside_trace(self):
        tracer, _ = create_tracer()
        active_in_trace = None
        active_in_span = None

        with tracer.trace("root"):
            active_in_trace = tracer.active_span
            with tracer.span("child"):
                active_in_span = tracer.active_span

        assert active_in_trace is not None
        assert active_in_trace.data.name == "root"
        assert active_in_span is not None
        assert active_in_span.data.name == "child"


class TestUnitTracerConfig:
    def test_respects_sampling_rate_zero(self):
        tracer, exporter = create_tracer(sampling_rate=0.0)
        for i in range(10):
            with tracer.trace(f"trace-{i}"):
                pass
        tracer.flush()
        assert len(exporter.traces) == 0
        metrics = tracer.get_metrics()
        assert metrics.traces_created == 10
        assert metrics.traces_sampled == 0

    def test_caps_attributes_at_max_span_attributes(self):
        tracer, exporter = create_tracer(max_span_attributes=3)
        with tracer.trace("root") as span:
            span.set_attribute("a", 1)
            span.set_attribute("b", 2)
            span.set_attribute("c", 3)
            span.set_attribute("d", 4)
            span.set_attribute("e", 5)
        tracer.flush()
        trace = exporter.traces[0]
        # service.name is auto-added first, then a, b fit within 3
        assert len(trace.attributes) <= 3

    def test_adds_service_name_to_root_spans(self):
        tracer, exporter = create_tracer(service_name="my-service")
        with tracer.trace("root"):
            pass
        tracer.flush()
        assert exporter.traces[0].attributes["service.name"] == "my-service"


class TestUnitLLMHelpers:
    def test_trace_llm_call_captures_model_and_tokens(self):
        tracer, exporter = create_tracer()
        provider = MockProvider(MockProviderConfig(latency_ms=0))

        with tracer.trace("pipeline"):
            with tracer.trace_llm_call(
                "generate",
                LLMRequest(prompt="test", model="gpt-4o", temperature=0.7, max_tokens=500),
            ) as ctx:
                resp = asyncio.get_event_loop().run_until_complete(
                    provider.call(LLMRequest(prompt="test", model="gpt-4o"))
                )
                ctx.set_response(resp)

        tracer.flush()
        llm = exporter.spans_by_name("generate")[0]
        assert llm.attributes[LLMAttributes.MODEL] == "gpt-4o"
        assert llm.attributes[LLMAttributes.TEMPERATURE] == 0.7
        assert llm.attributes[LLMAttributes.MAX_TOKENS] == 500
        assert llm.attributes[LLMAttributes.INPUT_TOKENS] == 100
        assert llm.attributes[LLMAttributes.OUTPUT_TOKENS] == 200

    def test_does_not_capture_content_by_default(self):
        tracer, exporter = create_tracer(capture_content=False)
        provider = MockProvider(MockProviderConfig(latency_ms=0))

        with tracer.trace("pipeline"):
            with tracer.trace_llm_call(
                "generate",
                LLMRequest(prompt="secret prompt"),
            ) as ctx:
                resp = asyncio.get_event_loop().run_until_complete(
                    provider.call(LLMRequest(prompt="secret prompt"))
                )
                ctx.set_response(resp)

        tracer.flush()
        llm = exporter.spans_by_name("generate")[0]
        assert LLMAttributes.PROMPT not in llm.attributes
        assert LLMAttributes.COMPLETION not in llm.attributes

    def test_captures_content_when_enabled(self):
        tracer, exporter = create_tracer(capture_content=True)
        provider = MockProvider(MockProviderConfig(latency_ms=0, response_content="mock output"))

        with tracer.trace("pipeline"):
            with tracer.trace_llm_call(
                "generate",
                LLMRequest(prompt="my prompt"),
            ) as ctx:
                resp = asyncio.get_event_loop().run_until_complete(
                    provider.call(LLMRequest(prompt="my prompt"))
                )
                ctx.set_response(resp)

        tracer.flush()
        llm = exporter.spans_by_name("generate")[0]
        assert llm.attributes[LLMAttributes.PROMPT] == "my prompt"
        assert llm.attributes[LLMAttributes.COMPLETION] == "mock output"

    def test_trace_retrieval_captures_doc_count_and_score(self):
        tracer, exporter = create_tracer()

        with tracer.trace("pipeline"):
            with tracer.trace_retrieval("retrieve", "search query") as ctx:
                ctx.set_result(document_count=2, top_score=0.95)

        tracer.flush()
        ret = exporter.spans_by_name("retrieve")[0]
        assert ret.attributes[LLMAttributes.RETRIEVAL_DOC_COUNT] == 2
        assert ret.attributes[LLMAttributes.RETRIEVAL_TOP_SCORE] == 0.95
        assert ret.attributes[LLMAttributes.STAGE_TYPE] == "retrieval"


class TestUnitExportAndFlush:
    def test_flushes_queued_spans_to_exporter(self):
        tracer, exporter = create_tracer()
        with tracer.trace("t1"):
            pass
        with tracer.trace("t2"):
            pass
        assert len(exporter.traces) == 0
        tracer.flush()
        assert len(exporter.traces) == 2

    def test_handles_empty_flush(self):
        tracer, _ = create_tracer()
        tracer.flush()  # should not crash

    def test_shutdown_flushes_and_stops(self):
        tracer, exporter = create_tracer()
        with tracer.trace("t1"):
            pass
        tracer.shutdown()
        assert len(exporter.traces) == 1


# =====================
# 2. Failure Mode Tests
# =====================


class TestFMTraceExportBacklog:
    def test_drops_spans_when_queue_is_full(self):
        tracer, exporter = create_tracer(max_queue_size=2)
        with tracer.trace("t1"):
            pass
        with tracer.trace("t2"):
            pass
        with tracer.trace("t3"):
            pass
        metrics = tracer.get_metrics()
        assert metrics.spans_dropped == 1
        assert metrics.queue_size == 2
        tracer.flush()
        assert len(exporter.traces) == 2

    def test_reports_spans_dropped_in_metrics(self):
        tracer, _ = create_tracer(max_queue_size=1)
        with tracer.trace("t1"):
            pass
        with tracer.trace("t2"):
            pass
        with tracer.trace("t3"):
            pass
        metrics = tracer.get_metrics()
        assert metrics.spans_dropped == 2


class TestFMContextPropagationLoss:
    def test_orphaned_span_outside_trace_not_recorded(self):
        tracer, exporter = create_tracer()
        with tracer.span("orphan"):
            pass
        tracer.flush()
        assert len(exporter.traces) == 0
        assert len(exporter.spans_by_name("orphan")) == 0

    def test_spans_inside_trace_are_properly_nested(self):
        tracer, exporter = create_tracer()
        with tracer.trace("pipeline"):
            with tracer.span("child"):
                pass
        tracer.flush()
        root = exporter.traces[0]
        assert len(root.children) == 1
        assert root.children[0].context.parent_span_id == root.context.span_id


class TestFMSensitiveData:
    def test_does_not_capture_content_by_default(self):
        tracer, exporter = create_tracer()
        provider = MockProvider(MockProviderConfig(latency_ms=0))

        with tracer.trace("pipeline"):
            with tracer.trace_llm_call(
                "llm",
                LLMRequest(prompt="SSN: 123-45-6789"),
            ) as ctx:
                resp = asyncio.get_event_loop().run_until_complete(
                    provider.call(LLMRequest(prompt="SSN: 123-45-6789"))
                )
                ctx.set_response(resp)

        tracer.flush()
        for span in exporter.all_spans():
            assert LLMAttributes.PROMPT not in span.attributes
            assert LLMAttributes.COMPLETION not in span.attributes


class TestFMHighCardinalityAttributes:
    def test_respects_max_span_attributes_limit(self):
        tracer, exporter = create_tracer(max_span_attributes=5)
        with tracer.trace("root") as span:
            for i in range(100):
                span.set_attribute(f"key-{i}", f"value-{i}")
        tracer.flush()
        trace = exporter.traces[0]
        assert len(trace.attributes) <= 5


class TestFMInstrumentationGaps:
    def test_timing_gaps_when_stages_not_traced(self):
        tracer, exporter = create_tracer()
        with tracer.trace("pipeline"):
            with tracer.span("retrieval"):
                time.sleep(0.005)
            time.sleep(0.010)
            with tracer.span("generation"):
                time.sleep(0.005)
        tracer.flush()
        root = exporter.traces[0]
        child_duration = sum(
            (c.end_time - c.start_time) for c in root.children if c.end_time
        )
        root_duration = root.end_time - root.start_time
        assert root_duration - child_duration > 0.005


class TestFMSilentSamplingDrift:
    def test_metrics_reveal_when_sampling_active(self):
        tracer, _ = create_tracer(sampling_rate=0.0)
        for i in range(100):
            with tracer.trace(f"t-{i}"):
                pass
        metrics = tracer.get_metrics()
        assert metrics.traces_created == 100
        assert metrics.traces_sampled == 0
        assert metrics.traces_sampled / metrics.traces_created == 0


class TestFMExportFailureRecovery:
    def test_re_enqueues_spans_on_export_failure(self):
        call_count = 0

        class FailingExporter:
            def export(self, spans):
                nonlocal call_count
                call_count += 1
                if call_count == 1:
                    raise RuntimeError("network error")

            def shutdown(self):
                pass

        config = TracerConfig(exporter=FailingExporter(), flush_interval_s=0)
        tracer = Tracer(config)
        with tracer.trace("t1"):
            pass

        with pytest.raises(ExportError, match="Failed to export"):
            tracer.flush()

        metrics = tracer.get_metrics()
        assert metrics.queue_size > 0

        tracer.flush()
        assert call_count == 2


# =====================
# 3. Integration Tests
# =====================


class TestIntegrationRAGPipeline:
    def test_traces_complete_rag_pipeline(self):
        tracer, exporter = create_tracer(capture_content=True)
        provider = MockProvider(
            MockProviderConfig(
                latency_ms=0,
                response_content="The answer is 42.",
                input_tokens_per_request=500,
                output_tokens_per_request=50,
            )
        )

        with tracer.trace("rag-pipeline", {"pipeline.type": "rag", "user.session_id": "test"}) as root_span:
            with tracer.trace_retrieval("retrieve", "what is the answer?") as ret_ctx:
                ret_ctx.set_result(document_count=2, top_score=0.92)
            context_str = "doc1: the answer is 42\ndoc2: some other info"

            with tracer.trace_llm_call(
                "generate",
                LLMRequest(
                    prompt=f"Context: {context_str}\nQuestion: what is the answer?",
                    model="gpt-4o",
                ),
            ) as llm_ctx:
                resp = asyncio.get_event_loop().run_until_complete(
                    provider.call(
                        LLMRequest(
                            prompt=f"Context: {context_str}\nQuestion: what is the answer?",
                            model="gpt-4o",
                        )
                    )
                )
                llm_ctx.set_response(resp)

            with tracer.span("validate") as val_span:
                valid = "42" in resp.content
                val_span.set_attribute("validation.passed", valid)
                val_span.set_attribute("validation.check", "contains_answer")

        tracer.flush()
        traces = exporter.traces
        assert len(traces) == 1

        root = traces[0]
        assert root.name == "rag-pipeline"
        assert root.attributes["pipeline.type"] == "rag"
        assert len(root.children) == 3

        retrieval_span = root.children[0]
        assert retrieval_span.name == "retrieve"
        assert retrieval_span.attributes[LLMAttributes.RETRIEVAL_DOC_COUNT] == 2
        assert retrieval_span.attributes[LLMAttributes.RETRIEVAL_TOP_SCORE] == 0.92

        gen_span = root.children[1]
        assert gen_span.name == "generate"
        assert gen_span.attributes[LLMAttributes.MODEL] == "gpt-4o"
        assert gen_span.attributes[LLMAttributes.INPUT_TOKENS] == 500
        assert gen_span.attributes[LLMAttributes.COMPLETION] == "The answer is 42."

        val = root.children[2]
        assert val.name == "validate"
        assert val.attributes["validation.passed"] is True

        all_spans = exporter.all_spans()
        trace_ids = {s.context.trace_id for s in all_spans}
        assert len(trace_ids) == 1

    def test_traces_error_propagation(self):
        tracer, exporter = create_tracer()
        provider = MockProvider(
            MockProviderConfig(latency_ms=0, error_sequence=[503])
        )

        with pytest.raises(ProviderError):
            with tracer.trace("rag-pipeline"):
                with tracer.span("retrieve"):
                    pass
                with tracer.trace_llm_call(
                    "generate",
                    LLMRequest(prompt="test"),
                ) as ctx:
                    asyncio.get_event_loop().run_until_complete(
                        provider.call(LLMRequest(prompt="test"))
                    )

        tracer.flush()
        root = exporter.traces[0]
        assert root.status == SpanStatus.ERROR
        assert root.children[0].status == SpanStatus.OK

        gen_span = root.children[1]
        assert gen_span.status == SpanStatus.ERROR
        assert gen_span.attributes["error.type"] == "ProviderError"


class TestIntegrationConcurrentTraces:
    def test_concurrent_traces_are_independent(self):
        """Test that asyncio tasks get independent trace contexts."""
        tracer, exporter = create_tracer()
        provider = MockProvider(MockProviderConfig(latency_ms=0))

        async def run_pipeline(name: str):
            with tracer.trace(f"pipeline-{name}"):
                with tracer.span(f"step-{name}1"):
                    pass
                with tracer.trace_llm_call(
                    f"llm-{name}",
                    LLMRequest(prompt=name),
                ) as ctx:
                    resp = await provider.call(LLMRequest(prompt=name))
                    ctx.set_response(resp)

        async def run_both():
            await asyncio.gather(run_pipeline("a"), run_pipeline("b"))

        asyncio.get_event_loop().run_until_complete(run_both())
        tracer.flush()

        traces = exporter.traces
        assert len(traces) == 2
        assert traces[0].context.trace_id != traces[1].context.trace_id
        assert len(traces[0].children) == 2
        assert len(traces[1].children) == 2

        for trace in traces:
            for child in trace.children:
                assert child.context.trace_id == trace.context.trace_id


class TestIntegrationMockProvider:
    def test_simulates_configurable_latency(self):
        provider = MockProvider(MockProviderConfig(latency_ms=20))
        start = time.perf_counter()
        asyncio.get_event_loop().run_until_complete(
            provider.call(LLMRequest(prompt="test"))
        )
        elapsed_ms = (time.perf_counter() - start) * 1000
        assert elapsed_ms >= 15

    def test_simulates_deterministic_error_sequences(self):
        provider = MockProvider(
            MockProviderConfig(
                latency_ms=0,
                error_sequence=["success", 503, "success", 429],
            )
        )
        results = []
        for _ in range(4):
            try:
                asyncio.get_event_loop().run_until_complete(
                    provider.call(LLMRequest(prompt="test"))
                )
                results.append("ok")
            except ProviderError as e:
                results.append(e.status_code)
        assert results == ["ok", 503, "ok", 429]

    def test_tracks_call_count_and_resets(self):
        provider = MockProvider(MockProviderConfig(latency_ms=0))
        asyncio.get_event_loop().run_until_complete(
            provider.call(LLMRequest(prompt="a"))
        )
        asyncio.get_event_loop().run_until_complete(
            provider.call(LLMRequest(prompt="b"))
        )
        assert provider.call_count == 2
        provider.reset()
        assert provider.call_count == 0


class TestIntegrationInMemoryExporter:
    def test_searches_spans_by_name(self):
        tracer, exporter = create_tracer()
        with tracer.trace("pipeline"):
            with tracer.span("retrieve"):
                pass
            with tracer.span("generate"):
                with tracer.span("llm-call"):
                    pass
        tracer.flush()
        assert len(exporter.spans_by_name("llm-call")) == 1
        assert len(exporter.spans_by_name("retrieve")) == 1
        assert len(exporter.spans_by_name("nonexistent")) == 0
        assert len(exporter.all_spans()) == 4

    def test_clears_all_traces(self):
        tracer, exporter = create_tracer()
        with tracer.trace("t1"):
            pass
        tracer.flush()
        assert len(exporter.traces) == 1
        exporter.clear()
        assert len(exporter.traces) == 0

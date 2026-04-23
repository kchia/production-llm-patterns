"""
test-fixtures — Unit Tests (Python)

Covers:
  MockProvider: responses, tokens, model, call tracking, failure modes,
                ProviderError statusCode/retry_after_ms, error_sequence, update_config
  ProviderError: attributes
  create_static_handler, create_cache_handler
  create_rule_based_handler
  create_sequence_provider
  mock_llm_stream: token count, content, error injection, cancellation
  MockSlowConsumer: capacity, backpressure, drain callback, written list
"""

from __future__ import annotations

import asyncio
import re

import pytest

from .. import (
    MockProvider,
    MockSlowConsumer,
    create_cache_handler,
    create_rule_based_handler,
    create_sequence_provider,
    create_static_handler,
    mock_llm_stream,
)
from ..types import LLMRequest, MockProviderConfig, MockStreamOptions, ProviderError


REQ = LLMRequest(prompt="test prompt")


# ─── MockProvider ─────────────────────────────────────────────────────────────


class TestMockProvider:
    @pytest.mark.asyncio
    async def test_returns_response(self):
        p = MockProvider(MockProviderConfig(latency_ms=0, tokens_per_response=42))
        res = await p.call(REQ)
        assert res.content
        assert res.tokens_used == 42
        assert res.model == "mock-model"
        assert res.finish_reason == "stop"

    @pytest.mark.asyncio
    async def test_static_response_content(self):
        p = MockProvider(MockProviderConfig(latency_ms=0, response_content="hello world"))
        res = await p.call(REQ)
        assert res.content == "hello world"

    @pytest.mark.asyncio
    async def test_generated_content_from_prompt(self):
        p = MockProvider(MockProviderConfig(latency_ms=0))
        res = await p.call(LLMRequest(prompt="What is 2+2?"))
        assert "What is 2+2" in res.content

    @pytest.mark.asyncio
    async def test_custom_model_name(self):
        p = MockProvider(MockProviderConfig(latency_ms=0, model="gpt-4o-test"))
        res = await p.call(REQ)
        assert res.model == "gpt-4o-test"

    @pytest.mark.asyncio
    async def test_tracks_call_count(self):
        p = MockProvider(MockProviderConfig(latency_ms=0))
        assert p.call_count == 0
        await p.call(REQ)
        await p.call(REQ)
        assert p.call_count == 2

    @pytest.mark.asyncio
    async def test_increments_call_count_on_failure(self):
        p = MockProvider(MockProviderConfig(latency_ms=0, failure_rate=1.0))
        with pytest.raises(ProviderError):
            await p.call(REQ)
        assert p.call_count == 1

    @pytest.mark.asyncio
    async def test_reset_clears_state(self):
        p = MockProvider(MockProviderConfig(latency_ms=0, error_sequence=[503]))
        with pytest.raises(ProviderError):
            await p.call(REQ)
        p.reset()
        assert p.call_count == 0
        # After reset, sequence restarts — 503 again
        with pytest.raises(ProviderError):
            await p.call(REQ)

    @pytest.mark.asyncio
    async def test_throws_provider_error_with_status_code(self):
        p = MockProvider(
            MockProviderConfig(latency_ms=0, failure_rate=1.0, failure_status_code=429)
        )
        with pytest.raises(ProviderError) as exc_info:
            await p.call(REQ)
        assert exc_info.value.status_code == 429

    @pytest.mark.asyncio
    async def test_attaches_retry_after_ms_to_429(self):
        p = MockProvider(
            MockProviderConfig(
                latency_ms=0,
                failure_rate=1.0,
                failure_status_code=429,
                retry_after_ms=500,
            )
        )
        with pytest.raises(ProviderError) as exc_info:
            await p.call(REQ)
        assert exc_info.value.retry_after_ms == 500

    @pytest.mark.asyncio
    async def test_does_not_attach_retry_after_ms_to_non_429(self):
        p = MockProvider(
            MockProviderConfig(
                latency_ms=0,
                failure_rate=1.0,
                failure_status_code=503,
                retry_after_ms=500,
            )
        )
        with pytest.raises(ProviderError) as exc_info:
            await p.call(REQ)
        assert exc_info.value.retry_after_ms is None

    @pytest.mark.asyncio
    async def test_error_sequence_in_order(self):
        p = MockProvider(
            MockProviderConfig(latency_ms=0, error_sequence=[503, "success", 429])
        )
        with pytest.raises(ProviderError) as exc_info:
            await p.call(REQ)
        assert exc_info.value.status_code == 503

        res = await p.call(REQ)
        assert res.finish_reason == "stop"

        with pytest.raises(ProviderError) as exc_info:
            await p.call(REQ)
        assert exc_info.value.status_code == 429

    @pytest.mark.asyncio
    async def test_falls_back_to_probabilistic_after_sequence(self):
        p = MockProvider(
            MockProviderConfig(
                latency_ms=0,
                error_sequence=["success"],
                failure_rate=1.0,
            )
        )
        res = await p.call(REQ)  # consumes 'success'
        assert res.finish_reason == "stop"

        with pytest.raises(ProviderError):
            await p.call(REQ)

    @pytest.mark.asyncio
    async def test_update_config_modifies_behavior(self):
        p = MockProvider(MockProviderConfig(latency_ms=0, failure_rate=0.0))
        res = await p.call(REQ)
        assert res.finish_reason == "stop"

        p.update_config(failure_rate=1.0)
        with pytest.raises(ProviderError):
            await p.call(REQ)

    @pytest.mark.asyncio
    async def test_update_config_replaces_error_sequence(self):
        p = MockProvider(MockProviderConfig(latency_ms=0, error_sequence=[503, 503]))
        p.update_config(error_sequence=["success", "success"])
        r1 = await p.call(REQ)
        r2 = await p.call(REQ)
        assert r1.finish_reason == "stop"
        assert r2.finish_reason == "stop"

    @pytest.mark.asyncio
    async def test_records_latency_ms(self):
        p = MockProvider(MockProviderConfig(latency_ms=20))
        res = await p.call(REQ)
        assert res.latency_ms is not None
        assert res.latency_ms >= 15


# ─── ProviderError ────────────────────────────────────────────────────────────


class TestProviderError:
    def test_is_exception(self):
        err = ProviderError("oops", 503)
        assert isinstance(err, Exception)

    def test_carries_status_code(self):
        err = ProviderError("rate limited", 429)
        assert err.status_code == 429

    def test_carries_retry_after_ms(self):
        err = ProviderError("too many", 429, retry_after_ms=1000)
        assert err.retry_after_ms == 1000

    def test_retry_after_ms_optional(self):
        err = ProviderError("server error", 500)
        assert err.retry_after_ms is None


# ─── Handler Factories ────────────────────────────────────────────────────────


class TestCreateStaticHandler:
    @pytest.mark.asyncio
    async def test_always_returns_configured_content(self):
        handler = create_static_handler("fallback response")
        res = await handler(LLMRequest(prompt="anything"))
        assert res.content == "fallback response"
        assert res.model == "static"
        assert res.finish_reason == "static_fallback"


class TestCreateCacheHandler:
    @pytest.mark.asyncio
    async def test_throws_on_cache_miss(self):
        h = create_cache_handler()
        with pytest.raises(ValueError, match="Cache miss"):
            await h["handler"](LLMRequest(prompt="unseen"))

    @pytest.mark.asyncio
    async def test_returns_cached_content_after_populate(self):
        h = create_cache_handler()
        h["populate"]("my prompt", "my cached response")
        res = await h["handler"](LLMRequest(prompt="my prompt"))
        assert res.content == "my cached response"
        assert res.finish_reason == "cache_hit"

    @pytest.mark.asyncio
    async def test_clear_empties_cache(self):
        h = create_cache_handler()
        h["populate"]("q", "a")
        h["clear"]()
        with pytest.raises(ValueError, match="Cache miss"):
            await h["handler"](LLMRequest(prompt="q"))

    def test_tracks_size_accurately(self):
        h = create_cache_handler()
        assert h["size"]() == 0
        h["populate"]("a", "response a")
        assert h["size"]() == 1
        h["clear"]()
        assert h["size"]() == 0


class TestCreateRuleBasedHandler:
    @pytest.mark.asyncio
    async def test_matches_first_rule(self):
        handler = create_rule_based_handler([
            (re.compile(r"hello", re.IGNORECASE), "Hi there!"),
            (re.compile(r".*"), "Fallback"),
        ])
        res = await handler(LLMRequest(prompt="hello world"))
        assert res.content == "Hi there!"
        assert res.finish_reason == "rule_match"

    @pytest.mark.asyncio
    async def test_falls_through_to_second_rule(self):
        handler = create_rule_based_handler([
            (re.compile(r"hello", re.IGNORECASE), "Hi there!"),
            (re.compile(r"help", re.IGNORECASE), "Here to help"),
        ])
        res = await handler(LLMRequest(prompt="I need help"))
        assert res.content == "Here to help"

    @pytest.mark.asyncio
    async def test_raises_when_no_rule_matches(self):
        handler = create_rule_based_handler([
            (re.compile(r"hello", re.IGNORECASE), "Hi!"),
        ])
        with pytest.raises(ValueError, match="No matching rule"):
            await handler(LLMRequest(prompt="xyz123"))


class TestCreateSequenceProvider:
    @pytest.mark.asyncio
    async def test_returns_responses_in_order_and_cycles(self):
        p = create_sequence_provider(["a", "b", "c"], latency_ms=0)
        r1 = await p.call(REQ)
        r2 = await p.call(REQ)
        r3 = await p.call(REQ)
        r4 = await p.call(REQ)  # cycles
        assert r1.content == "a"
        assert r2.content == "b"
        assert r3.content == "c"
        assert r4.content == "a"

    @pytest.mark.asyncio
    async def test_tracks_call_index(self):
        p = create_sequence_provider(["x", "y"], latency_ms=0)
        assert p.call_index == 0
        await p.call(REQ)
        assert p.call_index == 1

    @pytest.mark.asyncio
    async def test_reset_restarts_sequence(self):
        p = create_sequence_provider(["first", "second"], latency_ms=0)
        await p.call(REQ)
        p.reset()
        res = await p.call(REQ)
        assert res.content == "first"

    def test_raises_on_empty_responses(self):
        with pytest.raises(ValueError, match="non-empty"):
            create_sequence_provider([])


# ─── Streaming Mocks ──────────────────────────────────────────────────────────


class TestMockLLMStream:
    @pytest.mark.asyncio
    async def test_emits_token_count_chunks(self):
        chunks = []
        async for chunk in mock_llm_stream(MockStreamOptions(token_count=5, token_delay_ms=0)):
            chunks.append(chunk)
        assert len(chunks) == 5

    @pytest.mark.asyncio
    async def test_uses_custom_token_content(self):
        chunks = []
        async for chunk in mock_llm_stream(
            MockStreamOptions(token_count=3, token_delay_ms=0, token_content="word ")
        ):
            chunks.append(chunk)
        assert chunks == ["word ", "word ", "word "]

    @pytest.mark.asyncio
    async def test_raises_at_error_after_tokens(self):
        chunks = []
        with pytest.raises(RuntimeError, match="injected error at token 3"):
            async for chunk in mock_llm_stream(
                MockStreamOptions(token_count=10, token_delay_ms=0, error_after_tokens=3)
            ):
                chunks.append(chunk)
        assert len(chunks) == 3

    @pytest.mark.asyncio
    async def test_stops_on_stop_event(self):
        stop_event = asyncio.Event()
        chunks = []

        async def consume():
            nonlocal chunks
            async for chunk in mock_llm_stream(
                MockStreamOptions(token_count=100, token_delay_ms=5),
                stop_event=stop_event,
            ):
                chunks.append(chunk)
                if len(chunks) == 3:
                    stop_event.set()

        await consume()
        # Should stop shortly after set — well under 100 tokens
        assert len(chunks) < 20


class TestMockSlowConsumer:
    def test_returns_true_when_buffer_has_capacity(self):
        consumer = MockSlowConsumer(buffer_capacity=5, drain_delay_ms=0)
        can_write = consumer.write("chunk")
        assert can_write is True
        assert consumer.written == ["chunk"]

    def test_returns_false_when_buffer_reaches_capacity(self):
        consumer = MockSlowConsumer(buffer_capacity=2, drain_delay_ms=0)
        consumer.write("a")
        backpressure = consumer.write("b")
        assert backpressure is False

    @pytest.mark.asyncio
    async def test_drain_fires_and_allows_writes(self):
        loop = asyncio.get_event_loop()
        consumer = MockSlowConsumer(buffer_capacity=2, drain_delay_ms=10)
        consumer.write("a")
        consumer.write("b")  # triggers backpressure

        drained = asyncio.Event()
        consumer.on_drain(drained.set)

        await asyncio.wait_for(drained.wait(), timeout=1.0)

        can_write = consumer.write("c")
        assert can_write is True
        assert consumer.drain_count > 0

    def test_tracks_all_written_chunks(self):
        consumer = MockSlowConsumer(buffer_capacity=10, drain_delay_ms=0)
        consumer.write("x")
        consumer.write("y")
        consumer.write("z")
        assert consumer.written == ["x", "y", "z"]

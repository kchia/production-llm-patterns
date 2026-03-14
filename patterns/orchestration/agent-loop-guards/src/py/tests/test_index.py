"""
Tests for Agent Loop Guards — Python Implementation

Covers the same three categories as TypeScript:
- Unit tests: config defaults, natural completion, token tracking
- Failure mode tests: one per failure mode from README
- Integration tests: full agent run, loop simulation, concurrency
"""

from __future__ import annotations

import asyncio
import threading

import pytest

from .. import AgentLoopGuard
from ..mock_provider import MockProvider, MockProviderConfig
from .._types import (
    AgentResult,
    HaltReason,
    LLMResponse,
    LoopContext,
    LoopGuardConfig,
    Message,
    ToolCall,
    ToolDefinition,
)

# ---------- Shared fixtures ----------

TOOLS = [
    ToolDefinition(name="search", description="Search the web", parameters={"query": {"type": "string"}}),
    ToolDefinition(name="calculate", description="Do math", parameters={"expression": {"type": "string"}}),
]


async def dummy_executor(name: str, args: dict) -> dict:
    return {"result": "ok"}


async def failing_executor(name: str, args: dict) -> dict:
    raise RuntimeError("Tool execution failed")


def make_tool_response(name: str, args: dict, tokens: int = 100) -> LLMResponse:
    return LLMResponse(tool_calls=[ToolCall(name=name, arguments=args)], tokens_used=tokens)


def make_done_response(text: str = "Done", tokens: int = 50) -> LLMResponse:
    return LLMResponse(text=text, tool_calls=[], tokens_used=tokens)


# ---------- Unit Tests ----------


class TestUnitDefaults:
    @pytest.mark.asyncio
    async def test_uses_default_config(self):
        guard = AgentLoopGuard()
        assert guard.config.max_turns == 25
        assert guard.config.max_tokens == 100_000
        assert guard.config.max_duration_ms == 120_000
        assert guard.config.max_repeated_calls == 3
        assert guard.config.convergence_window == 5

    @pytest.mark.asyncio
    async def test_keyword_overrides(self):
        guard = AgentLoopGuard(max_turns=10)
        assert guard.config.max_turns == 10
        assert guard.config.max_tokens == 100_000  # default preserved

    @pytest.mark.asyncio
    async def test_invalid_kwarg_raises(self):
        with pytest.raises(TypeError, match="Unknown config parameter"):
            AgentLoopGuard(nonexistent_param=42)


class TestUnitNaturalCompletion:
    @pytest.mark.asyncio
    async def test_completes_naturally(self):
        provider = MockProvider(MockProviderConfig(
            scripted_responses=[make_done_response("Hello!")],
            latency_ms=0, latency_jitter_ms=0,
        ))
        guard = AgentLoopGuard()
        result = await guard.run(
            provider, TOOLS, dummy_executor,
            [Message(role="user", content="hi")],
        )
        assert result.halted is False
        assert result.response == "Hello!"
        assert result.context.turn_count == 1


class TestUnitTokenTracking:
    @pytest.mark.asyncio
    async def test_tracks_tokens_across_turns(self):
        provider = MockProvider(MockProviderConfig(
            scripted_responses=[
                make_tool_response("search", {"query": "a"}, 200),
                make_tool_response("calculate", {"expression": "1+1"}, 300),
                make_done_response("Result", 100),
            ],
            latency_ms=0, latency_jitter_ms=0,
        ))
        guard = AgentLoopGuard()
        result = await guard.run(
            provider, TOOLS, dummy_executor,
            [Message(role="user", content="task")],
        )
        assert result.halted is False
        assert result.context.total_tokens == 600
        assert result.context.turn_count == 3


class TestUnitToolErrors:
    @pytest.mark.asyncio
    async def test_handles_tool_errors_gracefully(self):
        provider = MockProvider(MockProviderConfig(
            scripted_responses=[
                make_tool_response("search", {"query": "test"}),
                make_done_response("Done despite error"),
            ],
            latency_ms=0, latency_jitter_ms=0,
        ))
        guard = AgentLoopGuard()
        result = await guard.run(
            provider, TOOLS, failing_executor,
            [Message(role="user", content="test")],
        )
        assert result.halted is False
        assert result.response == "Done despite error"


# ---------- Failure Mode Tests ----------


class TestFailureMaxTurns:
    @pytest.mark.asyncio
    async def test_halts_at_max_turns(self):
        responses = [make_tool_response("search", {"query": f"q{i}"}) for i in range(10)]
        provider = MockProvider(MockProviderConfig(
            scripted_responses=responses,
            latency_ms=0, latency_jitter_ms=0,
        ))
        guard = AgentLoopGuard(max_turns=5)
        result = await guard.run(
            provider, TOOLS, dummy_executor,
            [Message(role="user", content="go")],
        )
        assert result.halted is True
        assert result.halt_reason == "max_turns"
        assert result.context.turn_count == 5


class TestFailureMaxTokens:
    @pytest.mark.asyncio
    async def test_halts_on_token_budget(self):
        responses = [make_tool_response("search", {"query": f"q{i}"}, 500) for i in range(100)]
        provider = MockProvider(MockProviderConfig(
            scripted_responses=responses,
            latency_ms=0, latency_jitter_ms=0,
        ))
        guard = AgentLoopGuard(max_turns=100, max_tokens=2000)
        result = await guard.run(
            provider, TOOLS, dummy_executor,
            [Message(role="user", content="go")],
        )
        assert result.halted is True
        assert result.halt_reason == "max_tokens"
        assert result.context.total_tokens >= 2000


class TestFailureRepeatedCalls:
    @pytest.mark.asyncio
    async def test_detects_repeated_calls(self):
        same_call = make_tool_response("search", {"query": "stuck"})
        provider = MockProvider(MockProviderConfig(
            scripted_responses=[same_call] * 4,
            latency_ms=0, latency_jitter_ms=0,
        ))
        guard = AgentLoopGuard(max_turns=20, max_repeated_calls=3)
        result = await guard.run(
            provider, TOOLS, dummy_executor,
            [Message(role="user", content="go")],
        )
        assert result.halted is True
        assert result.halt_reason == "repeated_calls"

    @pytest.mark.asyncio
    async def test_no_false_positive_on_different_args(self):
        provider = MockProvider(MockProviderConfig(
            scripted_responses=[
                make_tool_response("search", {"query": "a"}),
                make_tool_response("search", {"query": "b"}),
                make_tool_response("search", {"query": "c"}),
                make_done_response("Found it"),
            ],
            latency_ms=0, latency_jitter_ms=0,
        ))
        guard = AgentLoopGuard(max_turns=20, max_repeated_calls=3)
        result = await guard.run(
            provider, TOOLS, dummy_executor,
            [Message(role="user", content="go")],
        )
        assert result.halted is False
        assert result.response == "Found it"


class TestFailureCycleDetection:
    @pytest.mark.asyncio
    async def test_detects_cyclic_patterns(self):
        call_a = make_tool_response("search", {"query": "x"})
        call_b = make_tool_response("calculate", {"expression": "1+1"})
        call_c = make_tool_response("search", {"query": "y"})
        provider = MockProvider(MockProviderConfig(
            scripted_responses=[call_a, call_b, call_c, call_a, call_b, call_c],
            latency_ms=0, latency_jitter_ms=0,
        ))
        guard = AgentLoopGuard(max_turns=20, convergence_window=3, max_repeated_calls=10)
        result = await guard.run(
            provider, TOOLS, dummy_executor,
            [Message(role="user", content="go")],
        )
        assert result.halted is True
        assert result.halt_reason == "no_progress"


class TestFailureDurationTimeout:
    @pytest.mark.asyncio
    async def test_halts_on_duration(self):
        responses = [make_tool_response("search", {"query": f"q{i}"}) for i in range(100)]
        provider = MockProvider(MockProviderConfig(
            scripted_responses=responses,
            latency_ms=100,
            latency_jitter_ms=0,
        ))
        guard = AgentLoopGuard(max_turns=100, max_duration_ms=250)
        result = await guard.run(
            provider, TOOLS, dummy_executor,
            [Message(role="user", content="go")],
        )
        assert result.halted is True
        assert result.halt_reason == "max_duration"


class TestFailureAbortSignal:
    @pytest.mark.asyncio
    async def test_halts_on_abort_event(self):
        responses = [make_tool_response("search", {"query": f"q{i}"}) for i in range(10)]
        provider = MockProvider(MockProviderConfig(
            scripted_responses=responses,
            latency_ms=20,
            latency_jitter_ms=0,
        ))
        abort = threading.Event()

        # Set abort after a short delay from a separate thread
        def fire_abort():
            import time
            time.sleep(0.05)
            abort.set()

        threading.Thread(target=fire_abort, daemon=True).start()

        guard = AgentLoopGuard(max_turns=100)
        result = await guard.run(
            provider, TOOLS, dummy_executor,
            [Message(role="user", content="go")],
            abort_event=abort,
        )
        assert result.halted is True
        assert result.halt_reason == "abort_signal"


class TestFailureSilentDegradation:
    @pytest.mark.asyncio
    async def test_on_halt_callback_fires(self):
        halt_log: list[tuple[HaltReason, LoopContext]] = []

        def record_halt(reason: HaltReason, ctx: LoopContext) -> None:
            # Copy context to avoid mutation after capture
            halt_log.append((reason, LoopContext(
                turn_count=ctx.turn_count,
                total_tokens=ctx.total_tokens,
                elapsed_ms=ctx.elapsed_ms,
                tool_call_history=list(ctx.tool_call_history),
                halt_reason=ctx.halt_reason,
            )))

        same_call = make_tool_response("search", {"query": "stuck"})
        provider = MockProvider(MockProviderConfig(
            scripted_responses=[same_call] * 3,
            latency_ms=0, latency_jitter_ms=0,
        ))
        guard = AgentLoopGuard(
            config=LoopGuardConfig(max_turns=20, max_repeated_calls=3, on_halt=record_halt)
        )
        await guard.run(
            provider, TOOLS, dummy_executor,
            [Message(role="user", content="go")],
        )

        assert len(halt_log) == 1
        reason, ctx = halt_log[0]
        assert reason == "repeated_calls"
        assert ctx.turn_count == 3
        assert len(ctx.tool_call_history) == 3


# ---------- Integration Tests ----------


class TestIntegrationFullRun:
    @pytest.mark.asyncio
    async def test_multi_step_agent_task(self):
        provider = MockProvider(MockProviderConfig(
            scripted_responses=[
                make_tool_response("search", {"query": "weather in NYC"}),
                make_tool_response("calculate", {"expression": "72 - 32"}),
                make_done_response("The temperature in NYC is 72°F."),
            ],
            latency_ms=0, latency_jitter_ms=0,
        ))

        tool_log: list[tuple[str, dict]] = []

        async def tracking_executor(name: str, args: dict) -> dict:
            tool_log.append((name, args))
            if name == "search":
                return {"weather": "72°F"}
            if name == "calculate":
                return {"result": 40}
            return {"result": "unknown"}

        guard = AgentLoopGuard(max_turns=10)
        result = await guard.run(
            provider, TOOLS, tracking_executor,
            [
                Message(role="system", content="You are a helpful assistant."),
                Message(role="user", content="Weather in NYC?"),
            ],
        )

        assert result.halted is False
        assert result.context.turn_count == 3
        assert len(tool_log) == 2
        assert tool_log[0][0] == "search"
        assert tool_log[1][0] == "calculate"


class TestIntegrationLoopSimulation:
    @pytest.mark.asyncio
    async def test_mock_loop_detected(self):
        provider = MockProvider(MockProviderConfig(
            simulate_loop=True,
            loop_tool_call=ToolCall(name="search", arguments={"query": "same thing"}),
            loop_start_after=0,
            latency_ms=0,
            latency_jitter_ms=0,
        ))
        guard = AgentLoopGuard(max_turns=20, max_repeated_calls=3)
        result = await guard.run(
            provider, TOOLS, dummy_executor,
            [Message(role="user", content="search")],
        )
        assert result.halted is True
        assert result.halt_reason == "repeated_calls"
        assert result.context.turn_count == 3


class TestIntegrationConcurrent:
    @pytest.mark.asyncio
    async def test_independent_guard_instances(self):
        provider1 = MockProvider(MockProviderConfig(
            scripted_responses=[
                make_tool_response("search", {"query": "task1"}),
                make_done_response("Result 1"),
            ],
            latency_ms=5, latency_jitter_ms=0,
        ))
        provider2 = MockProvider(MockProviderConfig(
            simulate_loop=True,
            loop_tool_call=ToolCall(name="search", arguments={"query": "loop"}),
            loop_start_after=0,
            latency_ms=5, latency_jitter_ms=0,
        ))

        guard1 = AgentLoopGuard(max_turns=10)
        guard2 = AgentLoopGuard(max_turns=10, max_repeated_calls=3)

        result1, result2 = await asyncio.gather(
            guard1.run(provider1, TOOLS, dummy_executor, [Message(role="user", content="task1")]),
            guard2.run(provider2, TOOLS, dummy_executor, [Message(role="user", content="task2")]),
        )

        assert result1.halted is False
        assert result1.response == "Result 1"
        assert result2.halted is True
        assert result2.halt_reason == "repeated_calls"

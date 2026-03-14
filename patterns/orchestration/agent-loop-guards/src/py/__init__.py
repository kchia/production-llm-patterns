"""
Agent Loop Guards — Core Implementation

Wraps an agent's tool-calling loop with three enforcement layers:
1. Budget Gate — hard limits on turns, tokens, and wall-clock time
2. Convergence Detector — repetition and progress analysis
3. Completion Check — natural termination detection
"""

from __future__ import annotations

import hashlib
import json
import time
from threading import Event
from typing import Any

from ._types import (
    AgentResult,
    HaltReason,
    LLMResponse,
    LoopContext,
    LoopGuardConfig,
    Message,
    ToolCall,
    ToolDefinition,
    default_config,
)


class AgentLoopGuard:
    """Guards an agent's tool-calling loop against runaway execution."""

    def __init__(self, config: LoopGuardConfig | None = None, **overrides: Any) -> None:
        # Accept either a full config or keyword overrides on defaults.
        # Keyword overrides let callers write AgentLoopGuard(max_turns=10)
        # instead of AgentLoopGuard(LoopGuardConfig(max_turns=10)).
        if config is not None:
            self._config = config
        else:
            base = default_config()
            for key, value in overrides.items():
                if hasattr(base, key):
                    setattr(base, key, value)
                else:
                    raise TypeError(f"Unknown config parameter: {key}")
            self._config = base

    async def run(
        self,
        provider: Any,  # LLMProvider protocol
        tools: list[ToolDefinition],
        tool_executor: Any,  # ToolExecutor callable
        messages: list[Message],
        abort_event: Event | None = None,
    ) -> AgentResult:
        """Run the guarded agent loop.

        Args:
            provider: LLM provider implementing the call() async method.
            tools: Tool definitions available to the agent.
            tool_executor: Async callable (name, args) -> result.
            messages: Initial messages (system prompt + user input).
            abort_event: Optional threading.Event for external cancellation.
                         Uses threading.Event instead of asyncio primitives
                         because abort signals typically come from a different
                         thread (e.g., HTTP request handler, signal handler).
        """
        ctx = LoopContext()

        # time.monotonic avoids wall-clock skew in distributed environments
        start = time.monotonic()
        conversation: list[Message] = list(messages)
        last_response: LLMResponse | None = None

        while True:
            ctx.elapsed_ms = (time.monotonic() - start) * 1000

            # --- Layer 1: Budget Gate ---
            halt = self._check_budget(ctx, abort_event)
            if halt:
                return self._halt(halt, ctx, last_response)

            # --- Layer 2: LLM Call ---
            try:
                response = await provider.call(conversation, tools)
            except Exception as exc:
                ctx.halt_reason = "max_turns"
                return AgentResult(
                    response=f"Agent halted due to LLM error: {exc}",
                    halted=True,
                    halt_reason="max_turns",
                    context=ctx,
                )

            ctx.turn_count += 1
            ctx.total_tokens += response.tokens_used
            last_response = response

            # --- Layer 3: Completion Check (no tool calls = done) ---
            if not response.tool_calls:
                ctx.elapsed_ms = (time.monotonic() - start) * 1000
                return AgentResult(
                    response=response.text or "",
                    halted=False,
                    context=ctx,
                )

            # --- Layer 4: Convergence Check (before executing tools) ---
            ctx.tool_call_history.extend(response.tool_calls)

            convergence_halt = self._check_convergence(ctx)
            if convergence_halt:
                return self._halt(convergence_halt, ctx, last_response)

            # --- Layer 5: Tool Execution ---
            for tc in response.tool_calls:
                if abort_event and abort_event.is_set():
                    return self._halt("abort_signal", ctx, last_response)

                try:
                    result = await tool_executor(tc.name, tc.arguments)
                except Exception as exc:
                    result = {"error": str(exc)}

                conversation.append(
                    Message(
                        role="assistant",
                        content=json.dumps({"tool_calls": [{"name": tc.name, "arguments": tc.arguments}]}),
                    )
                )
                conversation.append(
                    Message(role="tool", content=json.dumps(result), tool_call_id=tc.name)
                )

            if response.text:
                conversation.append(Message(role="assistant", content=response.text))

    def _check_budget(
        self, ctx: LoopContext, abort_event: Event | None
    ) -> HaltReason | None:
        if abort_event and abort_event.is_set():
            return "abort_signal"
        if ctx.turn_count >= self._config.max_turns:
            return "max_turns"
        if ctx.total_tokens >= self._config.max_tokens:
            return "max_tokens"
        if ctx.elapsed_ms >= self._config.max_duration_ms:
            return "max_duration"
        return None

    def _check_convergence(self, ctx: LoopContext) -> HaltReason | None:
        """Check for convergence failures — repeated tool calls or cycles.

        Uses tool call identity (name + arguments hash) rather than full
        response text, because response text varies even in loops (the model
        rephrases), but identical tool arguments are a strong signal.
        """
        history = ctx.tool_call_history

        # Consecutive identical tool calls
        n = self._config.max_repeated_calls
        if len(history) >= n:
            recent_hashes = [self._hash_tool_call(tc) for tc in history[-n:]]
            if all(h == recent_hashes[0] for h in recent_hashes):
                return "repeated_calls"

        # Cycle detection: last N calls match the N calls before them
        w = self._config.convergence_window
        if len(history) >= w * 2:
            recent = [self._hash_tool_call(tc) for tc in history[-w:]]
            prior = [self._hash_tool_call(tc) for tc in history[-w * 2 : -w]]
            if recent == prior:
                return "no_progress"

        return None

    @staticmethod
    def _hash_tool_call(tc: ToolCall) -> str:
        """Hash a tool call for deduplication.

        Uses SHA-256 truncated to 16 hex chars — same approach as the TS
        implementation for consistency, but using hashlib instead of crypto.
        """
        payload = json.dumps({"name": tc.name, "args": tc.arguments}, sort_keys=True)
        return hashlib.sha256(payload.encode()).hexdigest()[:16]

    def _halt(
        self,
        reason: HaltReason,
        ctx: LoopContext,
        last_response: LLMResponse | None,
    ) -> AgentResult:
        ctx.halt_reason = reason

        if self._config.on_halt:
            self._config.on_halt(reason, ctx)

        return AgentResult(
            response=last_response.text if last_response and last_response.text else f"Agent halted: {reason}",
            halted=True,
            halt_reason=reason,
            context=ctx,
        )

    @property
    def config(self) -> LoopGuardConfig:
        """Return current config (for inspection/testing)."""
        return self._config

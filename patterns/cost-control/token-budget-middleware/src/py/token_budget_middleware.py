"""
Token Budget Middleware — Core Implementation

Wraps any LLM provider call with token budget enforcement.
Tracks cumulative spend across configurable time windows,
rejects or throttles requests that would exceed limits.

Framework-agnostic. No external dependencies.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional

from budget_types import (
    BudgetContext,
    BudgetedResponse,
    BudgetExceededError,
    BudgetScope,
    BudgetUsage,
    ExceededStrategy,
    LLMRequest,
    LLMResponse,
)


@dataclass
class _BudgetWindow:
    """Internal state for a single budget window."""

    tokens_used: int = 0
    window_start: float = 0.0
    warning_fired: bool = False


def _default_estimate_tokens(text: str) -> int:
    """~4 characters per token for English text. Slightly overestimates for safety."""
    return math.ceil(len(text) / 4)


# Provider callable type: async function from LLMRequest -> LLMResponse
ProviderFn = Callable[[LLMRequest], Awaitable[LLMResponse]]


class TokenBudgetMiddleware:
    """
    Pre-call estimation + post-call accounting middleware for LLM token budgets.

    Wraps a provider function and enforces per-key, window-based token limits.
    Supports hierarchical budget keys (global -> team -> user -> request).
    """

    def __init__(
        self,
        *,
        provider: ProviderFn,
        max_tokens: int = 1_000_000,
        window_seconds: float = 86_400,
        budget_scope: BudgetScope = BudgetScope.GLOBAL,
        warning_threshold: float = 0.8,
        on_budget_exceeded: ExceededStrategy = ExceededStrategy.REJECT,
        on_warning: Optional[Callable[[BudgetUsage], None]] = None,
        estimate_tokens: Optional[Callable[[str], int]] = None,
    ) -> None:
        self._provider = provider
        self._max_tokens = max_tokens
        # Store internally as seconds (Python-idiomatic vs. TS milliseconds)
        self._window_seconds = window_seconds
        self._budget_scope = budget_scope
        self._warning_threshold = warning_threshold
        self._exceeded_strategy = on_budget_exceeded
        self._on_warning = on_warning
        self._estimate_tokens = estimate_tokens or _default_estimate_tokens
        self._windows: dict[str, _BudgetWindow] = {}

    async def execute(
        self,
        request: LLMRequest,
        context: BudgetContext | None = None,
    ) -> BudgetedResponse:
        """
        Execute an LLM request with budget enforcement.

        1. Estimate input tokens
        2. Check if the request fits within the budget
        3. Forward to the provider if allowed
        4. Record actual usage from the response
        """
        ctx = context or BudgetContext()
        estimated_input_tokens = self._estimate_tokens(request.prompt)

        window = self._get_or_create_window(ctx.budget_key)

        # Pre-call budget check
        projected_usage = window.tokens_used + estimated_input_tokens
        if projected_usage > self._max_tokens:
            usage = self._build_usage(ctx.budget_key, window)
            if self._exceeded_strategy == ExceededStrategy.REJECT:
                raise BudgetExceededError(usage, estimated_input_tokens)
            # warn-only: fall through

        # Forward to provider
        response = await self._provider(request)

        # Post-call: record actual tokens
        actual_tokens = response.tokens_used
        window.tokens_used += actual_tokens

        # Check warning threshold
        warning_triggered = False
        utilization = window.tokens_used / self._max_tokens
        if utilization >= self._warning_threshold and not window.warning_fired:
            window.warning_fired = True
            warning_triggered = True
            if self._on_warning is not None:
                self._on_warning(self._build_usage(ctx.budget_key, window))

        # Propagate to parent keys for hierarchical enforcement
        if ctx.parent_keys:
            for parent_key in ctx.parent_keys:
                parent_window = self._get_or_create_window(parent_key)
                parent_window.tokens_used += actual_tokens

                parent_util = parent_window.tokens_used / self._max_tokens
                if parent_util >= self._warning_threshold and not parent_window.warning_fired:
                    parent_window.warning_fired = True
                    if self._on_warning is not None:
                        self._on_warning(self._build_usage(parent_key, parent_window))

        return BudgetedResponse(
            response=response,
            usage=self._build_usage(ctx.budget_key, window),
            warning_triggered=warning_triggered,
            estimated_input_tokens=estimated_input_tokens,
            actual_tokens=actual_tokens,
        )

    def get_usage(self, budget_key: str) -> BudgetUsage:
        """Get current usage for a budget key."""
        window = self._get_or_create_window(budget_key)
        return self._build_usage(budget_key, window)

    def get_remaining_budget(self, budget_key: str) -> int:
        """Get tokens remaining in the current window for a budget key."""
        window = self._get_or_create_window(budget_key)
        return max(0, self._max_tokens - window.tokens_used)

    def reset_budget(self, budget_key: str) -> None:
        """Manually reset a budget key's window."""
        self._windows[budget_key] = _BudgetWindow(
            window_start=time.monotonic(),
        )

    def reset_all(self) -> None:
        """Reset all budget windows."""
        self._windows.clear()

    # -- Internal helpers --

    def _get_or_create_window(self, budget_key: str) -> _BudgetWindow:
        now = time.monotonic()
        existing = self._windows.get(budget_key)

        if existing is not None:
            if now - existing.window_start >= self._window_seconds:
                # Window expired — start fresh
                fresh = _BudgetWindow(window_start=now)
                self._windows[budget_key] = fresh
                return fresh
            return existing

        fresh = _BudgetWindow(window_start=now)
        self._windows[budget_key] = fresh
        return fresh

    def _build_usage(self, budget_key: str, window: _BudgetWindow) -> BudgetUsage:
        remaining = max(0, self._max_tokens - window.tokens_used)
        return BudgetUsage(
            budget_key=budget_key,
            tokens_used=window.tokens_used,
            max_tokens=self._max_tokens,
            remaining=remaining,
            utilization=window.tokens_used / self._max_tokens,
            window_start=window.window_start,
            window_end=window.window_start + self._window_seconds,
        )


__all__ = [
    "TokenBudgetMiddleware",
    "BudgetExceededError",
    "BudgetContext",
    "BudgetedResponse",
    "BudgetUsage",
    "BudgetScope",
    "ExceededStrategy",
    "LLMRequest",
    "LLMResponse",
]

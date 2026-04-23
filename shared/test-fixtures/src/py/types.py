"""
test-fixtures — Type Definitions (Python)

Canonical request/response types and error class used across all 35 pattern
mock providers. Import from here instead of defining per-pattern.

Framework-agnostic. No external dependencies.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Literal, Optional, Union


# ─── Core LLM Types ───────────────────────────────────────────────────────────


@dataclass
class LLMRequest:
    """A request to an LLM provider."""

    prompt: str
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None
    metadata: Optional[dict] = None


@dataclass
class LLMResponse:
    """
    A response from an LLM provider.

    tokens_used is the total token count (input + output).
    Patterns that need the split should use the mock's per-response token config
    and estimate input tokens from prompt length.
    """

    content: str
    tokens_used: Optional[int] = None
    model: Optional[str] = None
    finish_reason: Optional[str] = None
    latency_ms: Optional[float] = None


# ─── Provider Error ───────────────────────────────────────────────────────────


class ProviderError(Exception):
    """
    Error thrown by MockProvider on simulated failures.

    Carries an HTTP status code so patterns can distinguish retryable (429, 503)
    from non-retryable (400, 401) errors — same as real providers send.
    """

    def __init__(
        self,
        message: str,
        status_code: int,
        retry_after_ms: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.retry_after_ms = retry_after_ms

    def __repr__(self) -> str:
        return (
            f"ProviderError(status_code={self.status_code}, "
            f"retry_after_ms={self.retry_after_ms}, message={str(self)!r})"
        )


# ─── Mock Provider Config ─────────────────────────────────────────────────────

# Each entry in an error sequence is either 'success' or an HTTP status code.
ErrorSequenceEntry = Union[Literal["success"], int]


@dataclass
class MockProviderConfig:
    """Configuration for MockProvider."""

    latency_ms: int = 50
    """Simulated response latency in milliseconds. Default: 50."""

    failure_rate: float = 0.0
    """Probability of failure (0.0 – 1.0). Default: 0.0."""

    failure_status_code: int = 503
    """HTTP status code to throw on probabilistic failures. Default: 503."""

    error_message: str = "Provider unavailable"
    """Error message on failure."""

    retry_after_ms: int = 0
    """
    Retry-After delay in ms. Attached to errors when failure_status_code is 429.
    Useful for testing retry-with-budget and circuit-breaker rate-limit paths.
    """

    tokens_per_response: int = 100
    """Simulated output tokens per response. Default: 100."""

    model: str = "mock-model"
    """Model name returned in responses. Default: 'mock-model'."""

    response_content: str = ""
    """Static response content. Default: generated from prompt."""

    error_sequence: List[ErrorSequenceEntry] = field(default_factory=list)
    """
    Deterministic error sequence. Each entry is 'success' or an HTTP status
    code. Consumed in order; falls back to failure_rate after exhaustion.

    Example: ['success', 503, 'success'] → ok, error, ok, then probabilistic.
    """


# ─── Streaming Types ──────────────────────────────────────────────────────────


@dataclass
class MockStreamOptions:
    """Options for mock_llm_stream."""

    token_count: int = 100
    """Number of tokens to emit. Default: 100."""

    token_delay_ms: float = 10.0
    """Delay between tokens in ms. Default: 10 (≈100 tokens/sec)."""

    error_after_tokens: Optional[int] = None
    """If set, raise an error after emitting this many tokens."""

    token_content: str = "token "
    """Content of each emitted token chunk. Default: 'token '."""

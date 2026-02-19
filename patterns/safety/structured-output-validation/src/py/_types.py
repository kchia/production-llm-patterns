"""
Structured Output Validation — Type Definitions

Core types for the parse -> repair -> validate -> retry pipeline.
Framework-agnostic, no external dependencies.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable, Literal, Protocol, runtime_checkable

# How the output was successfully parsed.
ParseMethod = Literal["direct", "repaired", "retry"]

# Error feedback format for retry prompts.
ErrorFeedbackFormat = Literal["structured", "natural"]


@dataclass
class LLMRequest:
    """A request to an LLM provider."""

    prompt: str
    system_prompt: str | None = None
    max_tokens: int | None = None
    temperature: float | None = None
    metadata: dict[str, Any] | None = None


@dataclass
class LLMResponse:
    """A response from an LLM provider."""

    content: str
    tokens_used: int | None = None
    model: str | None = None
    finish_reason: str | None = None


# An LLM provider callable — any async function matching this signature works.
LLMProvider = Callable[[LLMRequest], Awaitable[LLMResponse]]


@runtime_checkable
class OutputSchema(Protocol):
    """
    Schema definition that the validator uses to parse and validate output.

    Implementations provide their own parsing logic — Pydantic, marshmallow,
    or hand-written validators all work as long as they implement this protocol.
    """

    def parse(self, raw: str) -> Any:
        """Parse and validate raw string. Raises SchemaValidationError on failure."""
        ...

    def to_json_schema(self) -> dict[str, Any]:
        """JSON Schema representation for including in prompts."""
        ...

    def to_prompt_instructions(self) -> str:
        """Human-readable schema description for prompt instructions."""
        ...


@dataclass
class ValidatorConfig:
    """Configuration for the OutputValidator."""

    # Maximum retry attempts after initial call. Default: 2 (so 3 total attempts).
    max_retries: int = 2

    # Whether to attempt JSON repair before retrying.
    repair: bool = True

    # Whether to strip markdown code fences before parsing.
    strip_markdown: bool = True

    # Whether to append JSON schema instructions to the prompt.
    include_schema_in_prompt: bool = True

    # How to format validation errors for model retry.
    error_feedback_format: ErrorFeedbackFormat = "structured"

    # Callback fired before each retry attempt.
    on_retry: Callable[[list[str], int], None] | None = None

    # Callback fired when all attempts are exhausted.
    on_validation_failure: Callable[[ValidationResult], None] | None = None


@dataclass
class ValidationResult:
    """The result of a validation attempt."""

    # Whether validation succeeded.
    success: bool

    # The raw LLM output string from the final attempt.
    raw: str

    # How many retry attempts were made (0 = first attempt succeeded).
    retries: int

    # Whether JSON repair was applied to get a valid result.
    repaired: bool

    # How the output was successfully parsed.
    parse_method: ParseMethod

    # Total wall-clock time for all attempts in seconds.
    total_latency_ms: float

    # The typed, validated data — present only when success is True.
    data: Any = None

    # Validation errors from the final attempt (present when success is False).
    validation_errors: list[str] = field(default_factory=list)


class SchemaValidationError(Exception):
    """Error raised when schema validation fails."""

    def __init__(self, errors: list[str]) -> None:
        self.errors = errors
        if len(errors) == 1:
            summary = errors[0]
        else:
            summary = f"{len(errors)} validation errors: {'; '.join(errors)}"
        super().__init__(summary)


class ValidationExhaustedError(Exception):
    """Error raised when all validation attempts are exhausted."""

    def __init__(self, result: ValidationResult) -> None:
        self.result = result
        error_summary = "; ".join(result.validation_errors) if result.validation_errors else "unknown error"
        super().__init__(
            f"All {result.retries + 1} validation attempts exhausted. Last errors: {error_summary}"
        )

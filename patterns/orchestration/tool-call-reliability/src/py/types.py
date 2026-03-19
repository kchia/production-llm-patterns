"""
Core types for the Tool Call Reliability pattern.
All types are framework-agnostic — no LangChain, no LlamaIndex imports.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Literal, Protocol, Sequence


class SchemaStrictness(str, Enum):
    REQUIRED_ONLY = "required-only"
    ALL = "all"


class RepairFeedbackMode(str, Enum):
    STRUCTURED = "structured"
    VERBOSE = "verbose"


class OnRepairFailure(str, Enum):
    THROW = "throw"
    RETURN_ERROR = "return-error"
    SILENT_DROP = "silent-drop"


@dataclass
class JSONSchemaProperty:
    type: Literal["string", "number", "integer", "boolean", "array", "object", "null"]
    description: str | None = None
    enum: list[Any] | None = None
    items: JSONSchemaProperty | None = None
    properties: dict[str, "JSONSchemaProperty"] | None = None
    required: list[str] | None = None
    minimum: float | None = None
    maximum: float | None = None
    min_length: int | None = None
    max_length: int | None = None


@dataclass
class ToolParameters:
    type: Literal["object"]
    properties: dict[str, JSONSchemaProperty]
    required: list[str] | None = None


@dataclass
class ToolSchema:
    name: str
    description: str
    parameters: ToolParameters


@dataclass
class RawToolCall:
    """Raw tool call as returned by the LLM provider (before validation)."""
    id: str
    name: str
    # May be a JSON string or already-parsed dict
    arguments: str | dict[str, Any]


@dataclass
class ValidationError:
    field: str
    expected: str
    received: str
    message: str


@dataclass
class ToolCallResult:
    valid: bool
    tool_name: str
    tool_call_id: str
    arguments: dict[str, Any]
    errors: list[ValidationError] | None = None
    # Number of repair attempts made before this result
    repair_attempts: int = 0


@dataclass
class Message:
    role: Literal["system", "user", "assistant", "tool"]
    content: str
    tool_call_id: str | None = None
    tool_calls: list[RawToolCall] | None = None


@dataclass
class ValidatorConfig:
    # Maximum number of repair round-trips with the LLM. Default: 2
    max_repair_attempts: int = 2
    # Reject tool calls for names not in provided schemas. Default: True
    strict_allowlist: bool = True
    # Whether to validate only required fields, or all defined fields. Default: REQUIRED_ONLY
    schema_strictness: SchemaStrictness = SchemaStrictness.REQUIRED_ONLY
    # How to convey validation errors back to the model. Default: STRUCTURED
    repair_feedback_mode: RepairFeedbackMode = RepairFeedbackMode.STRUCTURED
    # What to do when all repair attempts fail. Default: THROW
    on_repair_failure: OnRepairFailure = OnRepairFailure.THROW


class LLMProvider(Protocol):
    async def chat(
        self,
        messages: list[Message],
        tools: list[ToolSchema],
    ) -> Message: ...

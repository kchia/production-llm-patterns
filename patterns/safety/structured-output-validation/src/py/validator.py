"""
Structured Output Validation — Core Implementation

Parse -> Repair -> Validate -> Retry pipeline for LLM structured output.
Framework-agnostic. No provider-specific imports.

The validator wraps any LLM provider call and ensures the output conforms
to a schema. On failure, it attempts JSON repair (sub-millisecond), then
falls back to retry with error feedback (full round-trip).
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from typing import Any, Generic, TypeVar

try:
    from ._types import (
        ErrorFeedbackFormat,
        LLMProvider,
        LLMRequest,
        OutputSchema,
        ParseMethod,
        SchemaValidationError,
        ValidationExhaustedError,
        ValidationResult,
        ValidatorConfig,
    )
except ImportError:
    from _types import (
        ErrorFeedbackFormat,
        LLMProvider,
        LLMRequest,
        OutputSchema,
        ParseMethod,
        SchemaValidationError,
        ValidationExhaustedError,
        ValidationResult,
        ValidatorConfig,
    )

T = TypeVar("T")

__all__ = [
    "OutputValidator",
    "JsonObjectSchema",
    "FieldDef",
    "strip_markdown_fences",
    "extract_json",
    "repair_json",
]


# --- JSON Repair ---


def strip_markdown_fences(raw: str) -> str:
    """
    Strip markdown code fences from LLM output.
    Models commonly wrap JSON in ```json ... ``` blocks.
    """
    trimmed = raw.strip()
    match = re.match(r"^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```$", trimmed)
    return match.group(1).strip() if match else trimmed


def extract_json(raw: str) -> str:
    """
    Extract JSON from text that contains prose around it.
    Finds the first complete JSON object or array in the string.
    """
    trimmed = raw.strip()

    # Already starts with { or [ — try as-is
    if trimmed.startswith("{") or trimmed.startswith("["):
        return trimmed

    # Find first { or [ and extract to the matching closing bracket
    obj_start = trimmed.find("{")
    arr_start = trimmed.find("[")

    if obj_start == -1 and arr_start == -1:
        return trimmed

    if obj_start == -1:
        start, opener, closer = arr_start, "[", "]"
    elif arr_start == -1:
        start, opener, closer = obj_start, "{", "}"
    elif obj_start < arr_start:
        start, opener, closer = obj_start, "{", "}"
    else:
        start, opener, closer = arr_start, "[", "]"

    # Walk forward tracking brace depth, respecting strings
    depth = 0
    in_string = False
    escape = False

    for i in range(start, len(trimmed)):
        char = trimmed[i]

        if escape:
            escape = False
            continue
        if char == "\\" and in_string:
            escape = True
            continue
        if char == '"':
            in_string = not in_string
            continue
        if in_string:
            continue

        if char == opener:
            depth += 1
        if char == closer:
            depth -= 1
            if depth == 0:
                return trimmed[start : i + 1]

    # Unbalanced — return from start to end (repair may fix it)
    return trimmed[start:]


def repair_json(raw: str) -> str:
    """
    Attempt lightweight JSON repair for common LLM output issues.
    Handles: trailing commas, missing closing braces/brackets, unbalanced nesting.
    """
    text = raw.strip()

    # Remove trailing commas before } or ]
    text = re.sub(r",\s*([\]}])", r"\1", text)

    # Remove trailing comma at end of string (before we append closers)
    text = re.sub(r",\s*$", "", text)

    # Track the order of unmatched openers so we close them in reverse order
    open_stack: list[str] = []
    in_string = False
    escape = False

    for char in text:
        if escape:
            escape = False
            continue
        if char == "\\" and in_string:
            escape = True
            continue
        if char == '"':
            in_string = not in_string
            continue
        if in_string:
            continue

        if char in ("{", "["):
            open_stack.append(char)
        elif char == "}":
            if open_stack and open_stack[-1] == "{":
                open_stack.pop()
        elif char == "]":
            if open_stack and open_stack[-1] == "[":
                open_stack.pop()

    # Close unmatched openers in reverse order
    while open_stack:
        opener = open_stack.pop()
        text += "}" if opener == "{" else "]"

    return text


# --- Error Feedback Formatting ---


def _format_error_feedback(errors: list[str], fmt: ErrorFeedbackFormat) -> str:
    """Format validation errors for feeding back to the model on retry."""
    if fmt == "structured":
        return "\n".join([
            "Your previous response had validation errors:",
            json.dumps(errors, indent=2),
            "Please fix these errors and return valid JSON matching the schema.",
        ])

    # Natural prose format
    error_list = "\n".join(f"{i + 1}. {e}" for i, e in enumerate(errors))
    return "\n".join([
        "Your previous response didn't match the expected format.",
        error_list,
        "Please try again with valid JSON matching the schema.",
    ])


# --- Output Validator ---


class OutputValidator:
    """
    OutputValidator — the core abstraction.

    Wraps an LLM provider call in a parse -> repair -> validate -> retry loop.
    Schema defines what valid output looks like. Every result carries metadata
    about how it was obtained (direct parse, repair, or retry).
    """

    def __init__(self, schema: OutputSchema, config: ValidatorConfig | None = None) -> None:
        self._schema = schema
        self._config = config or ValidatorConfig()

    async def execute(self, provider: LLMProvider, request: LLMRequest) -> ValidationResult:
        """
        Call the LLM provider and validate the output against the schema.

        Attempts: parse -> repair (if enabled) -> retry with error feedback.
        Returns a ValidationResult with metadata about the process.
        Raises ValidationExhaustedError if all attempts fail.
        """
        start_time = time.perf_counter()
        cfg = self._config

        # Augment prompt with schema instructions if configured
        augmented_request = self._augment_request(request) if cfg.include_schema_in_prompt else request

        last_errors: list[str] = []
        last_raw = ""
        current_request = augmented_request

        for attempt in range(cfg.max_retries + 1):
            is_retry = attempt > 0

            if is_retry:
                if cfg.on_retry:
                    cfg.on_retry(last_errors, attempt)
                current_request = self._augment_with_feedback(augmented_request, last_errors, last_raw)

            # Call the LLM provider
            response = await provider(current_request)
            last_raw = response.content

            # Step 1: Pre-process (strip markdown, extract JSON)
            processed = last_raw
            if cfg.strip_markdown:
                processed = strip_markdown_fences(processed)
            processed = extract_json(processed)

            # Step 2: Try direct parse + validate
            try:
                data = self._schema.parse(processed)
                elapsed_ms = (time.perf_counter() - start_time) * 1000
                return ValidationResult(
                    success=True,
                    data=data,
                    raw=last_raw,
                    retries=attempt,
                    repaired=False,
                    parse_method="retry" if is_retry else "direct",
                    total_latency_ms=elapsed_ms,
                )
            except (SchemaValidationError, Exception) as err:
                # Direct parse failed — try repair if enabled
                if cfg.repair:
                    repaired = repair_json(processed)
                    if repaired != processed:
                        try:
                            data = self._schema.parse(repaired)
                            elapsed_ms = (time.perf_counter() - start_time) * 1000
                            return ValidationResult(
                                success=True,
                                data=data,
                                raw=last_raw,
                                retries=attempt,
                                repaired=True,
                                parse_method="repaired",
                                total_latency_ms=elapsed_ms,
                            )
                        except Exception:
                            pass  # Repair didn't help — fall through to retry

                # Collect errors for next retry attempt
                if isinstance(err, SchemaValidationError):
                    last_errors = err.errors
                else:
                    last_errors = [str(err)]

        # All attempts exhausted
        elapsed_ms = (time.perf_counter() - start_time) * 1000
        result = ValidationResult(
            success=False,
            raw=last_raw,
            retries=cfg.max_retries,
            repaired=False,
            validation_errors=last_errors,
            parse_method="retry",
            total_latency_ms=elapsed_ms,
        )

        if cfg.on_validation_failure:
            cfg.on_validation_failure(result)

        raise ValidationExhaustedError(result)

    def _augment_request(self, request: LLMRequest) -> LLMRequest:
        """Append schema instructions to the prompt."""
        instructions = self._schema.to_prompt_instructions()
        return LLMRequest(
            prompt=f"{request.prompt}\n\n{instructions}",
            system_prompt=request.system_prompt,
            max_tokens=request.max_tokens,
            temperature=request.temperature,
            metadata=request.metadata,
        )

    def _augment_with_feedback(
        self, base_request: LLMRequest, errors: list[str], previous_output: str
    ) -> LLMRequest:
        """Add error feedback context for retry attempts."""
        feedback = _format_error_feedback(errors, self._config.error_feedback_format)
        return LLMRequest(
            prompt=f"{base_request.prompt}\n\n---\nPrevious output:\n{previous_output}\n\n{feedback}",
            system_prompt=base_request.system_prompt,
            max_tokens=base_request.max_tokens,
            temperature=base_request.temperature,
            metadata=base_request.metadata,
        )


# --- Built-in Schema Helpers ---


@dataclass
class FieldDef:
    """Definition for a single field in a JSON object schema."""

    type: str  # "string", "number", "boolean", "array", "object"
    required: bool = True
    description: str | None = None
    enum: list[Any] | None = None


# Python type name -> expected JSON type name mapping.
# Python's json.loads produces int/float for numbers and bool for booleans,
# so we map Python type names to the schema's type vocabulary.
_TYPE_MAP: dict[str, str] = {
    "str": "string",
    "int": "number",
    "float": "number",
    "bool": "boolean",
    "list": "array",
    "dict": "object",
}


class JsonObjectSchema:
    """
    A simple schema that validates JSON objects against a field definition.
    No external dependencies (no Pydantic, no marshmallow).

    For production use, wrapping Pydantic or another validation library in
    the OutputSchema protocol is recommended. This built-in handles common
    cases without adding a dependency.
    """

    def __init__(self, schema_name: str, fields: dict[str, FieldDef]) -> None:
        self._schema_name = schema_name
        self._fields = fields

    def parse(self, raw: str) -> dict[str, Any]:
        """Parse raw JSON string and validate against the schema."""
        # Step 1: Parse as JSON
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            truncated = raw[:100] + "..." if len(raw) > 100 else raw
            raise SchemaValidationError([f"Invalid JSON: {truncated}"])

        if not isinstance(parsed, dict):
            raise SchemaValidationError([f"Expected a JSON object, got {type(parsed).__name__}"])

        errors: list[str] = []

        # Step 2: Validate required fields and types
        for field_name, field_def in self._fields.items():
            value = parsed.get(field_name)

            if value is None:
                if field_def.required:
                    errors.append(f'Missing required field: "{field_name}"')
                continue

            # Type check — map Python runtime types to schema type names
            actual_type = _TYPE_MAP.get(type(value).__name__, type(value).__name__)
            if actual_type != field_def.type:
                errors.append(
                    f'Field "{field_name}" expected type "{field_def.type}", '
                    f'got "{actual_type}" (value: {json.dumps(value)})'
                )

            # Enum check
            if field_def.enum is not None and value not in field_def.enum:
                errors.append(
                    f'Field "{field_name}" value {json.dumps(value)} '
                    f"not in allowed values: {json.dumps(field_def.enum)}"
                )

        if errors:
            raise SchemaValidationError(errors)

        return parsed

    def to_json_schema(self) -> dict[str, Any]:
        """Generate a JSON Schema representation."""
        properties: dict[str, dict[str, Any]] = {}
        required: list[str] = []

        for field_name, field_def in self._fields.items():
            prop: dict[str, Any] = {"type": field_def.type}
            if field_def.description:
                prop["description"] = field_def.description
            if field_def.enum is not None:
                prop["enum"] = field_def.enum
            properties[field_name] = prop

            if field_def.required:
                required.append(field_name)

        return {"type": "object", "properties": properties, "required": required}

    def to_prompt_instructions(self) -> str:
        """Generate human-readable schema description for prompt instructions."""
        lines: list[str] = []
        for field_name, field_def in self._fields.items():
            req_str = "optional" if not field_def.required else "required"
            desc = f'- "{field_name}" ({field_def.type}, {req_str})'
            if field_def.description:
                desc += f": {field_def.description}"
            if field_def.enum is not None:
                enum_str = ", ".join(json.dumps(v) for v in field_def.enum)
                desc += f". Allowed values: {enum_str}"
            lines.append(desc)

        field_descriptions = "\n".join(lines)
        return "\n".join([
            f'Respond with a JSON object matching the "{self._schema_name}" schema:',
            field_descriptions,
            "",
            "Return ONLY the JSON object. No markdown, no explanation, no additional text.",
        ])

"""
Tool Call Reliability — core implementation.

Validates LLM tool calls for:
  1. Allowlist membership (no hallucinated tool names)
  2. Schema compliance (correct types, required fields present)
  3. Self-repair (sends structured error feedback back to the LLM for correction)
"""

from __future__ import annotations

import json
from copy import deepcopy
from typing import Any

from .types import (
    LLMProvider,
    Message,
    OnRepairFailure,
    RawToolCall,
    RepairFeedbackMode,
    SchemaStrictness,
    ToolCallResult,
    ToolSchema,
    ValidatorConfig,
    ValidationError,
    JSONSchemaProperty,
)

__all__ = [
    "ToolCallValidator",
    "ToolCallValidationError",
    "ValidatorConfig",
    "ToolSchema",
    "RawToolCall",
    "ToolCallResult",
    "ValidationError",
    "Message",
    "SchemaStrictness",
    "RepairFeedbackMode",
    "OnRepairFailure",
]


class ToolCallValidationError(Exception):
    """Raised when a tool call fails validation and all repair attempts are exhausted."""

    def __init__(self, message: str, result: ToolCallResult) -> None:
        super().__init__(message)
        self.result = result


class ToolCallValidator:
    def __init__(
        self,
        provider: LLMProvider,
        config: ValidatorConfig | None = None,
    ) -> None:
        self.provider = provider
        self.config = config or ValidatorConfig()

    async def validate(
        self,
        tool_call: RawToolCall,
        tools: list[ToolSchema],
        messages: list[Message],
    ) -> ToolCallResult:
        """
        Validate a raw tool call against the provided tool schemas.
        If invalid, attempt repair up to max_repair_attempts times.
        """
        parsed, parse_error = self._parse_arguments(tool_call.arguments)

        if parse_error:
            return await self._handle_validation_failure(
                tool_call,
                tools,
                messages,
                [ValidationError(
                    field="arguments",
                    expected="valid JSON",
                    received=str(tool_call.arguments),
                    message=parse_error,
                )],
                attempt=0,
            )

        # Allowlist check — reject hallucinated tool names
        if self.config.strict_allowlist:
            allowlist_error = self._check_allowlist(tool_call.name, tools)
            if allowlist_error:
                # Allowlist failures are not repairable — return immediately without using repair budget
                return ToolCallResult(
                    valid=False,
                    tool_name=tool_call.name,
                    tool_call_id=tool_call.id,
                    arguments=parsed or {},
                    errors=[allowlist_error],
                    repair_attempts=0,
                )

        schema = next((t for t in tools if t.name == tool_call.name), None)
        if not schema:
            # Happens when strict_allowlist is False and tool has no schema
            return ToolCallResult(
                valid=True,
                tool_name=tool_call.name,
                tool_call_id=tool_call.id,
                arguments=parsed or {},
            )

        schema_errors = self._validate_schema(parsed, schema)  # type: ignore[arg-type]
        if not schema_errors:
            return ToolCallResult(
                valid=True,
                tool_name=tool_call.name,
                tool_call_id=tool_call.id,
                arguments=parsed,  # type: ignore[arg-type]
            )

        return await self._handle_validation_failure(
            tool_call, tools, messages, schema_errors, attempt=0
        )

    async def _handle_validation_failure(
        self,
        tool_call: RawToolCall,
        tools: list[ToolSchema],
        messages: list[Message],
        errors: list[ValidationError],
        attempt: int,
    ) -> ToolCallResult:
        if attempt >= self.config.max_repair_attempts:
            return self._apply_repair_failure_policy(tool_call, errors, attempt)

        repair_messages = self._build_repair_messages(messages, tool_call, errors)

        try:
            response = await self.provider.chat(repair_messages, tools)
        except Exception:
            return self._apply_repair_failure_policy(tool_call, errors, attempt)

        if not response.tool_calls:
            # Model responded with text instead of a tool call
            return self._apply_repair_failure_policy(tool_call, errors, attempt + 1)

        repaired_call = response.tool_calls[0]
        parsed, parse_error = self._parse_arguments(repaired_call.arguments)

        if parse_error:
            return await self._handle_validation_failure(
                repaired_call,
                tools,
                repair_messages,
                [ValidationError(
                    field="arguments",
                    expected="valid JSON",
                    received=str(repaired_call.arguments),
                    message=parse_error,
                )],
                attempt=attempt + 1,
            )

        schema = next((t for t in tools if t.name == repaired_call.name), None)
        if not schema:
            return self._apply_repair_failure_policy(repaired_call, errors, attempt + 1)

        schema_errors = self._validate_schema(parsed, schema)  # type: ignore[arg-type]
        if not schema_errors:
            return ToolCallResult(
                valid=True,
                tool_name=repaired_call.name,
                tool_call_id=repaired_call.id,
                arguments=parsed,  # type: ignore[arg-type]
                repair_attempts=attempt + 1,
            )

        return await self._handle_validation_failure(
            repaired_call, tools, repair_messages, schema_errors, attempt=attempt + 1
        )

    def _parse_arguments(
        self,
        args: str | dict[str, Any],
    ) -> tuple[dict[str, Any] | None, str | None]:
        if isinstance(args, dict):
            return args, None
        try:
            parsed = json.loads(args)
            if not isinstance(parsed, dict):
                return None, f"Expected JSON object, got {type(parsed).__name__}"
            return parsed, None
        except json.JSONDecodeError as e:
            return None, f"JSON parse failed: {e}"

    def _check_allowlist(
        self,
        tool_name: str,
        tools: list[ToolSchema],
    ) -> ValidationError | None:
        allowed = {t.name for t in tools}
        if tool_name not in allowed:
            return ValidationError(
                field="name",
                expected=f"one of: {', '.join(sorted(allowed))}",
                received=tool_name,
                message=f"Tool '{tool_name}' is not in the provided tool schema. This call will not be executed.",
            )
        return None

    def _validate_schema(
        self,
        args: dict[str, Any],
        schema: ToolSchema,
    ) -> list[ValidationError]:
        errors: list[ValidationError] = []
        props = schema.parameters.properties
        required = schema.parameters.required or []

        fields_to_check = (
            list(props.keys())
            if self.config.schema_strictness == SchemaStrictness.ALL
            else required
        )

        # Check required fields are present
        for f in required:
            if f not in args:
                errors.append(ValidationError(
                    field=f,
                    expected="present",
                    received="missing",
                    message=f"Required field '{f}' is missing",
                ))

        # Type-check fields in scope
        for f in fields_to_check:
            if f not in args:
                continue  # missing required fields caught above
            prop = props.get(f)
            if prop is None:
                continue
            type_error = self._check_type(f, args[f], prop)
            if type_error:
                errors.append(type_error)

        return errors

    def _check_type(
        self,
        field_name: str,
        value: Any,
        schema: JSONSchemaProperty,
    ) -> ValidationError | None:
        # Enum check takes precedence
        if schema.enum is not None and value not in schema.enum:
            return ValidationError(
                field=field_name,
                expected=f"one of: {json.dumps(schema.enum)}",
                received=json.dumps(value),
                message=f"Field '{field_name}' must be one of {json.dumps(schema.enum)}, got {json.dumps(value)}",
            )

        expected_type = schema.type

        if expected_type == "string" and not isinstance(value, str):
            return ValidationError(
                field=field_name,
                expected="string",
                received=type(value).__name__,
                message=f"Field '{field_name}' expected string, got {type(value).__name__}",
            )
        elif expected_type == "number" and not isinstance(value, (int, float)):
            return ValidationError(
                field=field_name,
                expected="number",
                received=type(value).__name__,
                message=f"Field '{field_name}' expected number, got {type(value).__name__}",
            )
        elif expected_type == "integer":
            if not isinstance(value, int) or isinstance(value, bool):
                return ValidationError(
                    field=field_name,
                    expected="integer",
                    received=type(value).__name__,
                    message=f"Field '{field_name}' expected integer, got {type(value).__name__} ({value!r})",
                )
        elif expected_type == "boolean" and not isinstance(value, bool):
            return ValidationError(
                field=field_name,
                expected="boolean",
                received=type(value).__name__,
                message=f"Field '{field_name}' expected boolean, got {type(value).__name__}",
            )
        elif expected_type == "array" and not isinstance(value, list):
            return ValidationError(
                field=field_name,
                expected="array",
                received=type(value).__name__,
                message=f"Field '{field_name}' expected array (list), got {type(value).__name__}",
            )
        elif expected_type == "object" and not isinstance(value, dict):
            return ValidationError(
                field=field_name,
                expected="object",
                received=type(value).__name__,
                message=f"Field '{field_name}' expected object (dict), got {type(value).__name__}",
            )

        return None

    def _build_repair_messages(
        self,
        original_messages: list[Message],
        tool_call: RawToolCall,
        errors: list[ValidationError],
    ) -> list[Message]:
        if self.config.repair_feedback_mode == RepairFeedbackMode.STRUCTURED:
            error_text = "\n".join(f"- {e.message}" for e in errors)
        else:
            error_text = "\n".join(
                f"- Field '{e.field}': expected {e.expected}, received {e.received}. {e.message}"
                for e in errors
            )

        repair_message = Message(
            role="user",
            content=(
                f"The previous tool call to '{tool_call.name}' failed validation:\n"
                f"{error_text}\n\n"
                "Please call the tool again with corrected arguments."
            ),
        )
        return [*original_messages, repair_message]

    def _apply_repair_failure_policy(
        self,
        tool_call: RawToolCall,
        errors: list[ValidationError],
        repair_attempts: int,
    ) -> ToolCallResult:
        result = ToolCallResult(
            valid=False,
            tool_name=tool_call.name,
            tool_call_id=tool_call.id,
            arguments={},
            errors=errors,
            repair_attempts=repair_attempts,
        )

        if self.config.on_repair_failure == OnRepairFailure.THROW:
            error_messages = "; ".join(e.message for e in errors)
            raise ToolCallValidationError(
                f"Tool call '{tool_call.name}' failed validation after "
                f"{repair_attempts} repair attempt(s). Errors: {error_messages}",
                result,
            )
        # RETURN_ERROR and SILENT_DROP both return the result; caller checks result.valid
        return result

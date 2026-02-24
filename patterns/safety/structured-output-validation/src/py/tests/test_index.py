"""
Structured Output Validation — Tests

Three categories:
1. Unit tests — core logic under normal conditions
2. Failure mode tests — one per failure mode from README
3. Integration tests — end-to-end with mock provider
"""

from __future__ import annotations

import pytest

# Direct module imports — conftest.py adds src/py/ to sys.path
# to avoid the 'py' package name collision with pytest internals.
from validator import (
    OutputValidator,
    JsonObjectSchema,
    FieldDef,
    strip_markdown_fences,
    extract_json,
    repair_json,
)
from mock_provider import MockProvider, MockProviderConfig
from _types import (
    LLMRequest,
    LLMResponse,
    SchemaValidationError,
    ValidationExhaustedError,
    ValidatorConfig,
)

# --- Test Schemas ---

user_schema = JsonObjectSchema("User", {
    "name": FieldDef(type="string", required=True, description="Full name"),
    "age": FieldDef(type="number", required=True, description="Age in years"),
    "active": FieldDef(type="boolean", required=True),
})

optional_schema = JsonObjectSchema("Profile", {
    "name": FieldDef(type="string", required=True),
    "bio": FieldDef(type="string", required=False),
})


# ============================================================================
# Unit Tests
# ============================================================================


class TestStripMarkdownFences:
    def test_strip_json_fences(self):
        assert strip_markdown_fences('```json\n{"a": 1}\n```') == '{"a": 1}'

    def test_strip_plain_fences(self):
        assert strip_markdown_fences('```\n{"a": 1}\n```') == '{"a": 1}'

    def test_no_fences_unchanged(self):
        assert strip_markdown_fences('{"a": 1}') == '{"a": 1}'

    def test_whitespace_around_fences(self):
        assert strip_markdown_fences('  ```json\n  {"a": 1}\n  ```  ') == '{"a": 1}'


class TestExtractJson:
    def test_extract_from_prose(self):
        raw = 'Here is the data:\n{"name": "Alice"}\nHope this helps!'
        assert extract_json(raw) == '{"name": "Alice"}'

    def test_json_at_start(self):
        assert extract_json('{"a": 1}') == '{"a": 1}'

    def test_nested_braces(self):
        raw = 'Result: {"a": {"b": 1}} done'
        assert extract_json(raw) == '{"a": {"b": 1}}'

    def test_strings_containing_braces(self):
        raw = 'X: {"msg": "use {x} here"} Y'
        assert extract_json(raw) == '{"msg": "use {x} here"}'

    def test_extract_arrays(self):
        raw = "Items: [1, 2, 3] end"
        assert extract_json(raw) == "[1, 2, 3]"

    def test_no_json_returns_input(self):
        assert extract_json("no json here") == "no json here"


class TestRepairJson:
    def test_remove_trailing_commas(self):
        assert repair_json('{"a": 1,}') == '{"a": 1}'

    def test_close_unbalanced_braces(self):
        assert repair_json('{"a": 1') == '{"a": 1}'

    def test_close_unbalanced_brackets(self):
        assert repair_json("[1, 2") == "[1, 2]"

    def test_multiple_issues(self):
        assert repair_json('{"a": [1, 2,') == '{"a": [1, 2]}'

    def test_valid_json_unchanged(self):
        assert repair_json('{"a": 1}') == '{"a": 1}'


class TestJsonObjectSchema:
    def test_parse_valid_json(self):
        data = user_schema.parse('{"name": "Alice", "age": 30, "active": true}')
        assert data == {"name": "Alice", "age": 30, "active": True}

    def test_invalid_json_raises(self):
        with pytest.raises(SchemaValidationError):
            user_schema.parse("not json")

    def test_missing_required_field(self):
        with pytest.raises(SchemaValidationError) as exc_info:
            user_schema.parse('{"name": "Alice", "age": 30}')
        assert any('"active"' in e for e in exc_info.value.errors)

    def test_wrong_field_type(self):
        with pytest.raises(SchemaValidationError) as exc_info:
            user_schema.parse('{"name": "Alice", "age": "thirty", "active": true}')
        errors = exc_info.value.errors
        assert any('"age"' in e and "number" in e for e in errors)

    def test_optional_fields_can_be_missing(self):
        data = optional_schema.parse('{"name": "Alice"}')
        assert data == {"name": "Alice"}

    def test_non_object_json_raises(self):
        with pytest.raises(SchemaValidationError):
            user_schema.parse("[1, 2, 3]")

    def test_enum_validation(self):
        enum_schema = JsonObjectSchema("Status", {
            "level": FieldDef(type="string", required=True, enum=["low", "medium", "high"]),
        })
        assert enum_schema.parse('{"level": "low"}') == {"level": "low"}
        with pytest.raises(SchemaValidationError):
            enum_schema.parse('{"level": "moderate"}')

    def test_to_json_schema(self):
        schema = user_schema.to_json_schema()
        assert schema["type"] == "object"
        assert schema["required"] == ["name", "age", "active"]

    def test_to_prompt_instructions(self):
        instructions = user_schema.to_prompt_instructions()
        assert "User" in instructions
        assert '"name"' in instructions
        assert "required" in instructions
        assert "JSON" in instructions


# ============================================================================
# Failure Mode Tests
# ============================================================================


class TestFailureModeRetryBudgetExhaustion:
    @pytest.mark.asyncio
    async def test_respects_max_retries_and_raises(self):
        provider = MockProvider(MockProviderConfig(output_mode="non_json", latency_ms=0))
        validator = OutputValidator(user_schema, ValidatorConfig(max_retries=2, repair=False))

        with pytest.raises(ValidationExhaustedError) as exc_info:
            await validator.execute(provider.call, LLMRequest(prompt="test"))

        assert exc_info.value.result.retries == 2
        assert exc_info.value.result.success is False
        assert provider.call_count == 3  # initial + 2 retries

    @pytest.mark.asyncio
    async def test_fires_on_retry_callback(self):
        provider = MockProvider(MockProviderConfig(output_mode="non_json", latency_ms=0))
        retry_calls: list[dict] = []

        def on_retry(errors: list[str], attempt: int) -> None:
            retry_calls.append({"errors": errors, "attempt": attempt})

        validator = OutputValidator(
            user_schema,
            ValidatorConfig(max_retries=2, repair=False, on_retry=on_retry),
        )

        with pytest.raises(ValidationExhaustedError):
            await validator.execute(provider.call, LLMRequest(prompt="test"))

        assert len(retry_calls) == 2
        assert retry_calls[0]["attempt"] == 1
        assert retry_calls[1]["attempt"] == 2

    @pytest.mark.asyncio
    async def test_fires_on_validation_failure(self):
        provider = MockProvider(MockProviderConfig(output_mode="non_json", latency_ms=0))
        failure_results: list = []

        validator = OutputValidator(
            user_schema,
            ValidatorConfig(
                max_retries=1,
                repair=False,
                on_validation_failure=lambda r: failure_results.append(r),
            ),
        )

        with pytest.raises(ValidationExhaustedError):
            await validator.execute(provider.call, LLMRequest(prompt="test"))

        assert len(failure_results) == 1


class TestFailureModeSchemaPromptDrift:
    @pytest.mark.asyncio
    async def test_detects_type_mismatches(self):
        provider = MockProvider(MockProviderConfig(output_mode="wrong_type", latency_ms=0))
        validator = OutputValidator(user_schema, ValidatorConfig(max_retries=0, repair=False))

        with pytest.raises(ValidationExhaustedError) as exc_info:
            await validator.execute(provider.call, LLMRequest(prompt="test"))

        errors = exc_info.value.result.validation_errors
        assert errors
        error_str = " ".join(errors)
        assert "name" in error_str or "age" in error_str


class TestFailureModeOverlyStrictSchema:
    @pytest.mark.asyncio
    async def test_rejects_values_not_in_enum(self):
        strict_schema = JsonObjectSchema("Rating", {
            "score": FieldDef(type="string", required=True, enum=["low", "medium", "high"]),
        })
        provider = MockProvider(
            MockProviderConfig(output_mode="valid", valid_output={"score": "moderate"}, latency_ms=0)
        )
        validator = OutputValidator(strict_schema, ValidatorConfig(max_retries=0, repair=False))

        with pytest.raises(ValidationExhaustedError) as exc_info:
            await validator.execute(provider.call, LLMRequest(prompt="test"))

        assert "not in allowed values" in " ".join(exc_info.value.result.validation_errors)


class TestFailureModeErrorFeedbackDivergence:
    @pytest.mark.asyncio
    async def test_includes_error_feedback_in_retry(self):
        calls: list[LLMRequest] = []

        async def mock_provider(req: LLMRequest) -> LLMResponse:
            calls.append(req)
            return LLMResponse(content='{"name": 123}', tokens_used=50)

        validator = OutputValidator(user_schema, ValidatorConfig(max_retries=1, repair=False))

        with pytest.raises(ValidationExhaustedError):
            await validator.execute(mock_provider, LLMRequest(prompt="Get user"))

        assert len(calls) == 2
        assert "validation errors" in calls[1].prompt
        assert "Previous output" in calls[1].prompt


class TestFailureModeRepairMaskingDegradation:
    @pytest.mark.asyncio
    async def test_reports_repaired_true_when_needed(self):
        provider = MockProvider(MockProviderConfig(output_mode="invalid_json", latency_ms=0))
        validator = OutputValidator(user_schema, ValidatorConfig(max_retries=0, repair=True))

        result = await validator.execute(provider.call, LLMRequest(prompt="test"))

        assert result.success is True
        assert result.repaired is True
        assert result.parse_method == "repaired"

    @pytest.mark.asyncio
    async def test_reports_repaired_false_for_clean_parse(self):
        provider = MockProvider(MockProviderConfig(output_mode="valid", latency_ms=0))
        validator = OutputValidator(user_schema, ValidatorConfig(max_retries=0, repair=True))

        result = await validator.execute(provider.call, LLMRequest(prompt="test"))

        assert result.success is True
        assert result.repaired is False
        assert result.parse_method == "direct"


class TestFailureModeLatencyCompounding:
    @pytest.mark.asyncio
    async def test_tracks_total_latency_across_retries(self):
        provider = MockProvider(
            MockProviderConfig(output_mode=["non_json", "non_json", "valid"], latency_ms=0)
        )
        validator = OutputValidator(user_schema, ValidatorConfig(max_retries=2, repair=False))

        result = await validator.execute(provider.call, LLMRequest(prompt="test"))

        assert result.success is True
        assert result.retries == 2
        assert result.total_latency_ms >= 0
        assert result.parse_method == "retry"


class TestFailureModeSchemaComplexity:
    @pytest.mark.asyncio
    async def test_reports_specific_errors_for_complex_schema(self):
        provider = MockProvider(
            MockProviderConfig(
                output_mode="valid",
                valid_output={"name": "Alice", "age": 30, "active": True},
                latency_ms=0,
            )
        )
        nested_schema = JsonObjectSchema("Complex", {
            "user": FieldDef(type="object", required=True),
            "tags": FieldDef(type="array", required=True),
        })
        validator = OutputValidator(nested_schema, ValidatorConfig(max_retries=0, repair=False))

        with pytest.raises(ValidationExhaustedError) as exc_info:
            await validator.execute(provider.call, LLMRequest(prompt="test"))

        errors = exc_info.value.result.validation_errors
        assert any("user" in e for e in errors)
        assert any("tags" in e for e in errors)


# ============================================================================
# Integration Tests
# ============================================================================


class TestIntegrationFullPipeline:
    @pytest.mark.asyncio
    async def test_markdown_wrapped_json(self):
        provider = MockProvider(MockProviderConfig(output_mode="markdown_wrapped", latency_ms=0))
        validator = OutputValidator(user_schema, ValidatorConfig(max_retries=0))

        result = await validator.execute(provider.call, LLMRequest(prompt="test"))

        assert result.success is True
        assert result.data == {"name": "Alice", "age": 30, "active": True}
        assert result.repaired is False
        assert result.parse_method == "direct"

    @pytest.mark.asyncio
    async def test_json_with_surrounding_prose(self):
        provider = MockProvider(MockProviderConfig(output_mode="extra_text", latency_ms=0))
        validator = OutputValidator(user_schema, ValidatorConfig(max_retries=0))

        result = await validator.execute(provider.call, LLMRequest(prompt="test"))

        assert result.success is True
        assert result.data == {"name": "Alice", "age": 30, "active": True}

    @pytest.mark.asyncio
    async def test_repair_invalid_json(self):
        provider = MockProvider(MockProviderConfig(output_mode="invalid_json", latency_ms=0))
        validator = OutputValidator(user_schema, ValidatorConfig(max_retries=0, repair=True))

        result = await validator.execute(provider.call, LLMRequest(prompt="test"))

        assert result.success is True
        assert result.repaired is True

    @pytest.mark.asyncio
    async def test_truncated_json_doesnt_crash(self):
        provider = MockProvider(MockProviderConfig(output_mode="truncated", latency_ms=0))
        validator = OutputValidator(user_schema, ValidatorConfig(max_retries=0, repair=True))

        # Truncated JSON may or may not be repairable depending on where it's cut.
        # The important thing is the validator doesn't crash.
        try:
            result = await validator.execute(provider.call, LLMRequest(prompt="test"))
            assert result.repaired is True
        except ValidationExhaustedError:
            pass  # Expected if repair can't fix the truncation

    @pytest.mark.asyncio
    async def test_retry_succeeds_on_self_correction(self):
        provider = MockProvider(
            MockProviderConfig(output_mode=["missing_field", "valid"], latency_ms=0)
        )
        validator = OutputValidator(user_schema, ValidatorConfig(max_retries=1, repair=False))

        result = await validator.execute(provider.call, LLMRequest(prompt="test"))

        assert result.success is True
        assert result.retries == 1
        assert result.parse_method == "retry"

    @pytest.mark.asyncio
    async def test_augments_prompt_with_schema(self):
        calls: list[LLMRequest] = []

        async def mock_provider(req: LLMRequest) -> LLMResponse:
            calls.append(req)
            return LLMResponse(content='{"name": "Alice", "age": 30, "active": true}')

        validator = OutputValidator(
            user_schema,
            ValidatorConfig(max_retries=0, include_schema_in_prompt=True),
        )
        await validator.execute(mock_provider, LLMRequest(prompt="Get user info"))

        assert "User" in calls[0].prompt
        assert '"name"' in calls[0].prompt
        assert "JSON" in calls[0].prompt

    @pytest.mark.asyncio
    async def test_no_schema_augmentation_when_disabled(self):
        calls: list[LLMRequest] = []

        async def mock_provider(req: LLMRequest) -> LLMResponse:
            calls.append(req)
            return LLMResponse(content='{"name": "Alice", "age": 30, "active": true}')

        validator = OutputValidator(
            user_schema,
            ValidatorConfig(max_retries=0, include_schema_in_prompt=False),
        )
        await validator.execute(mock_provider, LLMRequest(prompt="Get user info"))

        assert calls[0].prompt == "Get user info"

    @pytest.mark.asyncio
    async def test_provider_error_propagates(self):
        provider = MockProvider(MockProviderConfig(failure_rate=1.0, latency_ms=0))
        validator = OutputValidator(user_schema, ValidatorConfig(max_retries=0))

        with pytest.raises(RuntimeError, match="Provider unavailable"):
            await validator.execute(provider.call, LLMRequest(prompt="test"))

    @pytest.mark.asyncio
    async def test_end_to_end_with_retries(self):
        """Realistic scenario: first call returns wrong types, retry returns valid JSON."""
        call_count = 0

        async def mock_provider(req: LLMRequest) -> LLMResponse:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return LLMResponse(
                    content='```json\n{"name": 123, "age": "thirty", "active": true}\n```'
                )
            return LLMResponse(content='{"name": "Alice", "age": 30, "active": true}')

        retry_log: list[int] = []
        validator = OutputValidator(
            user_schema,
            ValidatorConfig(
                max_retries=2,
                repair=True,
                on_retry=lambda _errors, attempt: retry_log.append(attempt),
            ),
        )

        result = await validator.execute(mock_provider, LLMRequest(prompt="Get user"))

        assert result.success is True
        assert result.retries == 1
        assert result.data == {"name": "Alice", "age": 30, "active": True}
        assert retry_log == [1]

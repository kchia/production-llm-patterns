"""
Tests for the Tool Call Reliability pattern (Python implementation).

Three test categories:
1. Unit tests — core validation logic
2. Failure mode tests — one test per FM table row
3. Integration tests — end-to-end with mock provider
"""

from __future__ import annotations

import pytest
from ..mock_provider import MockLLMProvider, MockProviderConfig
from ..__init__ import (
    ToolCallValidator,
    ToolCallValidationError,
    ValidatorConfig,
)
from ..types import (
    JSONSchemaProperty,
    Message,
    OnRepairFailure,
    RawToolCall,
    SchemaStrictness,
    ToolParameters,
    ToolSchema,
)

# --- Shared fixtures ---

weather_tool = ToolSchema(
    name="get_weather",
    description="Get current weather for a city",
    parameters=ToolParameters(
        type="object",
        properties={
            "city": JSONSchemaProperty(type="string", description="City name"),
            "units": JSONSchemaProperty(type="string", enum=["celsius", "fahrenheit"]),
            "include_forecast": JSONSchemaProperty(type="boolean"),
            "days": JSONSchemaProperty(type="integer", minimum=1, maximum=7),
        },
        required=["city"],
    ),
)

search_tool = ToolSchema(
    name="search",
    description="Search for information",
    parameters=ToolParameters(
        type="object",
        properties={
            "query": JSONSchemaProperty(type="string"),
            "limit": JSONSchemaProperty(type="integer"),
        },
        required=["query"],
    ),
)

tools = [weather_tool, search_tool]
base_messages = [Message(role="user", content="What is the weather in Seattle?")]


# --- Unit Tests ---

class TestValidToolCalls:
    @pytest.mark.asyncio
    async def test_accepts_well_formed_tool_call(self):
        provider = MockLLMProvider()
        validator = ToolCallValidator(provider)

        result = await validator.validate(
            RawToolCall(id="call_1", name="get_weather", arguments='{"city": "Seattle"}'),
            tools,
            base_messages,
        )

        assert result.valid is True
        assert result.tool_name == "get_weather"
        assert result.arguments == {"city": "Seattle"}
        assert result.repair_attempts == 0

    @pytest.mark.asyncio
    async def test_accepts_dict_arguments(self):
        provider = MockLLMProvider()
        validator = ToolCallValidator(provider)

        result = await validator.validate(
            RawToolCall(id="call_1", name="get_weather", arguments={"city": "Portland"}),
            tools,
            base_messages,
        )

        assert result.valid is True
        assert result.arguments["city"] == "Portland"

    @pytest.mark.asyncio
    async def test_accepts_valid_enum_value(self):
        provider = MockLLMProvider()
        validator = ToolCallValidator(provider, ValidatorConfig(schema_strictness=SchemaStrictness.ALL))

        result = await validator.validate(
            RawToolCall(id="call_1", name="get_weather", arguments={"city": "Seattle", "units": "celsius"}),
            tools,
            base_messages,
        )

        assert result.valid is True


class TestSchemaValidation:
    @pytest.mark.asyncio
    async def test_rejects_missing_required_field(self):
        provider = MockLLMProvider()
        validator = ToolCallValidator(
            provider,
            ValidatorConfig(max_repair_attempts=0, on_repair_failure=OnRepairFailure.RETURN_ERROR),
        )

        result = await validator.validate(
            RawToolCall(id="call_1", name="get_weather", arguments="{}"),
            tools,
            base_messages,
        )

        assert result.valid is False
        assert any(e.field == "city" for e in (result.errors or []))

    @pytest.mark.asyncio
    async def test_rejects_wrong_type(self):
        provider = MockLLMProvider()
        validator = ToolCallValidator(
            provider,
            ValidatorConfig(max_repair_attempts=0, schema_strictness=SchemaStrictness.ALL, on_repair_failure=OnRepairFailure.RETURN_ERROR),
        )

        result = await validator.validate(
            RawToolCall(id="call_1", name="get_weather", arguments={"city": 42}),
            tools,
            base_messages,
        )

        assert result.valid is False
        assert any(e.field == "city" for e in (result.errors or []))

    @pytest.mark.asyncio
    async def test_rejects_invalid_enum(self):
        provider = MockLLMProvider()
        validator = ToolCallValidator(
            provider,
            ValidatorConfig(max_repair_attempts=0, schema_strictness=SchemaStrictness.ALL, on_repair_failure=OnRepairFailure.RETURN_ERROR),
        )

        result = await validator.validate(
            RawToolCall(id="call_1", name="get_weather", arguments={"city": "Seattle", "units": "kelvin"}),
            tools,
            base_messages,
        )

        assert result.valid is False
        assert any(e.field == "units" for e in (result.errors or []))

    @pytest.mark.asyncio
    async def test_rejects_non_integer_for_integer_field(self):
        provider = MockLLMProvider()
        validator = ToolCallValidator(
            provider,
            ValidatorConfig(max_repair_attempts=0, schema_strictness=SchemaStrictness.ALL, on_repair_failure=OnRepairFailure.RETURN_ERROR),
        )

        result = await validator.validate(
            RawToolCall(id="call_1", name="get_weather", arguments={"city": "Seattle", "days": 3.5}),
            tools,
            base_messages,
        )

        assert result.valid is False
        assert any(e.field == "days" for e in (result.errors or []))

    @pytest.mark.asyncio
    async def test_required_only_ignores_optional_type_errors(self):
        provider = MockLLMProvider()
        validator = ToolCallValidator(
            provider,
            ValidatorConfig(schema_strictness=SchemaStrictness.REQUIRED_ONLY, max_repair_attempts=0, on_repair_failure=OnRepairFailure.RETURN_ERROR),
        )

        # 'units' is optional; wrong type should not fail in required-only mode
        result = await validator.validate(
            RawToolCall(id="call_1", name="get_weather", arguments={"city": "Seattle", "units": 123}),
            tools,
            base_messages,
        )

        assert result.valid is True


class TestAllowlistCheck:
    @pytest.mark.asyncio
    async def test_rejects_hallucinated_tool_name(self):
        provider = MockLLMProvider()
        validator = ToolCallValidator(
            provider,
            ValidatorConfig(strict_allowlist=True, on_repair_failure=OnRepairFailure.RETURN_ERROR),
        )

        result = await validator.validate(
            RawToolCall(id="call_1", name="hallucinated_tool", arguments="{}"),
            tools,
            base_messages,
        )

        assert result.valid is False
        assert result.errors is not None
        assert result.errors[0].field == "name"
        assert result.repair_attempts == 0  # allowlist failures don't use repair budget

    @pytest.mark.asyncio
    async def test_allows_any_tool_when_allowlist_disabled(self):
        provider = MockLLMProvider()
        validator = ToolCallValidator(
            provider,
            ValidatorConfig(strict_allowlist=False, on_repair_failure=OnRepairFailure.RETURN_ERROR),
        )

        result = await validator.validate(
            RawToolCall(id="call_1", name="unknown_tool", arguments="{}"),
            tools,
            base_messages,
        )

        assert result.valid is True


class TestJSONParsing:
    @pytest.mark.asyncio
    async def test_repairs_malformed_json(self):
        provider = MockLLMProvider(MockProviderConfig(
            scenarios=[
                {"type": "valid-call", "tool_name": "get_weather", "args": {"city": "Seattle"}},
            ]
        ))
        validator = ToolCallValidator(provider, ValidatorConfig(max_repair_attempts=1))

        result = await validator.validate(
            RawToolCall(id="call_1", name="get_weather", arguments='{city: "Seattle"'),
            tools,
            base_messages,
        )

        assert result.valid is True
        assert result.repair_attempts == 1


# --- Failure Mode Tests ---

class TestFailureModeRepairLoopExhaustion:
    @pytest.mark.asyncio
    async def test_throws_on_exhaustion_with_throw_policy(self):
        provider = MockLLMProvider(MockProviderConfig(scenarios=[
            {"type": "missing-required", "tool_name": "get_weather", "args": {}},
            {"type": "missing-required", "tool_name": "get_weather", "args": {}},
        ]))
        validator = ToolCallValidator(provider, ValidatorConfig(
            max_repair_attempts=2,
            on_repair_failure=OnRepairFailure.THROW,
        ))

        with pytest.raises(ToolCallValidationError):
            await validator.validate(
                RawToolCall(id="call_1", name="get_weather", arguments="{}"),
                tools,
                base_messages,
            )

    @pytest.mark.asyncio
    async def test_returns_error_on_exhaustion_with_return_policy(self):
        provider = MockLLMProvider(MockProviderConfig(scenarios=[
            {"type": "missing-required", "tool_name": "get_weather", "args": {}},
        ]))
        validator = ToolCallValidator(provider, ValidatorConfig(
            max_repair_attempts=1,
            on_repair_failure=OnRepairFailure.RETURN_ERROR,
        ))

        result = await validator.validate(
            RawToolCall(id="call_1", name="get_weather", arguments="{}"),
            tools,
            base_messages,
        )

        assert result.valid is False
        assert result.repair_attempts == 1

    @pytest.mark.asyncio
    async def test_repair_attempt_count_is_accurate(self):
        provider = MockLLMProvider(MockProviderConfig(scenarios=[
            {"type": "missing-required", "tool_name": "get_weather", "args": {}},
            {"type": "missing-required", "tool_name": "get_weather", "args": {}},
        ]))
        validator = ToolCallValidator(provider, ValidatorConfig(
            max_repair_attempts=2,
            on_repair_failure=OnRepairFailure.RETURN_ERROR,
        ))

        result = await validator.validate(
            RawToolCall(id="call_1", name="get_weather", arguments="{}"),
            tools,
            base_messages,
        )

        assert result.repair_attempts == 2


class TestFailureModeAllowlistBypassPrevention:
    @pytest.mark.asyncio
    async def test_blocks_hallucinated_tool_without_repair_attempts(self):
        provider = MockLLMProvider()
        validator = ToolCallValidator(provider, ValidatorConfig(
            strict_allowlist=True,
            max_repair_attempts=3,
            on_repair_failure=OnRepairFailure.RETURN_ERROR,
        ))

        result = await validator.validate(
            RawToolCall(id="call_1", name="system_exec", arguments='{"cmd":"rm -rf /"}'),
            tools,
            base_messages,
        )

        assert result.valid is False
        assert result.repair_attempts == 0  # No repair budget spent on allowlist failures
        assert result.errors is not None
        assert result.errors[0].field == "name"


class TestFailureModeRepairSuccess:
    @pytest.mark.asyncio
    async def test_succeeds_on_second_attempt(self):
        provider = MockLLMProvider(MockProviderConfig(scenarios=[
            {"type": "valid-call", "tool_name": "get_weather", "args": {"city": "Seattle"}},
        ]))
        validator = ToolCallValidator(provider, ValidatorConfig(max_repair_attempts=2))

        result = await validator.validate(
            RawToolCall(id="call_1", name="get_weather", arguments="{}"),
            tools,
            base_messages,
        )

        assert result.valid is True
        assert result.repair_attempts == 1
        assert provider.call_count == 1


class TestFailureModeSilentDegradation:
    @pytest.mark.asyncio
    async def test_repair_rate_tracking_across_calls(self):
        """
        Simulates the silent degradation scenario: repair rate rising over time
        (from 3% to higher) without triggering hard errors.
        This test verifies that repair_attempts > 0 is detectable per-call.
        """
        scenarios = []
        for i in range(10):
            if i % 3 == 0:
                scenarios.append({"type": "missing-required", "tool_name": "get_weather", "args": {}})
                scenarios.append({"type": "valid-call", "tool_name": "get_weather", "args": {"city": "Seattle"}})
            else:
                scenarios.append({"type": "valid-call", "tool_name": "get_weather", "args": {"city": "Seattle"}})

        provider = MockLLMProvider(MockProviderConfig(scenarios=scenarios))
        validator = ToolCallValidator(provider, ValidatorConfig(max_repair_attempts=1))

        repairs_needed = 0
        for i in range(10):
            args: str | dict
            if i % 3 == 0:
                args = "{}"
            else:
                args = {"city": "Seattle"}

            result = await validator.validate(
                RawToolCall(id=f"call_{i}", name="get_weather", arguments=args),
                tools,
                base_messages,
            )
            if result.repair_attempts > 0:
                repairs_needed += 1

        # Repair rate should be detectable via repair_attempts counter
        assert repairs_needed > 0


# --- Integration Tests ---

class TestIntegration:
    @pytest.mark.asyncio
    async def test_full_happy_path_flow(self):
        provider = MockLLMProvider(MockProviderConfig(scenarios=[
            {"type": "valid-call", "tool_name": "search", "args": {"query": "Python best practices", "limit": 5}},
        ]))
        validator = ToolCallValidator(provider, ValidatorConfig(
            max_repair_attempts=2,
            strict_allowlist=True,
            schema_strictness=SchemaStrictness.ALL,
        ))

        result = await validator.validate(
            RawToolCall(
                id="call_1",
                name="search",
                arguments={"query": "Python best practices", "limit": 5},
            ),
            tools,
            base_messages,
        )

        assert result.valid is True
        assert result.tool_name == "search"
        assert result.arguments == {"query": "Python best practices", "limit": 5}
        assert result.repair_attempts == 0
        assert result.errors is None

    @pytest.mark.asyncio
    async def test_repair_from_malformed_json_to_valid(self):
        provider = MockLLMProvider(MockProviderConfig(scenarios=[
            {"type": "valid-call", "tool_name": "search", "args": {"query": "test"}},
        ]))
        validator = ToolCallValidator(provider, ValidatorConfig(max_repair_attempts=1))

        result = await validator.validate(
            RawToolCall(id="call_1", name="search", arguments="not json"),
            tools,
            base_messages,
        )

        assert result.valid is True
        assert result.repair_attempts == 1

    @pytest.mark.asyncio
    async def test_concurrent_validation(self):
        """Concurrent validation calls must not interfere with each other."""
        import asyncio

        provider = MockLLMProvider()
        validator = ToolCallValidator(provider)

        results = await asyncio.gather(
            validator.validate(RawToolCall(id="call_1", name="get_weather", arguments={"city": "Seattle"}), tools, base_messages),
            validator.validate(RawToolCall(id="call_2", name="get_weather", arguments={"city": "Portland"}), tools, base_messages),
            validator.validate(RawToolCall(id="call_3", name="search", arguments={"query": "test"}), tools, base_messages),
        )

        assert all(r.valid for r in results)
        assert results[0].arguments["city"] == "Seattle"
        assert results[1].arguments["city"] == "Portland"
        assert results[2].tool_name == "search"

    @pytest.mark.asyncio
    async def test_validation_error_carries_diagnostics(self):
        provider = MockLLMProvider()
        validator = ToolCallValidator(provider, ValidatorConfig(
            max_repair_attempts=0,
            on_repair_failure=OnRepairFailure.THROW,
        ))

        with pytest.raises(ToolCallValidationError) as exc_info:
            await validator.validate(
                RawToolCall(id="call_1", name="get_weather", arguments="{}"),
                tools,
                base_messages,
            )

        assert exc_info.value.result.valid is False
        assert exc_info.value.result.errors is not None

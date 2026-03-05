"""Tests for the Prompt Version Registry — Python implementation.

Three categories: unit tests, failure mode tests, integration tests.
"""

from __future__ import annotations

import asyncio
import math

import pytest

from .. import InMemoryStorage, PromptRegistry
from ..mock_provider import MockLLMProvider, MockProviderConfig
from ..models import PromptConfig, RegistryConfig


# ─── Unit Tests ──────────────────────────────────────────────


class TestRegister:
    def setup_method(self) -> None:
        self.registry = PromptRegistry()

    def test_creates_immutable_version_with_auto_incremented_number(self) -> None:
        v1 = self.registry.register("greeting", "Hello {{name}}!")
        v2 = self.registry.register("greeting", "Hi {{name}}, welcome!")
        assert v1.version == 1
        assert v2.version == 2
        assert v1.content_hash != v2.content_hash

    def test_extracts_template_variables(self) -> None:
        v = self.registry.register(
            "extraction", "Extract {{entity_type}} from: {{text}}"
        )
        assert v.variables == ["entity_type", "text"]

    def test_handles_templates_with_no_variables(self) -> None:
        v = self.registry.register("static", "Always respond in JSON format.")
        assert v.variables == []

    def test_stores_config_metadata(self) -> None:
        v = self.registry.register(
            "test",
            "Template",
            PromptConfig(model="gpt-4o", temperature=0.7, commit_message="Initial"),
        )
        assert v.config.model == "gpt-4o"
        assert v.config.temperature == 0.7
        assert v.config.commit_message == "Initial"

    def test_raises_on_empty_name_or_template(self) -> None:
        with pytest.raises(ValueError):
            self.registry.register("", "template")
        with pytest.raises(ValueError):
            self.registry.register("name", "")

    def test_consistent_content_hashes_for_identical_templates(self) -> None:
        v1 = self.registry.register("a", "Hello {{name}}!")
        v2 = self.registry.register("b", "Hello {{name}}!")
        assert v1.content_hash == v2.content_hash

    def test_deduplicates_repeated_variable_names(self) -> None:
        v = self.registry.register("test", "{{name}} said hello to {{name}}")
        assert v.variables == ["name"]


class TestResolve:
    def setup_method(self) -> None:
        self.registry = PromptRegistry()

    def test_resolves_by_explicit_version_number(self) -> None:
        self.registry.register("greeting", "Hello {{name}}!")
        self.registry.register("greeting", "Hi {{name}}!")
        resolved = self.registry.resolve("greeting", version=1)
        assert resolved.version == 1
        assert resolved.template == "Hello {{name}}!"
        assert resolved.resolved_via == "version"

    def test_resolves_by_alias(self) -> None:
        self.registry.register("greeting", "Hello {{name}}!")
        v2 = self.registry.register("greeting", "Hi {{name}}!")
        self.registry.set_alias("greeting", "production", v2.version)
        resolved = self.registry.resolve("greeting", alias="production")
        assert resolved.version == 2
        assert resolved.resolved_via == "alias"
        assert resolved.alias_name == "production"

    def test_uses_default_alias_when_no_options(self) -> None:
        self.registry.register("greeting", "Hello!")
        self.registry.set_alias("greeting", "production", 1)
        resolved = self.registry.resolve("greeting")
        assert resolved.version == 1
        assert resolved.resolved_via == "alias"

    def test_falls_back_to_latest_when_no_alias_set(self) -> None:
        self.registry.register("greeting", "v1")
        self.registry.register("greeting", "v2")
        resolved = self.registry.resolve("greeting")
        assert resolved.version == 2
        assert resolved.resolved_via == "version"

    def test_raises_on_nonexistent_prompt_name(self) -> None:
        with pytest.raises(LookupError, match='Prompt "nonexistent" not found'):
            self.registry.resolve("nonexistent")

    def test_raises_on_nonexistent_version_number(self) -> None:
        self.registry.register("greeting", "Hello!")
        with pytest.raises(LookupError, match="version 99 not found"):
            self.registry.resolve("greeting", version=99)


class TestRender:
    def setup_method(self) -> None:
        self.registry = PromptRegistry()

    def test_substitutes_all_template_variables(self) -> None:
        self.registry.register(
            "greeting", "Hello {{name}}, welcome to {{place}}!"
        )
        resolved = self.registry.resolve("greeting", version=1)
        rendered = self.registry.render(resolved, {"name": "Alice", "place": "Wonderland"})
        assert rendered == "Hello Alice, welcome to Wonderland!"

    def test_raises_on_missing_required_variables(self) -> None:
        self.registry.register("greeting", "Hello {{name}}!")
        resolved = self.registry.resolve("greeting", version=1)
        with pytest.raises(ValueError, match="Missing template variables"):
            self.registry.render(resolved, {})

    def test_handles_extra_variables_gracefully(self) -> None:
        self.registry.register("simple", "Hello {{name}}!")
        resolved = self.registry.resolve("simple", version=1)
        rendered = self.registry.render(resolved, {"name": "Alice", "extra": "ignored"})
        assert rendered == "Hello Alice!"


class TestSetAlias:
    def setup_method(self) -> None:
        self.registry = PromptRegistry()

    def test_creates_and_updates_aliases(self) -> None:
        self.registry.register("greeting", "v1")
        self.registry.register("greeting", "v2")
        self.registry.set_alias("greeting", "production", 1)
        assert self.registry.resolve("greeting", alias="production").version == 1
        self.registry.set_alias("greeting", "production", 2)
        assert self.registry.resolve("greeting", alias="production").version == 2

    def test_raises_when_pointing_to_nonexistent_version(self) -> None:
        self.registry.register("greeting", "v1")
        with pytest.raises(LookupError):
            self.registry.set_alias("greeting", "production", 99)

    def test_records_alias_change_history(self) -> None:
        self.registry.register("greeting", "v1")
        self.registry.register("greeting", "v2")
        self.registry.set_alias("greeting", "production", 1)
        self.registry.set_alias("greeting", "production", 2)
        history = self.registry.get_alias_history("greeting")
        assert len(history) == 2
        assert history[0].previous_version is None
        assert history[0].new_version == 1
        assert history[1].previous_version == 1
        assert history[1].new_version == 2


class TestListVersions:
    def setup_method(self) -> None:
        self.registry = PromptRegistry()

    def test_returns_all_versions(self) -> None:
        self.registry.register("greeting", "v1")
        self.registry.register("greeting", "v2")
        self.registry.register("greeting", "v3")
        versions = self.registry.list_versions("greeting")
        assert len(versions) == 3
        assert [v.version for v in versions] == [1, 2, 3]

    def test_returns_empty_list_for_unknown_prompt(self) -> None:
        assert self.registry.list_versions("unknown") == []


class TestConfiguration:
    def test_respects_custom_default_alias(self) -> None:
        reg = PromptRegistry(RegistryConfig(default_alias="live"))
        reg.register("test", "content")
        reg.set_alias("test", "live", 1)
        resolved = reg.resolve("test")
        assert resolved.resolved_via == "alias"
        assert resolved.alias_name == "live"

    def test_archives_old_versions_when_max_versions_set(self) -> None:
        reg = PromptRegistry(RegistryConfig(max_versions=2))
        reg.register("test", "v1")
        reg.register("test", "v2")
        reg.register("test", "v3")
        versions = reg.list_versions("test")
        assert len(versions) == 2
        assert versions[0].version == 2
        assert versions[1].version == 3


# ─── Failure Mode Tests ──────────────────────────────────────


class TestFMTemplateVariableMismatch:
    def test_detects_missing_variables_at_render_time(self) -> None:
        registry = PromptRegistry()
        registry.register("extract", "Extract {{entity}} from {{text}}")
        resolved = registry.resolve("extract", version=1)
        with pytest.raises(ValueError, match="Missing template variables"):
            registry.render(resolved, {"entity": "names"})


class TestFMAliasPointsToWrongVersion:
    def test_alias_change_is_audited_with_previous_version(self) -> None:
        registry = PromptRegistry()
        registry.register("greeting", "v1")
        registry.register("greeting", "v2-bad")
        registry.set_alias("greeting", "production", 1)
        registry.set_alias("greeting", "production", 2)

        history = registry.get_alias_history("greeting")
        last_change = history[-1]
        assert last_change.previous_version == 1
        assert last_change.new_version == 2

        # Rollback
        assert last_change.previous_version is not None
        registry.set_alias("greeting", "production", last_change.previous_version)
        assert registry.resolve("greeting", alias="production").version == 1


class TestFMCacheStaleAlias:
    def test_cache_invalidated_on_alias_change(self) -> None:
        registry = PromptRegistry(RegistryConfig(cache_ttl_ms=50))
        registry.register("test", "v1")
        registry.register("test", "v2")
        registry.set_alias("test", "production", 1)

        first = registry.resolve("test")
        assert first.version == 1

        registry.set_alias("test", "production", 2)
        second = registry.resolve("test")
        assert second.version == 2

    def test_force_clear_cache_for_emergency_rollback(self) -> None:
        registry = PromptRegistry(RegistryConfig(cache_ttl_ms=600_000))
        registry.register("test", "v1")
        registry.register("test", "v2")
        registry.set_alias("test", "production", 1)
        registry.resolve("test")  # populate cache

        registry.clear_cache()
        registry.set_alias("test", "production", 2)
        assert registry.resolve("test").version == 2


class TestFMVersionExplosion:
    def test_max_versions_archives_oldest(self) -> None:
        registry = PromptRegistry(RegistryConfig(max_versions=3))
        for i in range(10):
            registry.register("prolific", f"Template version {i + 1}")

        versions = registry.list_versions("prolific")
        assert len(versions) == 3
        assert versions[0].version == 8
        assert versions[2].version == 10


class TestFMAliasToArchivedVersion:
    def test_alias_pointing_to_archived_version_raises(self) -> None:
        registry = PromptRegistry(RegistryConfig(max_versions=2))
        registry.register("test", "v1")
        registry.set_alias("test", "production", 1)
        registry.register("test", "v2")
        registry.register("test", "v3")

        with pytest.raises(LookupError, match="doesn't exist"):
            registry.resolve("test", alias="production")


class TestFMSilentVersionDrift:
    def test_detects_stale_production_aliases(self) -> None:
        registry = PromptRegistry()
        registry.register("extraction", "Old extraction template")
        registry.set_alias("extraction", "production", 1)

        registry.register("extraction", "Improved v2")
        registry.register("extraction", "Even better v3")

        resolved = registry.resolve("extraction")
        latest = registry.list_versions("extraction")
        latest_version = latest[-1].version

        drift = latest_version - resolved.version
        assert drift == 2


# ─── Integration Tests ───────────────────────────────────────


class TestIntegrationFullWorkflow:
    def test_register_alias_resolve_render_llm_call(self) -> None:
        registry = PromptRegistry()
        provider = MockLLMProvider(MockProviderConfig(latency_ms=10, latency_jitter_ms=2))

        registry.register(
            "summarize",
            "Summarize the following {{doc_type}} in {{max_words}} words:\n\n{{content}}",
            PromptConfig(model="gpt-4o", temperature=0.3, commit_message="Initial"),
        )
        registry.register(
            "summarize",
            "Write a concise {{max_words}}-word summary of this {{doc_type}}:\n\n{{content}}",
            PromptConfig(model="gpt-4o", temperature=0.2, commit_message="Concise"),
        )

        registry.set_alias("summarize", "production", 2)
        registry.set_alias("summarize", "staging", 1)

        prompt = registry.resolve("summarize")
        assert prompt.version == 2
        assert prompt.resolved_via == "alias"

        rendered = registry.render(prompt, {
            "doc_type": "legal contract",
            "max_words": "100",
            "content": "This agreement is entered into by...",
        })
        assert "legal contract" in rendered
        assert "100" in rendered

        response = asyncio.run(
            provider.complete(
                rendered,
                prompt_version=prompt.version,
                prompt_hash=prompt.content_hash,
            )
        )
        assert response.prompt_version == 2
        assert response.prompt_hash == prompt.content_hash


class TestIntegrationRollback:
    def test_bad_prompt_detect_rollback(self) -> None:
        registry = PromptRegistry()
        registry.register("extract", "Extract names from: {{text}}")
        registry.set_alias("extract", "production", 1)

        registry.register("extract", "Just say hello {{text}}")
        registry.set_alias("extract", "production", 2)

        history = registry.get_alias_history("extract")
        last_good = history[-1].previous_version
        assert last_good is not None

        registry.set_alias("extract", "production", last_good)
        resolved = registry.resolve("extract")
        assert resolved.version == 1
        assert "Extract names" in resolved.template

        updated_history = registry.get_alias_history("extract")
        assert len(updated_history) == 3
        assert updated_history[2].new_version == 1


class TestIntegrationConcurrentPrompts:
    def test_multiple_prompts_with_independent_aliases(self) -> None:
        registry = PromptRegistry()
        registry.register("summarize", "Summarize: {{text}}")
        registry.register("extract", "Extract entities from: {{text}}")
        registry.register("classify", "Classify: {{text}}")

        registry.set_alias("summarize", "production", 1)
        registry.set_alias("extract", "production", 1)
        registry.set_alias("classify", "production", 1)

        registry.register("extract", "Better extraction: {{text}}")
        registry.set_alias("extract", "production", 2)

        assert registry.resolve("summarize").version == 1
        assert registry.resolve("extract").version == 2
        assert registry.resolve("classify").version == 1


class TestIntegrationCustomStorage:
    def test_custom_storage_backend_works_via_protocol(self) -> None:
        storage = InMemoryStorage()
        registry = PromptRegistry(storage=storage)

        registry.register("test", "Template {{var}}")
        registry.set_alias("test", "production", 1)

        assert storage.get_version("test", 1) is not None
        assert storage.get_version("test", 1).template == "Template {{var}}"  # type: ignore[union-attr]
        assert storage.get_alias("test", "production") == 1

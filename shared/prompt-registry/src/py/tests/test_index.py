"""Unit tests for the shared prompt-registry utility."""

import pytest
from datetime import datetime

from shared.prompt_registry import InMemoryStorage, PromptRegistry, PromptConfig, RegistryConfig
from shared.prompt_registry.types import PromptVersion


# ─── Registration ─────────────────────────────────────────────────────────────

class TestRegistration:
    def setup_method(self):
        self.registry = PromptRegistry(RegistryConfig(cache_enabled=False))

    def test_assigns_version_1_to_first_registration(self):
        v = self.registry.register("greet", "Hello, {{name}}!")
        assert v.version == 1
        assert v.name == "greet"
        assert v.variables == ["name"]

    def test_increments_version_numbers_monotonically(self):
        self.registry.register("greet", "Hello, {{name}}!")
        v2 = self.registry.register("greet", "Hi there, {{name}}!")
        assert v2.version == 2

    def test_computes_stable_content_hash(self):
        v1 = self.registry.register("greet", "Hello, {{name}}!")
        v2 = self.registry.register("greet", "Hello, {{name}}!")
        assert v1.content_hash == v2.content_hash

    def test_rejects_empty_name(self):
        with pytest.raises(ValueError, match="required"):
            self.registry.register("", "Hello")

    def test_rejects_empty_template(self):
        with pytest.raises(ValueError, match="required"):
            self.registry.register("greet", "")

    def test_extracts_multiple_variables(self):
        v = self.registry.register("summary", "{{user}} asked: {{query}}. Answer: {{answer}}")
        assert v.variables == ["user", "query", "answer"]

    def test_created_at_is_datetime(self):
        v = self.registry.register("greet", "Hi")
        assert isinstance(v.created_at, datetime)

    def test_deduplicates_repeated_variables(self):
        v = self.registry.register("t", "{{x}} and {{x}} again")
        assert v.variables == ["x"]


# ─── Resolution ───────────────────────────────────────────────────────────────

class TestResolve:
    def setup_method(self):
        self.registry = PromptRegistry(RegistryConfig(cache_enabled=False))
        self.registry.register("greet", "Hello, {{name}}!")
        self.registry.register("greet", "Greetings, {{name}}!")

    def test_resolves_latest_when_no_alias_set(self):
        resolved = self.registry.resolve("greet")
        assert resolved.version == 2
        assert resolved.resolved_via == "version"

    def test_resolves_specific_version_by_number(self):
        resolved = self.registry.resolve("greet", version=1)
        assert resolved.version == 1
        assert resolved.template == "Hello, {{name}}!"

    def test_resolves_via_alias_after_set_alias(self):
        self.registry.set_alias("greet", "production", 1)
        resolved = self.registry.resolve("greet")
        assert resolved.version == 1
        assert resolved.resolved_via == "alias"
        assert resolved.alias_name == "production"

    def test_throws_on_unknown_prompt(self):
        with pytest.raises(LookupError, match='"unknown" not found'):
            self.registry.resolve("unknown")

    def test_throws_on_unknown_version(self):
        with pytest.raises(LookupError, match="version 99 not found"):
            self.registry.resolve("greet", version=99)

    def test_resolves_explicit_non_default_alias(self):
        self.registry.set_alias("greet", "staging", 1)
        resolved = self.registry.resolve("greet", alias="staging")
        assert resolved.version == 1
        assert resolved.alias_name == "staging"


# ─── Render ───────────────────────────────────────────────────────────────────

class TestRender:
    def setup_method(self):
        self.registry = PromptRegistry(RegistryConfig(cache_enabled=False))
        self.registry.register("greet", "Hello, {{name}}! You have {{count}} messages.")

    def test_substitutes_all_variables(self):
        resolved = self.registry.resolve("greet")
        rendered = self.registry.render(resolved, {"name": "Alice", "count": "5"})
        assert rendered == "Hello, Alice! You have 5 messages."

    def test_raises_on_missing_variable(self):
        resolved = self.registry.resolve("greet")
        with pytest.raises(ValueError, match="Missing template variables"):
            self.registry.render(resolved, {"name": "Alice"})

    def test_renders_static_template_unchanged(self):
        self.registry.register("static", "No variables here.")
        resolved = self.registry.resolve("static")
        rendered = self.registry.render(resolved, {})
        assert rendered == "No variables here."


# ─── Alias management ─────────────────────────────────────────────────────────

class TestAliasManagement:
    def setup_method(self):
        self.registry = PromptRegistry(RegistryConfig(cache_enabled=False))
        self.registry.register("greet", "v1")
        self.registry.register("greet", "v2")

    def test_records_alias_change_in_audit_history(self):
        self.registry.set_alias("greet", "production", 1)
        self.registry.set_alias("greet", "production", 2)
        history = self.registry.get_alias_history("greet")
        assert len(history) == 2
        assert history[0].previous_version is None
        assert history[0].new_version == 1
        assert history[1].previous_version == 1
        assert history[1].new_version == 2

    def test_raises_on_non_existent_version(self):
        with pytest.raises(LookupError, match="version 99 not found"):
            self.registry.set_alias("greet", "production", 99)

    def test_lists_aliases_with_target_versions(self):
        self.registry.set_alias("greet", "production", 2)
        self.registry.set_alias("greet", "staging", 1)
        aliases = self.registry.list_aliases("greet")
        assert aliases["production"] == 2
        assert aliases["staging"] == 1

    def test_get_alias_history_returns_all_when_no_name(self):
        self.registry.register("other", "template")
        self.registry.set_alias("greet", "production", 1)
        self.registry.set_alias("other", "production", 1)
        all_history = self.registry.get_alias_history()
        assert len(all_history) == 2


# ─── Caching ──────────────────────────────────────────────────────────────────

class TestCaching:
    def test_caches_version_based_resolutions(self):
        registry = PromptRegistry(RegistryConfig(cache_enabled=True, cache_ttl_ms=10))
        registry.register("greet", "Hello")
        r1 = registry.resolve("greet", version=1)
        r2 = registry.resolve("greet", version=1)
        # Same object returned from cache
        assert r1 is r2

    def test_invalidates_cache_on_alias_change(self):
        registry = PromptRegistry(RegistryConfig(cache_enabled=True))
        registry.register("greet", "v1")
        registry.register("greet", "v2")
        registry.set_alias("greet", "production", 1)
        r1 = registry.resolve("greet")
        assert r1.version == 1

        registry.set_alias("greet", "production", 2)
        r2 = registry.resolve("greet")
        assert r2.version == 2

    def test_clear_cache_allows_fresh_resolution(self):
        registry = PromptRegistry(RegistryConfig(cache_enabled=True))
        registry.register("greet", "Hello")
        registry.resolve("greet", version=1)
        registry.clear_cache()
        r = registry.resolve("greet", version=1)
        assert r.version == 1


# ─── maxVersions archival ─────────────────────────────────────────────────────

class TestArchival:
    def test_archives_old_versions_when_limit_set(self):
        registry = PromptRegistry(RegistryConfig(max_versions=2, cache_enabled=False))
        registry.register("greet", "v1")
        registry.register("greet", "v2")
        registry.register("greet", "v3")  # triggers archival, v1 removed

        versions = registry.list_versions("greet")
        assert len(versions) == 2
        assert versions[0].template == "v2"
        assert versions[1].template == "v3"

    def test_version_numbers_do_not_reset_after_archival(self):
        registry = PromptRegistry(RegistryConfig(max_versions=2, cache_enabled=False))
        registry.register("greet", "v1")
        registry.register("greet", "v2")
        registry.register("greet", "v3")  # v1 archived
        v4 = registry.register("greet", "v4")
        assert v4.version == 4


# ─── InMemoryStorage ─────────────────────────────────────────────────────────

class TestInMemoryStorage:
    def test_returns_none_for_unknown_names(self):
        storage = InMemoryStorage()
        assert storage.get_version("x", 1) is None
        assert storage.get_latest_version("x") is None
        assert storage.list_versions("x") == []
        assert storage.get_alias("x", "production") is None
        assert storage.get_max_version("x") == 0

    def test_archive_old_versions_noop_within_limit(self):
        storage = InMemoryStorage()
        v = PromptVersion(
            name="greet", version=1, template="Hi", content_hash="abc",
            config=PromptConfig(), variables=[], created_at=datetime.now(),
        )
        storage.save_version(v)
        assert storage.archive_old_versions("greet", 5) == 0

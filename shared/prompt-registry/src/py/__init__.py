"""prompt-registry — Shared utility for versioned prompt management.

Three exports:
  1. InMemoryStorage  — default storage backend (testing / development)
  2. PromptRegistry   — versioned prompt store with alias management and caching
  3. All type exports — PromptVersion, ResolvedPrompt, RegistryStorage, etc.

Usage pattern:
  registry = PromptRegistry()
  registry.register('greet', 'Hello, {{name}}!')
  registry.set_alias('greet', 'production', 1)
  resolved = registry.resolve('greet')
  rendered = registry.render(resolved, {'name': 'Alice'})
"""

from __future__ import annotations

import hashlib
import math
import re
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime

from .types import (
    AliasChange,
    PromptConfig,
    PromptVersion,
    RegistryConfig,
    RegistryStorage,
    ResolvedPrompt,
)

__all__ = [
    "InMemoryStorage",
    "PromptRegistry",
    "AliasChange",
    "PromptConfig",
    "PromptVersion",
    "RegistryConfig",
    "RegistryStorage",
    "ResolvedPrompt",
]

# Double-brace syntax avoids collisions with Python's str.format() and f-strings.
_VARIABLE_RE = re.compile(r"\{\{(\w+)\}\}")


def _extract_variables(template: str) -> list[str]:
    """Extract unique variable names from a template, preserving first-seen order."""
    seen: set[str] = set()
    result: list[str] = []
    for match in _VARIABLE_RE.finditer(template):
        name = match.group(1)
        if name not in seen:
            seen.add(name)
            result.append(name)
    return result


def _content_hash(template: str) -> str:
    """SHA-256 content hash truncated to 12 hex chars."""
    return hashlib.sha256(template.encode()).hexdigest()[:12]


class InMemoryStorage:
    """In-memory storage backend for testing and development.

    Production deployments should implement the RegistryStorage protocol
    with a persistent backend (database, file system, key-value store, etc.).
    """

    def __init__(self) -> None:
        self._versions: dict[str, list[PromptVersion]] = defaultdict(list)
        self._aliases: dict[str, dict[str, int]] = defaultdict(dict)
        # Track max version number independently of list length so
        # archival doesn't cause version number collisions.
        self._max_version: dict[str, int] = defaultdict(int)

    def save_version(self, version: PromptVersion) -> None:
        self._versions[version.name].append(version)
        self._max_version[version.name] = max(
            self._max_version[version.name], version.version
        )

    def get_version(self, name: str, version: int) -> PromptVersion | None:
        # Linear scan is fine for expected version counts (<1000).
        return next((v for v in self._versions[name] if v.version == version), None)

    def get_latest_version(self, name: str) -> PromptVersion | None:
        versions = self._versions[name]
        return versions[-1] if versions else None

    def list_versions(self, name: str) -> list[PromptVersion]:
        return list(self._versions[name])

    def get_alias(self, name: str, alias: str) -> int | None:
        return self._aliases[name].get(alias)

    def set_alias(self, name: str, alias: str, version: int) -> None:
        self._aliases[name][alias] = version

    def list_aliases(self, name: str) -> dict[str, int]:
        return dict(self._aliases[name])

    def get_version_count(self, name: str) -> int:
        return len(self._versions[name])

    def get_max_version(self, name: str) -> int:
        return self._max_version[name]

    def archive_old_versions(self, name: str, keep_count: int) -> int:
        versions = self._versions[name]
        if len(versions) <= keep_count:
            return 0
        archive_count = len(versions) - keep_count
        self._versions[name] = versions[archive_count:]
        return archive_count


@dataclass
class _CacheEntry:
    prompt: ResolvedPrompt
    expires_at: float  # time.monotonic() value; float('inf') for version-based


class PromptRegistry:
    """Prompt Version Registry — the core abstraction.

    Manages immutable prompt versions with mutable alias pointers.

    Thread-safety note: this implementation is not thread-safe. For concurrent
    access, wrap with a threading.Lock or use a thread-safe storage backend.
    """

    def __init__(
        self,
        config: RegistryConfig | None = None,
        storage: RegistryStorage | None = None,
    ) -> None:
        self._config = config or RegistryConfig()
        self._storage: RegistryStorage = storage or InMemoryStorage()
        self._cache: dict[str, _CacheEntry] = {}
        self._alias_history: list[AliasChange] = []

    def register(
        self,
        name: str,
        template: str,
        config: PromptConfig | None = None,
    ) -> PromptVersion:
        """Register a new immutable prompt version. Returns the created version.

        Each call creates a new version — never overwrites an existing one.
        """
        if not name or not template:
            raise ValueError("Prompt name and template are required")

        variables = _extract_variables(template)

        if self._config.validate_template and "{{" in template and not variables:
            raise ValueError(
                'Template contains "{{" but no valid variables were found. '
                "Use {{variableName}} syntax."
            )

        next_version = self._storage.get_max_version(name) + 1

        version = PromptVersion(
            name=name,
            version=next_version,
            template=template,
            content_hash=_content_hash(template),
            config=config or PromptConfig(),
            variables=variables,
            created_at=datetime.now(),
        )

        self._storage.save_version(version)

        if (
            self._config.max_versions != math.inf
            and self._storage.get_version_count(name) > self._config.max_versions
        ):
            self._storage.archive_old_versions(name, int(self._config.max_versions))

        # Invalidate cached entries so the next resolve picks up the new version.
        self._invalidate_cache(name)
        return version

    def resolve(
        self,
        name: str,
        *,
        version: int | None = None,
        alias: str | None = None,
    ) -> ResolvedPrompt:
        """Resolve a prompt by name, optionally by version or alias.

        Resolution order: explicit version → explicit alias → default alias → latest.
        """
        cache_key = self._cache_key(name, version=version, alias=alias)

        if self._config.cache_enabled:
            entry = self._cache.get(cache_key)
            if entry is not None and time.monotonic() < entry.expires_at:
                return entry.prompt

        resolved_version: PromptVersion | None = None
        resolved_via: str
        alias_name: str | None = None

        if version is not None:
            resolved_version = self._storage.get_version(name, version)
            if resolved_version is None:
                raise LookupError(f'Prompt "{name}" version {version} not found')
            resolved_via = "version"
        else:
            alias_name = alias or self._config.default_alias
            alias_version = self._storage.get_alias(name, alias_name)

            if alias_version is not None:
                resolved_version = self._storage.get_version(name, alias_version)
                if resolved_version is None:
                    raise LookupError(
                        f'Prompt "{name}" alias "{alias_name}" points to '
                        f"version {alias_version} which doesn't exist"
                    )
                resolved_via = "alias"
            else:
                resolved_version = self._storage.get_latest_version(name)
                if resolved_version is None:
                    raise LookupError(f'Prompt "{name}" not found')
                resolved_via = "version"

        resolved = ResolvedPrompt(
            name=resolved_version.name,
            version=resolved_version.version,
            template=resolved_version.template,
            content_hash=resolved_version.content_hash,
            config=resolved_version.config,
            variables=resolved_version.variables,
            resolved_via=resolved_via,
            alias_name=alias_name if resolved_via == "alias" else None,
        )

        if self._config.cache_enabled:
            # Version-based: cache forever (content is immutable).
            # Alias-based: cache with TTL since the alias pointer can move.
            expires_at = (
                float("inf")
                if resolved_via == "version"
                else time.monotonic() + self._config.cache_ttl_ms / 1000
            )
            self._cache[cache_key] = _CacheEntry(prompt=resolved, expires_at=expires_at)

        return resolved

    def render(self, prompt: ResolvedPrompt, variables: dict[str, str]) -> str:
        """Render a resolved prompt by substituting {{variable}} placeholders.

        Raises ValueError if any variable declared in the template is missing.
        """
        missing = [v for v in prompt.variables if v not in variables]
        if missing:
            raise ValueError(
                f'Missing template variables for "{prompt.name}": {", ".join(missing)}'
            )

        def _replace(match: re.Match[str]) -> str:
            var_name = match.group(1)
            return variables.get(var_name, match.group(0))

        return _VARIABLE_RE.sub(_replace, prompt.template)

    def set_alias(self, name: str, alias: str, version: int) -> None:
        """Point an alias to a specific version. Verifies the version exists first.

        Records every change in an immutable audit trail.
        """
        existing = self._storage.get_version(name, version)
        if existing is None:
            raise LookupError(f'Prompt "{name}" version {version} not found')

        previous_version = self._storage.get_alias(name, alias)

        self._storage.set_alias(name, alias, version)

        self._alias_history.append(
            AliasChange(
                prompt_name=name,
                alias_name=alias,
                previous_version=previous_version,
                new_version=version,
                changed_at=datetime.now(),
            )
        )

        # Alias changed — invalidate alias-based cache entries.
        self._invalidate_cache(name)

    def list_versions(self, name: str) -> list[PromptVersion]:
        """List all stored versions for a prompt in registration order."""
        return self._storage.list_versions(name)

    def list_aliases(self, name: str) -> dict[str, int]:
        """List all aliases for a prompt and the version numbers they point to."""
        return self._storage.list_aliases(name)

    def get_alias_history(self, name: str | None = None) -> list[AliasChange]:
        """Alias change audit trail — filter by prompt name or get all."""
        if name is not None:
            return [c for c in self._alias_history if c.prompt_name == name]
        return list(self._alias_history)

    def clear_cache(self) -> None:
        """Force-clear the resolve cache — useful during incident mitigation."""
        self._cache.clear()

    def _cache_key(
        self,
        name: str,
        *,
        version: int | None = None,
        alias: str | None = None,
    ) -> str:
        if version is not None:
            return f"{name}@v{version}"
        return f"{name}@{alias or self._config.default_alias}"

    def _invalidate_cache(self, name: str) -> None:
        keys_to_remove = [k for k in self._cache if k.startswith(f"{name}@")]
        for key in keys_to_remove:
            del self._cache[key]

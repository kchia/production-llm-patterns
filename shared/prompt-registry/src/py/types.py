"""Type definitions for the shared prompt-registry utility.

Uses dataclasses for value types and Protocol for the storage interface,
following Python conventions rather than translating TypeScript interfaces.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol


@dataclass(frozen=True)
class PromptConfig:
    """Configuration stored alongside a prompt version."""

    model: str | None = None
    temperature: float | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    commit_message: str | None = None


@dataclass(frozen=True)
class PromptVersion:
    """A single immutable prompt version."""

    name: str
    version: int
    template: str
    content_hash: str  # SHA-256, first 12 hex chars
    config: PromptConfig
    variables: list[str]
    created_at: datetime


@dataclass(frozen=True)
class ResolvedPrompt:
    """Result of resolving a prompt — version data plus resolution metadata."""

    name: str
    version: int
    template: str
    content_hash: str
    config: PromptConfig
    variables: list[str]
    resolved_via: str  # "version" or "alias"
    alias_name: str | None = None


@dataclass(frozen=True)
class AliasChange:
    """Audit record for an alias mutation."""

    prompt_name: str
    alias_name: str
    previous_version: int | None
    new_version: int
    changed_at: datetime


@dataclass
class RegistryConfig:
    """Registry configuration with sensible defaults."""

    cache_enabled: bool = True
    cache_ttl_ms: float = 60_000
    default_alias: str = "production"
    max_versions: float = math.inf
    validate_template: bool = True


class RegistryStorage(Protocol):
    """Storage backend interface. Implement for production persistence."""

    def save_version(self, version: PromptVersion) -> None: ...
    def get_version(self, name: str, version: int) -> PromptVersion | None: ...
    def get_latest_version(self, name: str) -> PromptVersion | None: ...
    def list_versions(self, name: str) -> list[PromptVersion]: ...
    def get_alias(self, name: str, alias: str) -> int | None: ...
    def set_alias(self, name: str, alias: str, version: int) -> None: ...
    def list_aliases(self, name: str) -> dict[str, int]: ...
    def get_version_count(self, name: str) -> int: ...
    def get_max_version(self, name: str) -> int: ...
    def archive_old_versions(self, name: str, keep_count: int) -> int: ...

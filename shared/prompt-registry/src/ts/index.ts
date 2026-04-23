/**
 * prompt-registry — Shared utility for versioned prompt management.
 *
 * Three exports:
 *   1. InMemoryStorage  — default storage backend (testing / development)
 *   2. PromptRegistry   — versioned prompt store with alias management and caching
 *   3. All type exports — PromptVersion, ResolvedPrompt, RegistryStorage, etc.
 *
 * Usage pattern:
 *   const registry = new PromptRegistry();
 *   registry.register('greet', 'Hello, {{name}}!');
 *   registry.setAlias('greet', 'production', 1);
 *   const resolved = registry.resolve('greet');
 *   const rendered = registry.render(resolved, { name: 'Alice' });
 */

import { createHash } from "crypto";
import type {
  AliasChange,
  PromptConfig,
  PromptVersion,
  RegistryConfig,
  RegistryStorage,
  ResolvedPrompt,
  ResolveOptions,
} from "./types.js";

export type {
  AliasChange,
  PromptConfig,
  PromptVersion,
  RegistryConfig,
  RegistryStorage,
  ResolvedPrompt,
  ResolveOptions,
} from "./types.js";

// Double-brace syntax avoids collisions with single-brace interpolation
// in most template languages and shell scripts.
const VARIABLE_PATTERN = /\{\{(\w+)\}\}/g;

/** Extract unique variable names from a template string */
function extractVariables(template: string): string[] {
  const vars = new Set<string>();
  let match: RegExpExecArray | null;
  // Reset lastIndex before each use — global regexes are stateful.
  VARIABLE_PATTERN.lastIndex = 0;
  while ((match = VARIABLE_PATTERN.exec(template)) !== null) {
    vars.add(match[1]);
  }
  return Array.from(vars);
}

/** SHA-256 content hash truncated to 12 hex chars */
function contentHash(template: string): string {
  return createHash("sha256").update(template).digest("hex").slice(0, 12);
}

/** Cache entry with TTL tracking */
interface CacheEntry {
  prompt: ResolvedPrompt;
  /** Infinity for version-based lookups (immutable); Date.now() + TTL for alias-based */
  expiresAt: number;
}

/**
 * In-memory storage backend. Suitable for testing and development.
 * Production deployments should implement RegistryStorage with a
 * persistent backend (database, file system, key-value store, etc.).
 */
export class InMemoryStorage implements RegistryStorage {
  private versions = new Map<string, PromptVersion[]>();
  private aliases = new Map<string, Map<string, number>>();
  // Track highest version number independently of the stored list so
  // archival doesn't cause version number collisions.
  private maxVersionNum = new Map<string, number>();

  saveVersion(version: PromptVersion): void {
    const existing = this.versions.get(version.name) ?? [];
    existing.push(version);
    this.versions.set(version.name, existing);
    const current = this.maxVersionNum.get(version.name) ?? 0;
    this.maxVersionNum.set(version.name, Math.max(current, version.version));
  }

  getVersion(name: string, version: number): PromptVersion | undefined {
    return this.versions.get(name)?.find((v) => v.version === version);
  }

  getLatestVersion(name: string): PromptVersion | undefined {
    const versions = this.versions.get(name);
    if (!versions || versions.length === 0) return undefined;
    return versions[versions.length - 1];
  }

  listVersions(name: string): PromptVersion[] {
    return this.versions.get(name) ?? [];
  }

  getAlias(name: string, alias: string): number | undefined {
    return this.aliases.get(name)?.get(alias);
  }

  setAlias(name: string, alias: string, version: number): void {
    let promptAliases = this.aliases.get(name);
    if (!promptAliases) {
      promptAliases = new Map();
      this.aliases.set(name, promptAliases);
    }
    promptAliases.set(alias, version);
  }

  listAliases(name: string): Map<string, number> {
    return this.aliases.get(name) ?? new Map();
  }

  getVersionCount(name: string): number {
    return this.versions.get(name)?.length ?? 0;
  }

  getMaxVersion(name: string): number {
    return this.maxVersionNum.get(name) ?? 0;
  }

  archiveOldVersions(name: string, keepCount: number): number {
    const versions = this.versions.get(name);
    if (!versions || versions.length <= keepCount) return 0;
    const archiveCount = versions.length - keepCount;
    this.versions.set(name, versions.slice(archiveCount));
    return archiveCount;
  }
}

/**
 * Prompt Version Registry — the core abstraction.
 *
 * Manages immutable prompt versions with mutable alias pointers.
 * Versions are permanent records; aliases are movable labels
 * (e.g., "production", "staging") pointing to a specific version number.
 *
 * Thread safety: this implementation is not thread-safe. For concurrent
 * access, wrap with a Mutex or use a thread-safe RegistryStorage backend.
 */
export class PromptRegistry {
  private config: Required<RegistryConfig>;
  private storage: RegistryStorage;
  private cache = new Map<string, CacheEntry>();
  private aliasHistory: AliasChange[] = [];

  constructor(config: RegistryConfig = {}, storage?: RegistryStorage) {
    this.config = {
      cacheEnabled: config.cacheEnabled ?? true,
      cacheTTL: config.cacheTTL ?? 60_000,
      defaultAlias: config.defaultAlias ?? "production",
      maxVersions: config.maxVersions ?? Infinity,
      validateTemplate: config.validateTemplate ?? true,
    };
    this.storage = storage ?? new InMemoryStorage();
  }

  /**
   * Register a new immutable prompt version. Returns the created version.
   * Each call creates a new version — never overwrites an existing one.
   */
  register(name: string, template: string, config: PromptConfig = {}): PromptVersion {
    if (!name || !template) {
      throw new Error("Prompt name and template are required");
    }

    const variables = extractVariables(template);

    if (this.config.validateTemplate && template.includes("{{") && variables.length === 0) {
      throw new Error(
        `Template contains "{{" but no valid variables were found. Use {{variableName}} syntax.`
      );
    }

    const nextVersion = this.storage.getMaxVersion(name) + 1;

    const version: PromptVersion = {
      name,
      version: nextVersion,
      template,
      contentHash: contentHash(template),
      config,
      variables,
      createdAt: new Date(),
    };

    this.storage.saveVersion(version);

    if (
      this.config.maxVersions !== Infinity &&
      this.storage.getVersionCount(name) > this.config.maxVersions
    ) {
      this.storage.archiveOldVersions(name, this.config.maxVersions);
    }

    // Invalidate cached entries so the next resolve picks up the new version.
    this.invalidateCache(name);

    return version;
  }

  /**
   * Resolve a prompt by name, optionally by explicit version number or alias.
   * Resolution order: explicit version → explicit alias → default alias → latest.
   */
  resolve(name: string, opts: ResolveOptions = {}): ResolvedPrompt {
    const cacheKey = this.cacheKey(name, opts);

    if (this.config.cacheEnabled) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) {
        return cached.prompt;
      }
    }

    let version: PromptVersion | undefined;
    let resolvedVia: "version" | "alias";
    let aliasName: string | undefined;

    if (opts.version !== undefined) {
      version = this.storage.getVersion(name, opts.version);
      if (!version) {
        throw new Error(`Prompt "${name}" version ${opts.version} not found`);
      }
      resolvedVia = "version";
    } else {
      aliasName = opts.alias ?? this.config.defaultAlias;
      const aliasVersion = this.storage.getAlias(name, aliasName);

      if (aliasVersion !== undefined) {
        version = this.storage.getVersion(name, aliasVersion);
        if (!version) {
          throw new Error(
            `Prompt "${name}" alias "${aliasName}" points to version ${aliasVersion} which doesn't exist`
          );
        }
        resolvedVia = "alias";
      } else {
        // No alias set — fall back to latest version.
        version = this.storage.getLatestVersion(name);
        if (!version) {
          throw new Error(`Prompt "${name}" not found`);
        }
        resolvedVia = "version";
      }
    }

    const resolved: ResolvedPrompt = {
      name: version.name,
      version: version.version,
      template: version.template,
      contentHash: version.contentHash,
      config: version.config,
      variables: version.variables,
      resolvedVia,
      aliasName,
    };

    if (this.config.cacheEnabled) {
      // Version-based lookups are cached forever (content is immutable).
      // Alias-based lookups use TTL since the alias pointer can move.
      const expiresAt =
        resolvedVia === "version"
          ? Infinity
          : Date.now() + this.config.cacheTTL;
      this.cache.set(cacheKey, { prompt: resolved, expiresAt });
    }

    return resolved;
  }

  /**
   * Render a resolved prompt by substituting {{variable}} placeholders.
   * Throws if any variable declared in the template is missing from `variables`.
   */
  render(prompt: ResolvedPrompt, variables: Record<string, string>): string {
    const missing = prompt.variables.filter((v) => !(v in variables));
    if (missing.length > 0) {
      throw new Error(
        `Missing template variables for "${prompt.name}": ${missing.join(", ")}`
      );
    }

    // Reset lastIndex — VARIABLE_PATTERN is global and stateful.
    VARIABLE_PATTERN.lastIndex = 0;
    return prompt.template.replace(VARIABLE_PATTERN, (_, varName) => {
      return variables[varName] ?? `{{${varName}}}`;
    });
  }

  /**
   * Point an alias to a specific version. Verifies the version exists first.
   * Records every change in an immutable audit trail.
   */
  setAlias(name: string, alias: string, version: number): void {
    const existing = this.storage.getVersion(name, version);
    if (!existing) {
      throw new Error(`Prompt "${name}" version ${version} not found`);
    }

    const previousVersion = this.storage.getAlias(name, alias) ?? null;
    this.storage.setAlias(name, alias, version);

    this.aliasHistory.push({
      promptName: name,
      aliasName: alias,
      previousVersion,
      newVersion: version,
      changedAt: new Date(),
    });

    // Alias changed — invalidate alias-based cache entries.
    this.invalidateCache(name);
  }

  /** List all stored versions for a prompt in registration order */
  listVersions(name: string): PromptVersion[] {
    return this.storage.listVersions(name);
  }

  /** List all aliases for a prompt and the version numbers they point to */
  listAliases(name: string): Map<string, number> {
    return this.storage.listAliases(name);
  }

  /** Alias change audit trail — filter by prompt name or get all */
  getAliasHistory(name?: string): AliasChange[] {
    if (name) {
      return this.aliasHistory.filter((c) => c.promptName === name);
    }
    return [...this.aliasHistory];
  }

  /** Force-clear the resolve cache — useful during incident mitigation */
  clearCache(): void {
    this.cache.clear();
  }

  private cacheKey(name: string, opts: ResolveOptions): string {
    if (opts.version !== undefined) return `${name}@v${opts.version}`;
    return `${name}@${opts.alias ?? this.config.defaultAlias}`;
  }

  private invalidateCache(name: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${name}@`)) {
        this.cache.delete(key);
      }
    }
  }
}

import { createHash } from "crypto";
import type {
  PromptConfig,
  PromptVersion,
  ResolvedPrompt,
  ResolveOptions,
  AliasChange,
  RegistryConfig,
  RegistryStorage,
} from "./types";

// Template variables use {{varName}} syntax — double braces to avoid
// collisions with single-brace string interpolation in most languages.
const VARIABLE_PATTERN = /\{\{(\w+)\}\}/g;

/** Extract variable names from a template string */
function extractVariables(template: string): string[] {
  const vars = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = VARIABLE_PATTERN.exec(template)) !== null) {
    vars.add(match[1]);
  }
  return Array.from(vars);
}

/** Compute a content hash for immutability verification */
function contentHash(template: string): string {
  return createHash("sha256").update(template).digest("hex").slice(0, 12);
}

/**
 * In-memory storage backend. Suitable for testing and development.
 * Production deployments should implement RegistryStorage with a
 * persistent backend (database, file system, etc.).
 */
export class InMemoryStorage implements RegistryStorage {
  private versions = new Map<string, PromptVersion[]>();
  private aliases = new Map<string, Map<string, number>>();
  // Track highest version number per prompt independently of array length,
  // so archival doesn't cause version number collisions.
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

/** Cache entry with TTL tracking */
interface CacheEntry {
  prompt: ResolvedPrompt;
  expiresAt: number; // Infinity for version-based, Date.now() + TTL for alias-based
}

/**
 * Prompt Version Registry — the core abstraction.
 *
 * Manages immutable prompt versions with mutable alias pointers.
 * Versions are permanent records; aliases are movable labels like
 * "production" or "staging" that point to a specific version.
 */
export class PromptRegistry {
  private config: Required<RegistryConfig>;
  private storage: RegistryStorage;
  private cache = new Map<string, CacheEntry>();
  private aliasHistory: AliasChange[] = [];

  constructor(
    config: RegistryConfig = {},
    storage?: RegistryStorage
  ) {
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
   * Register a new prompt version. Returns the created version.
   * Each call creates a new immutable version — never overwrites.
   */
  register(
    name: string,
    template: string,
    config: PromptConfig = {}
  ): PromptVersion {
    if (!name || !template) {
      throw new Error("Prompt name and template are required");
    }

    const variables = extractVariables(template);

    if (this.config.validateTemplate && template.includes("{{") && variables.length === 0) {
      throw new Error(
        `Template contains "{{" but no valid variables were found. ` +
        `Use {{variableName}} syntax.`
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

    // Archive old versions if maxVersions is set
    if (
      this.config.maxVersions !== Infinity &&
      this.storage.getVersionCount(name) > this.config.maxVersions
    ) {
      this.storage.archiveOldVersions(name, this.config.maxVersions);
    }

    // Invalidate cached entries for this prompt
    this.invalidateCache(name);

    return version;
  }

  /**
   * Resolve a prompt by name, optionally specifying a version or alias.
   * Resolution order: explicit version > explicit alias > default alias > latest.
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
      // Explicit version — direct lookup
      version = this.storage.getVersion(name, opts.version);
      if (!version) {
        throw new Error(`Prompt "${name}" version ${opts.version} not found`);
      }
      resolvedVia = "version";
    } else {
      // Alias-based resolution
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
        // No alias set — fall back to latest version
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
      // Version-based resolution is cached forever (immutable).
      // Alias-based resolution uses TTL (alias can move).
      const expiresAt =
        resolvedVia === "version"
          ? Infinity
          : Date.now() + this.config.cacheTTL;
      this.cache.set(cacheKey, { prompt: resolved, expiresAt });
    }

    return resolved;
  }

  /**
   * Render a resolved prompt by substituting template variables.
   * Throws if a required variable is missing.
   */
  render(
    prompt: ResolvedPrompt,
    variables: Record<string, string>
  ): string {
    const missing = prompt.variables.filter(
      (v) => !(v in variables)
    );
    if (missing.length > 0) {
      throw new Error(
        `Missing template variables for "${prompt.name}": ${missing.join(", ")}`
      );
    }

    return prompt.template.replace(VARIABLE_PATTERN, (_, varName) => {
      return variables[varName] ?? `{{${varName}}}`;
    });
  }

  /**
   * Set an alias to point to a specific version.
   * Records the change in audit history.
   */
  setAlias(name: string, alias: string, version: number): void {
    // Verify the version exists
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

    // Invalidate alias-based cache entries
    this.invalidateCache(name);
  }

  /** List all versions for a prompt */
  listVersions(name: string): PromptVersion[] {
    return this.storage.listVersions(name);
  }

  /** List all aliases for a prompt */
  listAliases(name: string): Map<string, number> {
    return this.storage.listAliases(name);
  }

  /** Get alias change audit trail */
  getAliasHistory(name?: string): AliasChange[] {
    if (name) {
      return this.aliasHistory.filter((c) => c.promptName === name);
    }
    return [...this.aliasHistory];
  }

  /** Force-clear cache (emergency use during incidents) */
  clearCache(): void {
    this.cache.clear();
  }

  private cacheKey(name: string, opts: ResolveOptions): string {
    if (opts.version !== undefined) return `${name}@v${opts.version}`;
    const alias = opts.alias ?? this.config.defaultAlias;
    return `${name}@${alias}`;
  }

  private invalidateCache(name: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${name}@`)) {
        this.cache.delete(key);
      }
    }
  }
}

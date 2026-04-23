/** Configuration stored alongside a prompt version */
export interface PromptConfig {
  /** Model this prompt is designed for (informational, not enforced) */
  model?: string;
  /** Temperature recommendation */
  temperature?: number;
  /** Additional metadata stored with the version */
  metadata?: Record<string, unknown>;
  /** Description of what changed in this version */
  commitMessage?: string;
}

/** A single immutable prompt version */
export interface PromptVersion {
  name: string;
  version: number;
  template: string;
  /** SHA-256 hash of the template content (first 12 hex chars) */
  contentHash: string;
  config: PromptConfig;
  /** Variable names extracted from {{placeholder}} syntax */
  variables: string[];
  createdAt: Date;
}

/** Result of resolving a prompt — version data plus resolution metadata */
export interface ResolvedPrompt {
  name: string;
  version: number;
  template: string;
  contentHash: string;
  config: PromptConfig;
  variables: string[];
  /** How the prompt was resolved */
  resolvedVia: "version" | "alias";
  /** Alias name if resolved via alias */
  aliasName?: string;
}

/** Options for resolving a prompt */
export interface ResolveOptions {
  /** Resolve a specific version number */
  version?: number;
  /** Resolve via alias name (e.g., "production", "staging") */
  alias?: string;
}

/** Audit record of an alias change */
export interface AliasChange {
  promptName: string;
  aliasName: string;
  previousVersion: number | null;
  newVersion: number;
  changedAt: Date;
}

/** Registry configuration with sensible defaults */
export interface RegistryConfig {
  /** Whether to cache resolved prompts (default: true) */
  cacheEnabled?: boolean;
  /** Cache TTL in milliseconds for alias-based resolution (default: 60000) */
  cacheTTL?: number;
  /** Default alias when no version or alias is specified (default: "production") */
  defaultAlias?: string;
  /** Maximum versions to keep per prompt before archiving (default: unlimited) */
  maxVersions?: number;
  /** Whether to validate {{placeholder}} syntax on registration (default: true) */
  validateTemplate?: boolean;
}

/** Storage backend interface — implement for persistent backends */
export interface RegistryStorage {
  saveVersion(version: PromptVersion): void;
  getVersion(name: string, version: number): PromptVersion | undefined;
  getLatestVersion(name: string): PromptVersion | undefined;
  listVersions(name: string): PromptVersion[];
  getAlias(name: string, alias: string): number | undefined;
  setAlias(name: string, alias: string, version: number): void;
  listAliases(name: string): Map<string, number>;
  getVersionCount(name: string): number;
  /** Returns the highest version number ever assigned (survives archival) */
  getMaxVersion(name: string): number;
  archiveOldVersions(name: string, keepCount: number): number;
}

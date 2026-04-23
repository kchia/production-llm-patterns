import { describe, it, expect, beforeEach } from "vitest";
import { PromptRegistry, InMemoryStorage } from "../index.js";

// ─── Unit tests ───────────────────────────────────────────────────────────────

describe("PromptRegistry — registration", () => {
  let registry: PromptRegistry;

  beforeEach(() => {
    registry = new PromptRegistry({ cacheEnabled: false });
  });

  it("assigns version 1 to the first registration", () => {
    const v = registry.register("greet", "Hello, {{name}}!");
    expect(v.version).toBe(1);
    expect(v.name).toBe("greet");
    expect(v.variables).toEqual(["name"]);
  });

  it("increments version numbers monotonically", () => {
    registry.register("greet", "Hello, {{name}}!");
    const v2 = registry.register("greet", "Hi there, {{name}}!");
    expect(v2.version).toBe(2);
  });

  it("computes a stable content hash", () => {
    const v1 = registry.register("greet", "Hello, {{name}}!");
    const v2 = registry.register("greet", "Hello, {{name}}!");
    // Same template → same hash
    expect(v1.contentHash).toBe(v2.contentHash);
  });

  it("rejects a registration with no name", () => {
    expect(() => registry.register("", "Hello")).toThrow("required");
  });

  it("rejects a registration with no template", () => {
    expect(() => registry.register("greet", "")).toThrow("required");
  });

  it("extracts multiple distinct variables from template", () => {
    const v = registry.register("summary", "{{user}} asked: {{query}}. Answer: {{answer}}");
    expect(v.variables).toEqual(["user", "query", "answer"]);
  });

  it("stores createdAt as a Date", () => {
    const v = registry.register("greet", "Hi");
    expect(v.createdAt).toBeInstanceOf(Date);
  });
});

// ─── Resolution tests ─────────────────────────────────────────────────────────

describe("PromptRegistry — resolve", () => {
  let registry: PromptRegistry;

  beforeEach(() => {
    registry = new PromptRegistry({ cacheEnabled: false });
    registry.register("greet", "Hello, {{name}}!");
    registry.register("greet", "Greetings, {{name}}!");
  });

  it("resolves the latest version when no alias is set", () => {
    const resolved = registry.resolve("greet");
    expect(resolved.version).toBe(2);
    expect(resolved.resolvedVia).toBe("version");
  });

  it("resolves a specific version by number", () => {
    const resolved = registry.resolve("greet", { version: 1 });
    expect(resolved.version).toBe(1);
    expect(resolved.template).toBe("Hello, {{name}}!");
  });

  it("resolves via alias after setAlias", () => {
    registry.setAlias("greet", "production", 1);
    const resolved = registry.resolve("greet");
    expect(resolved.version).toBe(1);
    expect(resolved.resolvedVia).toBe("alias");
    expect(resolved.aliasName).toBe("production");
  });

  it("throws on unknown prompt name", () => {
    expect(() => registry.resolve("unknown")).toThrow('"unknown" not found');
  });

  it("throws on unknown version number", () => {
    expect(() => registry.resolve("greet", { version: 99 })).toThrow("version 99 not found");
  });

  it("resolves via explicit alias name (non-default)", () => {
    registry.setAlias("greet", "staging", 1);
    const resolved = registry.resolve("greet", { alias: "staging" });
    expect(resolved.version).toBe(1);
    expect(resolved.aliasName).toBe("staging");
  });
});

// ─── Render tests ─────────────────────────────────────────────────────────────

describe("PromptRegistry — render", () => {
  let registry: PromptRegistry;

  beforeEach(() => {
    registry = new PromptRegistry({ cacheEnabled: false });
    registry.register("greet", "Hello, {{name}}! You have {{count}} messages.");
  });

  it("substitutes all template variables", () => {
    const resolved = registry.resolve("greet");
    const rendered = registry.render(resolved, { name: "Alice", count: "5" });
    expect(rendered).toBe("Hello, Alice! You have 5 messages.");
  });

  it("throws when a required variable is missing", () => {
    const resolved = registry.resolve("greet");
    expect(() => registry.render(resolved, { name: "Alice" })).toThrow("Missing template variables");
    expect(() => registry.render(resolved, { name: "Alice" })).toThrow("count");
  });

  it("renders templates with no variables unchanged", () => {
    registry.register("static", "This prompt has no variables.");
    const resolved = registry.resolve("static");
    const rendered = registry.render(resolved, {});
    expect(rendered).toBe("This prompt has no variables.");
  });
});

// ─── Alias management tests ───────────────────────────────────────────────────

describe("PromptRegistry — alias management", () => {
  let registry: PromptRegistry;

  beforeEach(() => {
    registry = new PromptRegistry({ cacheEnabled: false });
    registry.register("greet", "v1");
    registry.register("greet", "v2");
  });

  it("records alias change in audit history", () => {
    registry.setAlias("greet", "production", 1);
    registry.setAlias("greet", "production", 2);

    const history = registry.getAliasHistory("greet");
    expect(history).toHaveLength(2);
    expect(history[0].previousVersion).toBeNull();
    expect(history[0].newVersion).toBe(1);
    expect(history[1].previousVersion).toBe(1);
    expect(history[1].newVersion).toBe(2);
  });

  it("throws when setting alias to non-existent version", () => {
    expect(() => registry.setAlias("greet", "production", 99)).toThrow("version 99 not found");
  });

  it("lists aliases with their target versions", () => {
    registry.setAlias("greet", "production", 2);
    registry.setAlias("greet", "staging", 1);
    const aliases = registry.listAliases("greet");
    expect(aliases.get("production")).toBe(2);
    expect(aliases.get("staging")).toBe(1);
  });

  it("getAliasHistory returns all history when no name filter", () => {
    registry.register("other", "template");
    registry.setAlias("greet", "production", 1);
    registry.setAlias("other", "production", 1);
    const all = registry.getAliasHistory();
    expect(all).toHaveLength(2);
  });
});

// ─── Caching tests ────────────────────────────────────────────────────────────

describe("PromptRegistry — caching", () => {
  it("caches version-based resolutions indefinitely", () => {
    const registry = new PromptRegistry({ cacheEnabled: true, cacheTTL: 10 });
    registry.register("greet", "Hello");
    const r1 = registry.resolve("greet", { version: 1 });
    const r2 = registry.resolve("greet", { version: 1 });
    // Same reference because it was served from cache
    expect(r1).toBe(r2);
  });

  it("invalidates cache on new version registration", () => {
    const registry = new PromptRegistry({ cacheEnabled: true });
    registry.register("greet", "v1");
    registry.setAlias("greet", "production", 1);
    const r1 = registry.resolve("greet");
    expect(r1.version).toBe(1);

    // Register v2 and move alias — cache must be invalidated
    registry.register("greet", "v2");
    registry.setAlias("greet", "production", 2);
    const r2 = registry.resolve("greet");
    expect(r2.version).toBe(2);
  });

  it("clearCache removes all cached entries", () => {
    const registry = new PromptRegistry({ cacheEnabled: true });
    registry.register("greet", "Hello");
    registry.resolve("greet", { version: 1 }); // populate cache
    registry.clearCache();
    // After clear, resolution still works (from storage)
    const r = registry.resolve("greet", { version: 1 });
    expect(r.version).toBe(1);
  });
});

// ─── archival / maxVersions tests ────────────────────────────────────────────

describe("PromptRegistry — maxVersions archival", () => {
  it("archives old versions when maxVersions is set", () => {
    const registry = new PromptRegistry({ maxVersions: 2, cacheEnabled: false });
    registry.register("greet", "v1");
    registry.register("greet", "v2");
    registry.register("greet", "v3"); // triggers archival, v1 is removed

    const versions = registry.listVersions("greet");
    expect(versions).toHaveLength(2);
    expect(versions[0].template).toBe("v2");
    expect(versions[1].template).toBe("v3");
  });

  it("version numbers don't reset after archival", () => {
    const registry = new PromptRegistry({ maxVersions: 2, cacheEnabled: false });
    registry.register("greet", "v1");
    registry.register("greet", "v2");
    registry.register("greet", "v3"); // v1 archived
    const v4 = registry.register("greet", "v4");
    expect(v4.version).toBe(4);
  });
});

// ─── InMemoryStorage tests ────────────────────────────────────────────────────

describe("InMemoryStorage", () => {
  it("returns undefined for unknown names", () => {
    const storage = new InMemoryStorage();
    expect(storage.getVersion("x", 1)).toBeUndefined();
    expect(storage.getLatestVersion("x")).toBeUndefined();
    expect(storage.listVersions("x")).toEqual([]);
    expect(storage.getAlias("x", "production")).toBeUndefined();
    expect(storage.getMaxVersion("x")).toBe(0);
  });

  it("archiveOldVersions is a no-op when count is within limit", () => {
    const storage = new InMemoryStorage();
    const v: import("../types.js").PromptVersion = {
      name: "greet", version: 1, template: "Hi", contentHash: "abc",
      config: {}, variables: [], createdAt: new Date(),
    };
    storage.saveVersion(v);
    expect(storage.archiveOldVersions("greet", 5)).toBe(0);
  });
});

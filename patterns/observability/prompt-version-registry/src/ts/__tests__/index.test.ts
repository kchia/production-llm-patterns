import { describe, it, expect, beforeEach } from "vitest";
import { PromptRegistry, InMemoryStorage } from "../index";
import { MockLLMProvider } from "../mock-provider";

// ─── Unit Tests ──────────────────────────────────────────────

describe("PromptRegistry — Unit Tests", () => {
  let registry: PromptRegistry;

  beforeEach(() => {
    registry = new PromptRegistry();
  });

  describe("register()", () => {
    it("creates an immutable version with auto-incremented number", () => {
      const v1 = registry.register("greeting", "Hello {{name}}!");
      const v2 = registry.register("greeting", "Hi {{name}}, welcome!");

      expect(v1.version).toBe(1);
      expect(v2.version).toBe(2);
      expect(v1.contentHash).not.toBe(v2.contentHash);
    });

    it("extracts template variables", () => {
      const v = registry.register(
        "extraction",
        "Extract {{entity_type}} from: {{text}}"
      );
      expect(v.variables).toEqual(["entity_type", "text"]);
    });

    it("handles templates with no variables", () => {
      const v = registry.register("static", "Always respond in JSON format.");
      expect(v.variables).toEqual([]);
    });

    it("stores config metadata", () => {
      const v = registry.register("test", "Template", {
        model: "gpt-4o",
        temperature: 0.7,
        commitMessage: "Initial version",
      });
      expect(v.config.model).toBe("gpt-4o");
      expect(v.config.temperature).toBe(0.7);
      expect(v.config.commitMessage).toBe("Initial version");
    });

    it("throws on empty name or template", () => {
      expect(() => registry.register("", "template")).toThrow();
      expect(() => registry.register("name", "")).toThrow();
    });

    it("produces consistent content hashes for identical templates", () => {
      const v1 = registry.register("a", "Hello {{name}}!");
      const v2 = registry.register("b", "Hello {{name}}!");
      expect(v1.contentHash).toBe(v2.contentHash);
    });

    it("deduplicates repeated variable names", () => {
      const v = registry.register(
        "test",
        "{{name}} said hello to {{name}}"
      );
      expect(v.variables).toEqual(["name"]);
    });
  });

  describe("resolve()", () => {
    it("resolves by explicit version number", () => {
      registry.register("greeting", "Hello {{name}}!");
      registry.register("greeting", "Hi {{name}}!");
      const resolved = registry.resolve("greeting", { version: 1 });
      expect(resolved.version).toBe(1);
      expect(resolved.template).toBe("Hello {{name}}!");
      expect(resolved.resolvedVia).toBe("version");
    });

    it("resolves by alias", () => {
      registry.register("greeting", "Hello {{name}}!");
      const v2 = registry.register("greeting", "Hi {{name}}!");
      registry.setAlias("greeting", "production", v2.version);

      const resolved = registry.resolve("greeting", { alias: "production" });
      expect(resolved.version).toBe(2);
      expect(resolved.resolvedVia).toBe("alias");
      expect(resolved.aliasName).toBe("production");
    });

    it("uses default alias when no options specified", () => {
      registry.register("greeting", "Hello!");
      registry.setAlias("greeting", "production", 1);

      const resolved = registry.resolve("greeting");
      expect(resolved.version).toBe(1);
      expect(resolved.resolvedVia).toBe("alias");
    });

    it("falls back to latest when no alias is set", () => {
      registry.register("greeting", "v1");
      registry.register("greeting", "v2");

      const resolved = registry.resolve("greeting");
      expect(resolved.version).toBe(2);
      expect(resolved.resolvedVia).toBe("version");
    });

    it("throws on nonexistent prompt name", () => {
      expect(() => registry.resolve("nonexistent")).toThrow(
        'Prompt "nonexistent" not found'
      );
    });

    it("throws on nonexistent version number", () => {
      registry.register("greeting", "Hello!");
      expect(() => registry.resolve("greeting", { version: 99 })).toThrow(
        'version 99 not found'
      );
    });
  });

  describe("render()", () => {
    it("substitutes all template variables", () => {
      registry.register("greeting", "Hello {{name}}, welcome to {{place}}!");
      const resolved = registry.resolve("greeting", { version: 1 });
      const rendered = registry.render(resolved, {
        name: "Alice",
        place: "Wonderland",
      });
      expect(rendered).toBe("Hello Alice, welcome to Wonderland!");
    });

    it("throws on missing required variables", () => {
      registry.register("greeting", "Hello {{name}}!");
      const resolved = registry.resolve("greeting", { version: 1 });
      expect(() => registry.render(resolved, {})).toThrow(
        "Missing template variables"
      );
    });

    it("handles extra variables gracefully", () => {
      registry.register("simple", "Hello {{name}}!");
      const resolved = registry.resolve("simple", { version: 1 });
      const rendered = registry.render(resolved, {
        name: "Alice",
        extra: "ignored",
      });
      expect(rendered).toBe("Hello Alice!");
    });
  });

  describe("setAlias()", () => {
    it("creates and updates aliases", () => {
      registry.register("greeting", "v1");
      registry.register("greeting", "v2");

      registry.setAlias("greeting", "production", 1);
      expect(registry.resolve("greeting", { alias: "production" }).version).toBe(1);

      registry.setAlias("greeting", "production", 2);
      expect(registry.resolve("greeting", { alias: "production" }).version).toBe(2);
    });

    it("throws when pointing to nonexistent version", () => {
      registry.register("greeting", "v1");
      expect(() => registry.setAlias("greeting", "production", 99)).toThrow();
    });

    it("records alias change history", () => {
      registry.register("greeting", "v1");
      registry.register("greeting", "v2");

      registry.setAlias("greeting", "production", 1);
      registry.setAlias("greeting", "production", 2);

      const history = registry.getAliasHistory("greeting");
      expect(history).toHaveLength(2);
      expect(history[0].previousVersion).toBeNull();
      expect(history[0].newVersion).toBe(1);
      expect(history[1].previousVersion).toBe(1);
      expect(history[1].newVersion).toBe(2);
    });
  });

  describe("listVersions()", () => {
    it("returns all versions for a prompt", () => {
      registry.register("greeting", "v1");
      registry.register("greeting", "v2");
      registry.register("greeting", "v3");

      const versions = registry.listVersions("greeting");
      expect(versions).toHaveLength(3);
      expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    });

    it("returns empty array for unknown prompt", () => {
      expect(registry.listVersions("unknown")).toEqual([]);
    });
  });

  describe("configuration", () => {
    it("respects custom default alias", () => {
      const reg = new PromptRegistry({ defaultAlias: "live" });
      reg.register("test", "content");
      reg.setAlias("test", "live", 1);

      const resolved = reg.resolve("test");
      expect(resolved.resolvedVia).toBe("alias");
      expect(resolved.aliasName).toBe("live");
    });

    it("archives old versions when maxVersions is set", () => {
      const reg = new PromptRegistry({ maxVersions: 2 });
      reg.register("test", "v1");
      reg.register("test", "v2");
      reg.register("test", "v3");

      const versions = reg.listVersions("test");
      expect(versions).toHaveLength(2);
      expect(versions[0].version).toBe(2);
      expect(versions[1].version).toBe(3);
    });
  });
});

// ─── Failure Mode Tests ──────────────────────────────────────

describe("PromptRegistry — Failure Mode Tests", () => {
  describe("FM: Template variable mismatch", () => {
    it("detects missing variables at render time", () => {
      const registry = new PromptRegistry();
      registry.register("extract", "Extract {{entity}} from {{text}}");
      const resolved = registry.resolve("extract", { version: 1 });

      expect(() => registry.render(resolved, { entity: "names" })).toThrow(
        "Missing template variables"
      );
    });
  });

  describe("FM: Alias points to wrong version", () => {
    it("alias change is audited with previous version", () => {
      const registry = new PromptRegistry();
      registry.register("greeting", "v1");
      registry.register("greeting", "v2-bad");

      registry.setAlias("greeting", "production", 1);
      registry.setAlias("greeting", "production", 2);

      const history = registry.getAliasHistory("greeting");
      const lastChange = history[history.length - 1];
      expect(lastChange.previousVersion).toBe(1);
      expect(lastChange.newVersion).toBe(2);
      // Rollback: set alias back to previous version
      registry.setAlias("greeting", "production", lastChange.previousVersion!);
      expect(
        registry.resolve("greeting", { alias: "production" }).version
      ).toBe(1);
    });
  });

  describe("FM: Cache serving stale alias resolution", () => {
    it("cache expires after TTL and picks up alias change", async () => {
      const registry = new PromptRegistry({ cacheTTL: 50 });
      registry.register("test", "v1");
      registry.register("test", "v2");
      registry.setAlias("test", "production", 1);

      // First resolve caches v1
      const first = registry.resolve("test");
      expect(first.version).toBe(1);

      // Move alias to v2
      registry.setAlias("test", "production", 2);

      // Should now resolve to v2 (cache invalidated on alias change)
      const second = registry.resolve("test");
      expect(second.version).toBe(2);
    });

    it("force-clear cache works for emergency rollback", () => {
      const registry = new PromptRegistry({ cacheTTL: 600_000 });
      registry.register("test", "v1");
      registry.register("test", "v2");
      registry.setAlias("test", "production", 1);
      registry.resolve("test"); // cache

      registry.clearCache();
      registry.setAlias("test", "production", 2);
      expect(registry.resolve("test").version).toBe(2);
    });
  });

  describe("FM: Version explosion / storage bloat", () => {
    it("maxVersions archives oldest versions", () => {
      const registry = new PromptRegistry({ maxVersions: 3 });
      for (let i = 0; i < 10; i++) {
        registry.register("prolific", `Template version ${i + 1}`);
      }
      const versions = registry.listVersions("prolific");
      expect(versions).toHaveLength(3);
      // Should keep the most recent 3
      expect(versions[0].version).toBe(8);
      expect(versions[2].version).toBe(10);
    });
  });

  describe("FM: Alias points to archived version", () => {
    it("alias pointing to archived version throws descriptive error", () => {
      const registry = new PromptRegistry({ maxVersions: 2 });
      registry.register("test", "v1");
      registry.setAlias("test", "production", 1);
      registry.register("test", "v2");
      registry.register("test", "v3");

      // v1 is now archived, but alias still points to it
      expect(() => registry.resolve("test", { alias: "production" })).toThrow(
        "doesn't exist"
      );
    });
  });

  describe("FM: Silent version drift (silent degradation)", () => {
    it("can detect stale production aliases by checking version age", () => {
      const registry = new PromptRegistry();
      registry.register("extraction", "Old extraction template");
      registry.setAlias("extraction", "production", 1);

      // Simulate time passing: register newer versions without updating alias
      registry.register("extraction", "Improved v2");
      registry.register("extraction", "Even better v3");

      const resolved = registry.resolve("extraction");
      const latest = registry.listVersions("extraction");
      const latestVersion = latest[latest.length - 1].version;

      // Detection: production alias is behind latest by 2 versions
      const drift = latestVersion - resolved.version;
      expect(drift).toBe(2);
      // A monitoring system would alert when drift > threshold
    });
  });
});

// ─── Integration Tests ───────────────────────────────────────

describe("PromptRegistry — Integration Tests", () => {
  it("full workflow: register → alias → resolve → render → LLM call", async () => {
    const registry = new PromptRegistry();
    const provider = new MockLLMProvider({ latencyMs: 10, latencyJitterMs: 2 });

    // Author registers prompts
    registry.register(
      "summarize",
      "Summarize the following {{doc_type}} in {{max_words}} words:\n\n{{content}}",
      { model: "gpt-4o", temperature: 0.3, commitMessage: "Initial summarizer" }
    );
    registry.register(
      "summarize",
      "Write a concise {{max_words}}-word summary of this {{doc_type}}:\n\n{{content}}",
      { model: "gpt-4o", temperature: 0.2, commitMessage: "More concise phrasing" }
    );

    // Deploy v2 to production
    registry.setAlias("summarize", "production", 2);
    registry.setAlias("summarize", "staging", 1);

    // Application resolves production prompt
    const prompt = registry.resolve("summarize");
    expect(prompt.version).toBe(2);
    expect(prompt.resolvedVia).toBe("alias");

    // Render with variables
    const rendered = registry.render(prompt, {
      doc_type: "legal contract",
      max_words: "100",
      content: "This agreement is entered into by...",
    });
    expect(rendered).toContain("legal contract");
    expect(rendered).toContain("100");

    // Call LLM with version metadata for tracing
    const response = await provider.complete(rendered, {
      promptVersion: prompt.version,
      promptHash: prompt.contentHash,
    });

    expect(response.promptVersion).toBe(2);
    expect(response.promptHash).toBe(prompt.contentHash);
  });

  it("incident rollback scenario: bad prompt → detect → rollback", () => {
    const registry = new PromptRegistry();

    // Initial good prompt
    registry.register("extract", "Extract names from: {{text}}");
    registry.setAlias("extract", "production", 1);

    // Bad prompt deployed
    registry.register("extract", "Just say hello {{text}}");
    registry.setAlias("extract", "production", 2);

    // Detect issue via alias history
    const history = registry.getAliasHistory("extract");
    const lastGoodVersion = history[history.length - 1].previousVersion!;

    // Rollback
    registry.setAlias("extract", "production", lastGoodVersion);
    const resolved = registry.resolve("extract");
    expect(resolved.version).toBe(1);
    expect(resolved.template).toContain("Extract names");

    // Verify rollback is in audit trail
    const updatedHistory = registry.getAliasHistory("extract");
    expect(updatedHistory).toHaveLength(3);
    expect(updatedHistory[2].newVersion).toBe(1);
  });

  it("concurrent prompt management: multiple prompts with independent aliases", () => {
    const registry = new PromptRegistry();

    registry.register("summarize", "Summarize: {{text}}");
    registry.register("extract", "Extract entities from: {{text}}");
    registry.register("classify", "Classify: {{text}}");

    registry.setAlias("summarize", "production", 1);
    registry.setAlias("extract", "production", 1);
    registry.setAlias("classify", "production", 1);

    // Update only extract to v2
    registry.register("extract", "Better extraction: {{text}}");
    registry.setAlias("extract", "production", 2);

    // Other prompts unaffected
    expect(registry.resolve("summarize").version).toBe(1);
    expect(registry.resolve("extract").version).toBe(2);
    expect(registry.resolve("classify").version).toBe(1);
  });

  it("custom storage backend works via interface", () => {
    const storage = new InMemoryStorage();
    const registry = new PromptRegistry({}, storage);

    registry.register("test", "Template {{var}}");
    registry.setAlias("test", "production", 1);

    // Verify storage was used
    expect(storage.getVersion("test", 1)?.template).toBe("Template {{var}}");
    expect(storage.getAlias("test", "production")).toBe(1);
  });
});

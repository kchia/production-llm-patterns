# Shared Utility: prompt-registry

A minimal, reusable library for managing versioned prompts with alias-based promotion. The version store, content hashing, alias pointer logic, template variable extraction, and resolve cache were present in `prompt-version-registry` and referenced conceptually by `prompt-diffing` and `prompt-rollout-testing` — this utility extracts the common interface so those patterns can share a single implementation.

## What it provides

| Export | What it does |
|--------|-------------|
| `PromptRegistry` | Core registry — register versions, resolve by alias or version number, render templates, manage aliases, query audit history |
| `InMemoryStorage` | Default storage backend — suitable for testing and development |
| `RegistryStorage` | Interface for persistent backends (database, file system, key-value store) |
| `PromptVersion` | Immutable version record with content hash, extracted variables, and metadata |
| `ResolvedPrompt` | Resolution result — version data plus how it was resolved (alias vs. explicit version) |
| `AliasChange` | Audit record of alias mutations (who changed what to what) |
| `PromptConfig` | Optional metadata stored with each version (model, temperature, commit message) |
| `RegistryConfig` | Registry behavior knobs — cache TTL, default alias, max versions, validation toggle |

## When to use this vs. the prompt-version-registry pattern

This utility is the storage and resolution engine. It's the right choice when a pattern needs to look up versioned prompts — resolve by alias, register new versions, render templates — but doesn't need the full production guide.

Use the [prompt-version-registry pattern](../../patterns/observability/prompt-version-registry/) when you want the complete picture: architecture guidance, failure mode analysis, cost projections, operational runbooks, and tuning advice for running prompt versioning in production.

## Installation

This is a shared internal utility — import the source directly, not from npm:

```typescript
// TypeScript
import { PromptRegistry, InMemoryStorage } from '../../shared/prompt-registry/src/ts/index.js';
```

```python
# Python
from shared.prompt_registry import PromptRegistry, InMemoryStorage, RegistryConfig
```

## Usage

### TypeScript

```typescript
import { PromptRegistry } from './shared/prompt-registry/src/ts/index.js';

const registry = new PromptRegistry();

// Register versions — each call creates a new immutable record
registry.register('summarize', 'Summarize this in {{style}} style: {{content}}', {
  model: 'gpt-4o',
  commitMessage: 'initial version',
});
registry.register('summarize', 'Give a {{style}} summary of the following: {{content}}', {
  commitMessage: 'clearer phrasing',
});

// Promote version 2 to production
registry.setAlias('summarize', 'production', 2);

// Resolve (uses 'production' alias by default)
const prompt = registry.resolve('summarize');
console.log(prompt.version);      // 2
console.log(prompt.resolvedVia);  // 'alias'

// Render with variables
const text = registry.render(prompt, {
  style: 'concise',
  content: 'The meeting ran long but covered key Q2 decisions.',
});

// Audit trail
const history = registry.getAliasHistory('summarize');
console.log(history[0].previousVersion); // null
console.log(history[0].newVersion);      // 2
```

### Python

```python
from shared.prompt_registry import PromptRegistry, RegistryConfig, PromptConfig

registry = PromptRegistry(RegistryConfig(default_alias="production"))

# Register versions
registry.register(
    "summarize",
    "Summarize this in {{style}} style: {{content}}",
    PromptConfig(model="gpt-4o", commit_message="initial version"),
)
registry.register(
    "summarize",
    "Give a {{style}} summary of the following: {{content}}",
    PromptConfig(commit_message="clearer phrasing"),
)

# Promote version 2 to production
registry.set_alias("summarize", "production", 2)

# Resolve (uses "production" alias by default)
prompt = registry.resolve("summarize")
print(prompt.version)      # 2
print(prompt.resolved_via) # "alias"

# Render with variables
text = registry.render(prompt, {
    "style": "concise",
    "content": "The meeting ran long but covered key Q2 decisions.",
})

# Audit trail
history = registry.get_alias_history("summarize")
print(history[0].previous_version)  # None
print(history[0].new_version)       # 2
```

### Custom storage backend

Implement `RegistryStorage` to persist versions across restarts:

```typescript
import type { RegistryStorage, PromptVersion } from './shared/prompt-registry/src/ts/index.js';

class PostgresStorage implements RegistryStorage {
  async saveVersion(version: PromptVersion) {
    await db.query(
      'INSERT INTO prompt_versions (name, version, template, content_hash, ...) VALUES ($1, $2, $3, $4, ...)',
      [version.name, version.version, version.template, version.contentHash]
    );
  }
  // ... implement remaining interface methods
}

const registry = new PromptRegistry({}, new PostgresStorage());
```

## How consuming patterns use it

### prompt-version-registry

The full pattern implementation — the registry, storage backends, and all types — is the canonical source. This shared utility extracts exactly those components so downstream patterns don't duplicate the resolve cache, alias audit logic, or template variable extraction.

### prompt-diffing

The differ takes a registry as a constructor argument to look up prompt versions by ID and name. It calls `resolve` to fetch the current and previous versions, then computes word-level and semantic diffs between them. The shared registry provides the lookup layer; the pattern adds the diffing algorithm and quality metric correlation.

### prompt-rollout-testing

The rollout tester uses the registry to look up prompt variants by alias (`"current"` and `"candidate"`). Each variant's resolved template is rendered with the incoming request's variables before being sent to the provider. The registry's alias promotion mechanism is how a canary roll forward is implemented: moving `"production"` from one version to another is the deployment action.

## Wiring example: prompt-rollout-testing + prompt-registry

```typescript
import { PromptRegistry } from '../shared/prompt-registry/src/ts/index.js';
import { PromptRolloutTester } from '../patterns/testing/prompt-rollout-testing/src/ts/index.js';

const registry = new PromptRegistry();

// Register control and candidate prompt variants
registry.register('classify', 'Classify this support ticket: {{ticket}}');
registry.register('classify', 'You are a support triage assistant. Classify this ticket: {{ticket}}');

// Tag them with explicit aliases
registry.setAlias('classify', 'control', 1);
registry.setAlias('classify', 'candidate', 2);

// Resolve each variant's template for the rollout tester
const control = registry.resolve('classify', { alias: 'control' });
const candidate = registry.resolve('classify', { alias: 'candidate' });

const tester = new PromptRolloutTester(provider, {
  mode: 'canary',
  variants: [
    { id: 'control',   label: 'v1 baseline', weight: 0.9,
      prompt: registry.render(control, { ticket: '{{ticket}}' }) },
    { id: 'candidate', label: 'v2 revised',  weight: 0.1,
      prompt: registry.render(candidate, { ticket: '{{ticket}}' }) },
  ],
});

const result = await tester.run({ input: incomingTicketText });
```

## Running the tests

```bash
# TypeScript
cd shared/prompt-registry/src/ts
npm install
npm test

# Python
cd shared/prompt-registry/src/py
python -m pytest tests/ -v
```

## Design decisions

**Why not import from the pattern directory directly?** The pattern directory is a documentation artifact — its implementations are written to be readable in context, not to be imported. Shared utilities have their own package.json and pyproject.toml so they can be versioned, tested, and used independently of which pattern they originated from.

**Why immutable versions?** Mutable prompts make it impossible to reproduce past inference results. Content hashes exist specifically to detect accidental template corruption — if `v1`'s hash changes, something modified a record it shouldn't have.

**Why aliases instead of a "latest" pointer?** Aliases are explicit promotions — moving `"production"` from version 3 to version 4 is a deliberate deployment action with an audit record. Relying on "latest" makes deploys implicit and rollback ambiguous.

**Why cache version-based lookups forever?** Versions are immutable. Once a version is created, its content never changes, so caching it indefinitely is safe. Alias-based lookups use TTL because the alias pointer can move (that's the point of aliases).

**Why no async?** The in-memory storage is synchronous CPU-bound work. The `RegistryStorage` interface is intentionally synchronous so implementations stay simple for the common case. If a storage backend needs async I/O (database queries), implement a thin async wrapper that calls the synchronous registry after resolution.

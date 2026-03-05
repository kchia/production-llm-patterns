# Prompt Version Registry

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

Without version control for prompts, the question "what prompt was running when this output went wrong?" has no reliable answer. Prompts change frequently — often by non-engineers through a UI or config file — and without a registry, correlating output quality changes with prompt changes becomes a forensic exercise: comparing git blame timestamps against incident reports, hoping the clocks line up.

Here's what actually breaks. A team member tweaks a system prompt to improve tone. The change isn't tracked. Two days later, extraction accuracy drops 15% and nobody connects the dots for a week. By then, the prompt's been edited twice more. Rolling back means guessing which version was "good" — and guessing wrong means another deployment cycle.

[Datadog's LLM Observability](https://www.datadoghq.com/blog/llm-prompt-tracking/) team found that correlating prompt versions with quality regressions is one of the first things production teams need: without version metadata attached to every LLM span, debugging becomes "comparing iterations side-by-side" with no guarantee you're looking at the right pair. [Braintrust](https://www.braintrust.dev/articles/what-is-prompt-management) integrates with development workflows to catch quality regressions before deployment — but that only works if versions are tracked in the first place.

The common failure mode is slow. Quality degrades over weeks as multiple untracked prompt edits accumulate, and the team has no way to identify which change caused which regression.

## What I Would Not Do

It's tempting to store prompts as string constants in application code and rely on git history for versioning.

This breaks in a specific way. The moment a non-engineer needs to edit a prompt — a product manager improving tone, a domain expert adjusting instructions — you're either giving them a code deploy pipeline or building a workaround. The workaround is usually a config file, a database field, or an admin UI. None of these have version history that connects to your git log.

Even with an all-engineer team, the git approach falls apart when you need runtime prompt selection. A/B testing two prompt versions, canary-rolling a new prompt, or rolling back a bad prompt all require a code deploy. At that point you're waiting for CI/CD to fix a string change — a 15-minute pipeline for a one-line edit. Under incident pressure, that's 15 minutes of degraded output while everyone watches a progress bar.

The second approach: a database table with a `version` column and no immutability guarantees. Someone updates the row in place "just this once" during an incident. Now version 7 doesn't match what version 7 was when the traces were recorded. Your debugging timeline is corrupted, and you won't know until the next incident when the forensic trail doesn't add up.

## When You Need This

- Multiple people edit prompts, or non-engineers modify prompts through a UI or config system
- Prompt changes happen more than weekly — faster iteration means higher risk of untracked regressions
- You need to correlate output quality metrics with specific prompt versions for debugging
- Rollback capability matters — reverting a prompt change without redeploying application code
- You're running A/B tests or canary deployments on prompt variations
- Your incident response has hit the "which prompt was running?" question more than once

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **RAG → Required.** RAG pipelines have multiple prompt touchpoints — query reformulation, context injection templates, answer generation instructions. I wouldn't want to get paged for a retrieval quality regression and not be able to trace which prompt version was active at each stage. The combinatorial surface area makes untracked changes especially dangerous.
- **Agents → Required.** Agent systems use prompts for planning, tool selection, and output formatting — often with different prompts per step. Without version tracking, debugging a multi-step agent failure means guessing which of several prompts changed. I'd want version metadata on every agent span before going to production.
- **Batch → Required.** Batch jobs process thousands of items with the same prompt. A bad prompt version affects the entire run, and you won't know until results are reviewed hours later. I'd want the prompt version pinned and recorded per batch run so I can invalidate and reprocess specific runs.
- **Streaming → Recommended.** Streaming systems typically have fewer prompt variations and more stable templates. The pattern's still valuable for debugging, but the iteration speed and rollback urgency are lower than in RAG or agent systems. I'd notice the gap eventually, but it's not the first thing I'd worry about.

## When This Advice Stops Applying

- Single-developer projects with prompts checked into source control and no runtime prompt selection — git history is the registry, and the overhead of a separate system isn't justified.
- Systems with a single, rarely-changed prompt where the cost of a full deploy for prompt changes is acceptable — the registry solves a problem that doesn't exist yet.
- Very early exploration where prompts change dozens of times per day and you haven't settled on a structure — versioning everything creates noise. Wait until you have a stable-enough template shape, then start versioning.
- Managed prompt platforms ([Braintrust](https://www.braintrust.dev), [PromptLayer](https://www.promptlayer.com), [Langfuse](https://langfuse.com)) that provide versioning as a built-in feature — evaluate whether their versioning meets your audit and rollback needs before building your own. Maybe you outgrow the simplest tier but don't need a custom registry.
- Systems where prompts are generated programmatically from rules or templates, and the rules themselves are versioned — the "prompt" is a computed artifact, and versioning the inputs gives you better debugging leverage than versioning the output.

## The Pattern

### Architecture

```
       ┌──────────────┐
       │ Prompt Author │
       └──────┬───────┘
              │
     1. register(name, template, config)
              │
              ▼
  ┌───────────────────────────────────┐
  │         Prompt Registry           │
  │                                   │
  │  [Prompts]──[Versions]◄─[Aliases] │
  │   by name   immutable    mutable  │
  │              + hash      pointers │
  └───────────────┬───────────────────┘
                  │
     2. resolve(name, alias|version)
                  │
            ┌─────┴──────┐
            │             │
        by alias      by version
       (cache TTL)   (cache ∞)
            │             │
            └─────┬───────┘
                  │
                  ▼
       ┌──────────────────┐
       │ Application Code │
       │                  │
       │  render(prompt,  │
       │    variables)    │
       └────────┬─────────┘
                │
     3. rendered template → LLM
                │
                ▼
       ┌──────────────────┐
       │   LLM Provider   │
       └────────┬─────────┘
                │
     4. attach version metadata
                │
                ▼
      ┌───────────────────┐
      │  Traces / Metrics │  ← side channel
      │  prompt_name      │
      │  prompt_version   │
      │  prompt_hash      │
      └───────────────────┘
```

Numerical values in the diagram (v1, v2, v3) are illustrative — version numbering is auto-incremented per prompt name.

**Core abstraction:**

```typescript
interface PromptRegistry {
  // Register a new version (returns version number)
  register(name: string, template: string, config: PromptConfig): PromptVersion;

  // Resolve a prompt by name + version or alias
  resolve(
    name: string,
    opts?: { version?: number; alias?: string }
  ): ResolvedPrompt;

  // Render a resolved prompt with variables
  render(prompt: ResolvedPrompt, variables: Record<string, string>): string;

  // Manage aliases (mutable pointers to immutable versions)
  setAlias(name: string, alias: string, version: number): void;

  // List versions for a prompt
  listVersions(name: string): PromptVersion[];
}
```

**Configurability:**

| Parameter          | Default        | Description                                                                                                         |
| ------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `storage`          | `"memory"`     | Storage backend — `"memory"` for testing, pluggable for production (database, file, etc.)                           |
| `cacheEnabled`     | `true`         | Whether to cache resolved prompts                                                                                   |
| `cacheTTL`         | `60s`          | TTL for alias-based resolution cache (version-based resolution is cached indefinitely since versions are immutable) |
| `defaultAlias`     | `"production"` | Alias used when no version or alias is specified                                                                    |
| `maxVersions`      | `unlimited`    | Maximum versions retained per prompt (older versions archived, not deleted)                                         |
| `validateTemplate` | `true`         | Whether to validate template variable placeholders on registration                                                  |

These defaults are starting points — SLA requirements, team size, and how frequently prompts change would all shift them. A team iterating hourly might want a shorter cache TTL; a compliance-heavy environment might want `maxVersions` set to `unlimited` with no archival.

**Key design tradeoffs:**

1. **Immutable versions over mutable updates.** Every version is a permanent record. This means storage grows monotonically, but it guarantees that traces referencing version N always resolve to the same content. The alternative — mutable versions with a changelog — is cheaper on storage but corrupts the debugging timeline when someone edits in place.

2. **Aliases over environment-based deployment.** Rather than separate registries per environment, aliases (`"production"`, `"staging"`, `"canary"`) point to version numbers within a single registry. This keeps the version numbering global and makes promotion explicit: moving `"production"` from v5 to v6 is an auditable operation, not a deploy.

3. **Template rendering in the registry vs. in the caller.** The registry owns rendering because it can validate that all template variables are provided and catch mismatches early. The tradeoff is coupling — the caller must use the registry's rendering API rather than its own string interpolation. I'd accept that coupling for the validation guarantees.

4. **In-memory storage as default.** The registry interface is storage-agnostic, with an in-memory implementation for testing and development. Production deployments plug in a persistent backend. This keeps the core implementation dependency-free while supporting real persistence through the interface.

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

How this pattern itself can fail. Every solution creates new failure modes.

| Failure Mode                                                                                                                                                                                                                                                                                                             | Detection Signal                                                                                                                                                                 | Mitigation                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Registry unavailable at runtime** — application can't resolve prompts because the registry backend is down or unreachable                                                                                                                                                                                              | Spike in prompt resolution errors; LLM calls fail or fall back to hardcoded defaults                                                                                             | Cache last-known-good resolved prompts locally with a stale-while-revalidate strategy. Log warnings when serving from stale cache so the team knows the registry is degraded.                                                                |
| **Alias points to wrong version** — someone moves the `"production"` alias to an untested version, or an automation script updates it incorrectly                                                                                                                                                                        | Sudden quality regression correlated with alias update timestamp; alert on alias changes to production-labeled aliases                                                           | Require explicit confirmation for production alias changes. Log all alias mutations with actor, timestamp, and previous version. Support one-command rollback to previous alias target.                                                      |
| **Template variable mismatch** — prompt template expects `{context}` but caller provides `{user_context}`, resulting in unrendered placeholders in the LLM call                                                                                                                                                          | LLM responses contain literal `{context}` strings; template validation errors in logs                                                                                            | Validate variable names at render time and fail loudly if a required variable is missing. Registry can store expected variable names as metadata and validate on registration.                                                               |
| **Version explosion / storage bloat** — hundreds of versions accumulate per prompt over months, slowing queries and consuming storage                                                                                                                                                                                    | Increasing query latency for `listVersions`; storage growth alerts                                                                                                               | Set `maxVersions` with archival policy. Old versions move to cold storage but remain resolvable by explicit version number. Monitor version count per prompt.                                                                                |
| **Cache serving stale alias resolution** — cache TTL means a freshly updated alias still resolves to the old version for up to `cacheTTL` seconds                                                                                                                                                                        | Prompt changes don't take effect immediately; discrepancy between registry state and served prompt                                                                               | Tune cache TTL based on acceptable staleness. For emergency rollbacks, provide a cache-bust mechanism (force-refresh endpoint or flag). Document the staleness window in runbooks.                                                           |
| **Silent version drift (silent degradation)** — prompts are versioned and tracked, but nobody reviews whether old versions are still appropriate as the product evolves. Six months later, the "production" prompt references features that no longer exist or uses instructions misaligned with current model behavior. | No automated signal — the registry is healthy, versions are immutable, aliases are correct. Quality metrics may show a slow downward trend, but it's attributed to other causes. | Schedule periodic prompt reviews (quarterly). Track the age of the current production alias target — alert if a prompt hasn't been updated in 90+ days while the product has changed. Cross-reference prompt content with product changelog. |

## Observability & Operations

- **Key metrics:**

| Metric                               | Baseline                              | What to Watch                                                                |
| ------------------------------------ | ------------------------------------- | ---------------------------------------------------------------------------- |
| `registry.resolve.latency_ms`        | <1ms for in-memory (p50/p95/p99)      | If this creeps up, check version count or storage backend health             |
| `registry.resolve.cache_hit_rate`    | >95% in steady state                  | A sudden drop means cache is being invalidated too often or TTL is too short |
| `registry.alias.changes_count`       | Low, occasional spikes during deploys | Spikes indicate either an incident rollback or automation gone wrong         |
| `registry.versions.count_per_prompt` | Grows with iteration cadence          | Growth beyond `maxVersions` means archival isn't running                     |
| `registry.render.validation_errors`  | 0                                     | Non-zero means application code and prompt templates are out of sync         |
| `registry.production_alias.age_days` | Resets on each alias update           | The silent degradation early warning                                         |

- **Alerting:**

| Level        | Condition                                              | Action                                                                                                  |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| **Warning**  | `production_alias.age_days > 90`                       | Prompt hasn't been reviewed in a quarter. May not be wrong, but worth checking.                         |
| **Warning**  | `resolve.cache_hit_rate < 0.80`                        | Cache is underperforming; investigate TTL settings or unexpected invalidation patterns.                 |
| **Warning**  | `versions.count_per_prompt > 200`                      | Approaching version bloat territory. Review `maxVersions` setting.                                      |
| **Critical** | `render.validation_errors > 0 sustained for 5 minutes` | Application code and templates are mismatched in production. LLM calls are receiving malformed prompts. |
| **Critical** | `alias.changes_count > 5 in 10 minutes`                | Either an automation loop or someone panic-cycling through versions during an incident.                 |

These thresholds are starting points — baseline alias change frequency, team size, and how many prompts you manage would shift them.

- **Runbook:**
  - **Validation errors firing:** Check which prompt name is failing → compare template variables against calling code → either fix the code or register a new prompt version with corrected variable names → verify errors stop.
  - **Alias thrashing (>5 changes in 10 min):** Identify the actor (human or automation) → pause automation if applicable → check alias history for the pattern of changes → settle on a version and set the alias once.
  - **Cache hit rate drop:** Check if a new prompt was just registered (expected invalidation) → if sustained, verify cache TTL is appropriate → check if something is calling `clearCache()` repeatedly.
  - **Production alias age alert:** Review the prompt content against current product behavior → if the prompt references deprecated features or outdated instructions, register an updated version and move the alias → if the prompt is still correct, document the review and snooze.

## Tuning & Evolution

- **Tuning levers:**

| Parameter          | Safe Range       | Dangerous Extreme                                                                                                       | Effect                                                                                           |
| ------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `cacheTTL`         | 5s–300s          | Below 5s, you're essentially not caching. Above 300s, emergency rollbacks are delayed noticeably.                       | Lower for faster alias change propagation, higher for less storage load                          |
| `maxVersions`      | 50–1000          | Below 50, you risk losing versions referenced in old traces. Above 1000, query performance degrades on simple backends. | Lower saves storage and speeds up `listVersions`, higher preserves full audit trail              |
| `defaultAlias`     | Any string       | N/A — the name itself doesn't affect behavior                                                                           | Change if your team uses different environment naming (e.g., `"live"` instead of `"production"`) |
| `validateTemplate` | `true` (keep on) | `false` — disables mismatch detection at registration, errors surface at render time instead                            | Disable only if you have templates with literal `{{` that aren't variables                       |

- **Drift signals:**

| Signal                                     | Meaning                                                                                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version count growing but alias not moving | Team is registering prompts but not promoting them. Either the review process is bottlenecked or people are forgetting to update aliases.                  |
| Cache hit rate declining over time         | More prompts or more frequent alias changes are outpacing the cache. Consider increasing TTL or reviewing whether all those alias changes are intentional. |
| Resolution latency creeping up             | Version count per prompt is growing. Review `maxVersions` setting or switch to a storage backend with indexed lookups.                                     |

- **Silent degradation:**
  - **Month 3:** Production aliases point to prompts written for an earlier version of the product. New features aren't reflected in instructions. Quality metrics show a subtle downward trend that gets attributed to "model drift" rather than stale prompts.
  - **Month 6:** Multiple prompts reference deprecated entity types, outdated formatting instructions, or removed features. The registry is technically healthy — versions are immutable, aliases are stable — but the content is wrong. Without periodic prompt reviews, the registry becomes a well-organized collection of outdated instructions.
  - **Detection:** Track `production_alias.age_days` per prompt. Cross-reference with product deploy frequency. If the product deploys weekly but prompts haven't changed in 90 days, that's a flag. Quarterly prompt review cadence catches this before it compounds.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers.

| Scale        | Additional Cost | ROI vs. No Pattern                                                               |
| ------------ | --------------- | -------------------------------------------------------------------------------- |
| 1K req/day   | ~$0/day         | Saves ~$1/month in bad-prompt exposure; real value is debugging capability       |
| 10K req/day  | ~$0/day         | Saves ~$10/month; 19-minute rollback advantage pays for itself on first incident |
| 100K req/day | ~$0/day         | Saves ~$103/month; easily justifies managed platform costs ($50–200/month)       |

## Testing

See test files in `src/ts/__tests__/index.test.ts` and `src/py/tests/test_index.py`.

- **Unit tests:** Registration (immutable versioning, variable extraction, content hashing, config storage, deduplication), resolution (by version, by alias, default alias fallback, latest fallback, error cases), rendering (variable substitution, missing variable detection), alias management (create, update, audit history), configuration (custom defaults, maxVersions archival).
- **Failure mode tests:** One test per failure mode — template variable mismatch detection, alias-to-wrong-version rollback via audit trail, cache staleness and force-clear, version explosion with archival, alias pointing to archived version, and silent version drift detection via version gap monitoring.
- **Integration tests:** Full register → alias → resolve → render → LLM call workflow with mock provider and version metadata propagation. Incident rollback scenario (bad prompt → detect → rollback → verify). Concurrent prompt management with independent aliases. Custom storage backend via interface.
- **Run:** `cd src/ts && npm test`

<!-- ## Companion Content

- Blog post: [Prompt Version Registry — Deep Dive](https://prompt-deploy.com/prompt-version-registry) (coming soon)
- Related patterns:
  - [Structured Tracing](../structured-tracing/) — traces reference prompt versions for debugging; the registry provides the version metadata that makes traces actionable
  - [Prompt Diffing](../prompt-diffing/) (#35) — compares versions stored in the registry to show exactly what changed between deployments
  - [Prompt Rollout Testing](../../testing/prompt-rollout-testing/) (#24) — A/B tests and canary-rolls versions from the registry
  - [Drift Detection](../drift-detection/) (#28) — correlates quality drift with prompt version changes to pinpoint root causes
  - [Regression Testing](../../testing/regression-testing/) (#11) — runs eval suites against prompt versions to catch regressions before production -->

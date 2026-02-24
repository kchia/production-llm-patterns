# Prompt Version Registry

## The Problem

Without version control for prompts, you can't answer "what prompt was running when this bad output happened?" Prompts change frequently, often by non-engineers, and without a registry you lose the ability to correlate output quality changes with prompt changes. When quality degrades, you're left comparing git blame timestamps with incident reports — a manual, error-prone forensic exercise.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Required for RAG, Agents, and Batch (3/4 navigation matrix density)
- Recommended for Streaming systems
- Multiple people edit prompts, or non-engineers modify prompts through a UI
- You deploy prompt changes more than weekly
- Correlating prompt versions with output quality metrics or incidents is part of how you diagnose regressions
- You want to support rollback — reverting a prompt change without redeploying code

## The Pattern

### Architecture

[Diagram or description of the pattern's architecture]

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Key design decisions:

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

### Key design decisions:

## Failure Modes

How this pattern itself can fail. Every solution creates new failure modes.

| Failure Mode | Detection Signal | Mitigation |
| ------------ | ---------------- | ---------- |
|              |                  |            |

## Observability & Operations

How to know this pattern is healthy in production. What to monitor, what to alert on, and what to do when alerts fire.

- **Key metrics:**
- **Alerting:**
- **Runbook:**

## Tuning & Evolution

How this pattern changes as your system matures. What signals tell you to adjust configuration, and what silent degradation looks like.

- **Tuning levers:**
- **Drift signals:**
- **Silent degradation:**

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers.

| Scale        | Additional Cost | ROI vs. No Pattern |
| ------------ | --------------- | ------------------ |
| 1K req/day   |                 |                    |
| 10K req/day  |                 |                    |
| 100K req/day |                 |                    |

## Testing

How to verify this pattern works correctly. See test files in `src/ts/` and `src/py/`.

- **Unit tests:**
- **Integration tests:**
- **What to regression test:**

## When This Advice Stops Applying

- Single-developer projects with prompts checked into source control — git history is your registry
- Systems with a single, rarely-changed prompt where the overhead of a registry isn't justified
- Early exploration where prompts are changing too fast to version meaningfully — you'd create hundreds of versions per day
- Managed prompt platforms that provide versioning as a built-in feature — evaluate whether their versioning meets your needs before building your own

## Companion Content

- Blog post: [Prompt Version Registry](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Prompt Diffing](../prompt-diffing/) (#35, S9) — compares versions stored in the registry
  - [Prompt Rollout Testing](../../testing/prompt-rollout-testing/) (#24, S7) — A/B tests versions from the registry
  - [Drift Detection](../drift-detection/) (#28, S8) — correlates quality drift with prompt version changes
  - [Regression Testing](../../testing/regression-testing/) (#11, S4) — runs eval suites against prompt versions
  - [Structured Tracing](../structured-tracing/) (#8, S3) — traces reference prompt versions for debugging

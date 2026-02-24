# Snapshot Testing

## The Problem

LLM outputs are non-deterministic, making traditional assertion-based testing brittle. A test that checks for exact string equality fails on every run because the model rephrases its answer. Snapshot testing captures "known-good" outputs and detects meaningful deviations, but without the right approach, every non-deterministic variation triggers a false alarm — making the test suite noisy, ignored, and eventually abandoned.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Recommended across RAG, Agents, and Batch (3/4 navigation matrix density)
- Optional for Streaming
- The testing capstone — builds on eval harness foundations
- Your regression tests are either too strict (constant false alarms from non-determinism) or too loose (miss real regressions)
- Detecting changes in output structure, tone, or key content — without requiring exact matches — is the capability that matters
- You want a lightweight testing layer between "no tests" and "full eval harness"

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

- Systems where output format is fully deterministic (structured extraction with strict schemas) — exact assertion testing works fine
- Very early development where "known-good" isn't yet established — you need a stable baseline first
- Creative applications where output variation is the feature, not a bug
- Systems where the eval harness provides sufficient regression coverage and snapshots add noise without insight

## Companion Content

- Blog post: [Snapshot Testing](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Eval Harness](../eval-harness/) (#4, S1) — the evaluation framework that snapshot testing builds on
  - [Regression Testing](../regression-testing/) (#11, S4) — regression tests catch behavioral changes; snapshots catch output changes
  - [Prompt Rollout Testing](../prompt-rollout-testing/) (#24, S7) — snapshot comparisons between prompt variants
  - [Prompt Diffing](../../observability/prompt-diffing/) (#35, S9) — diffing for prompts, snapshots for outputs

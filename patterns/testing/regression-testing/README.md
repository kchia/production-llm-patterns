# Regression Testing

## The Problem

You change a prompt and existing functionality breaks. Without regression testing, prompt improvements are a game of whack-a-mole — fix one case, break two others. The problem compounds because LLM outputs are non-deterministic, so breakage isn't always obvious on manual inspection. A prompt tweak that works for the use case you're looking at silently degrades three others you're not.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Required for RAG, Agents, and Batch (3/4 navigation matrix density)
- Recommended for Streaming systems
- Your system handles more than one type of query or use case — prompt changes create regression risk across all of them
- You change prompts regularly and can't manually verify every use case after each change
- You've had a production incident where a "minor" prompt tweak broke an unrelated feature

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

- Brand-new systems with no established behavior to regress from — you need a baseline first
- R&D experimentation where outputs are expected to change dramatically with each iteration
- Single-use-case systems with simple prompts where regressions are obvious from basic smoke testing
- Systems where the eval dataset is too small or unrepresentative to catch meaningful regressions

## Companion Content

- Blog post: [Regression Testing](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Eval Harness](../eval-harness/) (#4, S1) — the foundation this pattern builds on; provides the evaluation framework
  - [Snapshot Testing](../snapshot-testing/) (#33, S9) — a complementary approach using output snapshots instead of metrics
  - [Prompt Rollout Testing](../prompt-rollout-testing/) (#24, S7) — tests regressions on live traffic, not just offline datasets
  - [Adversarial Inputs](../adversarial-inputs/) (#18, S5) — regression tests for edge cases and attack vectors
  - [Prompt Version Registry](../../observability/prompt-version-registry/) (#10, S3) — tracks which prompt version each regression test ran against

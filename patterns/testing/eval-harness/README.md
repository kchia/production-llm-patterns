# Eval Harness

## The Problem

Without an eval harness, you're deploying prompt changes based on vibes. "It looks right on these 5 examples" isn't a quality bar — it's hoping. A prompt tweak that improves one use case silently degrades three others, and you won't know until users complain. Non-deterministic outputs make this worse: the same prompt can pass manual spot-checks and fail on the next run.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Required for RAG, Agents, and Batch (3/4 navigation matrix density) — the foundation for all testing patterns
- Recommended for Streaming systems
- You change prompts more than once — every prompt change is a potential regression
- You have more than one use case or query type — prompt changes affect different cases differently
- You want to compare model versions, providers, or configurations quantitatively

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

- One-shot scripts that don't evolve — no iteration means no regression risk
- Systems where human review is the primary quality gate and automated eval is supplementary
- Very early exploration where you're still defining what "good output" means — you need ground truth before you can eval against it
- Creative applications where output quality is inherently subjective and can't be reduced to metrics

## Companion Content

- Blog post: [Eval Harness](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Regression Testing](../regression-testing/) (#11, S4) — uses the eval harness to catch prompt regressions
  - [Adversarial Inputs](../adversarial-inputs/) (#18, S5) — uses the eval harness to test edge cases and attacks
  - [Snapshot Testing](../snapshot-testing/) (#33, S9) — uses the eval harness for output stability checks
  - [Online Eval Monitoring](../../observability/online-eval-monitoring/) (#21, S6) — extends eval from CI into production traffic
  - [Prompt Rollout Testing](../prompt-rollout-testing/) (#24, S7) — uses eval to compare prompt variants on live traffic

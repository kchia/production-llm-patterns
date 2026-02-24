# Online Eval Monitoring

## The Problem

Your eval harness runs in CI, but production traffic is different. Eval datasets don't cover the long tail of real-world queries, and production conditions (latency pressure, context window limits, concurrent load) change model behavior. Without online eval, your CI says green while production quality silently degrades. The gap between offline eval and production reality widens every week as user behavior evolves.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Required for RAG, Agents, and Batch (3/4 navigation matrix density)
- Recommended for Streaming systems
- Your offline evals aren't catching production quality issues — CI is green but users are complaining
- Your production query distribution differs significantly from your eval dataset
- Detecting quality regressions within hours, not days or weeks, is the bar worth hitting
- You've built an eval harness (see [Eval Harness](#4)) and need to extend it beyond CI

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

- Pre-launch systems with no production traffic — you need traffic to sample
- Very low volume systems where manual review of all outputs is feasible and more effective
- Systems where offline eval datasets closely match production distribution and catch all regressions
- Strict latency budgets where the overhead of inline eval sampling is unacceptable

## Companion Content

- Blog post: [Online Eval Monitoring](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Eval Harness](../../testing/eval-harness/) (#4, S1) — the offline eval framework that online monitoring extends to production
  - [Structured Tracing](../structured-tracing/) (#8, S3) — provides the trace infrastructure for sampling production requests
  - [Output Quality Monitoring](../output-quality-monitoring/) (#16, S5) — monitors quality metrics; online eval adds eval-specific scoring
  - [Drift Detection](../drift-detection/) (#28, S8) — detects when online eval scores trend away from baseline
  - [Prompt Rollout Testing](../../testing/prompt-rollout-testing/) (#24, S7) — uses online eval to compare prompt variants

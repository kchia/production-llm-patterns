# Prompt Rollout Testing

## The Problem

You want to deploy a new prompt but can't know if it's better without exposing real traffic. Without rollout testing (A/B testing, canary deploys, shadow mode), every prompt change is a leap of faith. You either deploy and hope, or never change prompts at all — accumulating a backlog of untested improvements. Offline evals tell you the new prompt is better on your dataset, but production traffic is always different.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Required for RAG and Agents, High ROI for Batch — strong adoption signal across 3 of 4 system types
- High ROI for Batch; Recommended for Streaming
- Prompt changes are frequent and stakes are high enough to justify measured rollouts
- Your offline eval results don't reliably predict production quality
- You need statistical confidence before committing to a prompt change
- Multiple stakeholders need evidence that a prompt change is an improvement

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

- Early-stage products where rapid iteration matters more than stability — deploy fast and fix fast
- Systems with very few users where statistical significance is impossible to achieve
- Prompts that change rarely (quarterly or less) where the overhead of rollout infrastructure isn't justified
- Internal tools where prompt quality is less critical and full deployments are acceptable

## Companion Content

- Blog post: [Prompt Rollout Testing](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Eval Harness](../eval-harness/) (#4, S1) — provides the evaluation metrics used to compare prompt variants
  - [Prompt Version Registry](../../observability/prompt-version-registry/) (#10, S3) — stores the prompt versions being tested
  - [Regression Testing](../regression-testing/) (#11, S4) — offline regression testing complements live rollout testing
  - [Online Eval Monitoring](../../observability/online-eval-monitoring/) (#21, S6) — monitors quality during rollout
  - [Snapshot Testing](../snapshot-testing/) (#33, S9) — snapshot comparisons between prompt variants

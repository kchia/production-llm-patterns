# Drift Detection

## The Problem

Model behavior changes over time — provider-side model updates, shifting input distributions, evolving user behavior, and prompt-data interactions that compound. Without drift detection, you discover these changes when users report that "it used to work better." By then, the drift has been compounding for weeks and you have no baseline to compare against. The change is invisible in your error logs because nothing is "failing" — it's just getting slowly worse.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Required for RAG and Batch (2/4 navigation matrix density) where consistency over time is critical
- Recommended for Agents; Optional for Streaming
- Your system has been running long enough that "it changed" becomes a debugging concern (typically 1+ months)
- You use provider-hosted models that update without your explicit consent
- Detecting gradual quality degradation before users report it is the goal
- You've had an incident where a model update silently changed behavior

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

- Prototypes and short-lived systems where long-term stability isn't a concern
- Applications where some output variation is expected and acceptable (creative writing, brainstorming)
- Systems using pinned model versions with no provider-side updates (self-hosted, snapshot models)
- Very new deployments with insufficient history to establish a meaningful baseline

## Companion Content

- Blog post: [Drift Detection](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Prompt Version Registry](../prompt-version-registry/) (#10, S3) — correlates drift with prompt version changes
  - [Output Quality Monitoring](../output-quality-monitoring/) (#16, S5) — provides the quality metrics that drift detection trends over time
  - [Online Eval Monitoring](../online-eval-monitoring/) (#21, S6) — production eval scores are a primary drift signal
  - [Structured Tracing](../structured-tracing/) (#8, S3) — trace data provides the raw material for drift analysis
  - [Prompt Diffing](../prompt-diffing/) (#35, S9) — differentiates prompt-caused drift from model-caused drift

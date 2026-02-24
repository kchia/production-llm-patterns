# Output Quality Monitoring

## The Problem

Your LLM output quality degrades silently. Model updates, prompt drift, and changing input distributions all erode quality without triggering errors. Without monitoring, you discover quality problems when users complain — weeks after the degradation started. By then, the root cause is buried under multiple overlapping changes and you have no baseline to compare against.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Required for RAG, Agents, and Batch (3/4 navigation matrix density)
- Recommended for Streaming systems
- Your system is in production and needs to maintain quality over time, not just at launch
- You've experienced silent quality degradation that users reported before your team noticed
- Detecting the impact of model version updates, prompt changes, or input distribution shifts matters for maintaining quality
- You've implemented an eval harness (see [Eval Harness](#4)) and need to extend quality measurement to production

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

- Prototyping and experimentation where quality standards are still being defined
- Creative applications where "quality" is inherently subjective and can't be reduced to metrics
- Very early deployments where you're still defining what good looks like — you need a quality definition before you can monitor it
- Systems with extremely low volume where manual review of all outputs is feasible

## Companion Content

- Blog post: [Output Quality Monitoring](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Eval Harness](../../testing/eval-harness/) (#4, S1) — defines the quality metrics that this pattern monitors in production
  - [Structured Tracing](../structured-tracing/) (#8, S3) — provides the trace data that quality scores are attached to
  - [Online Eval Monitoring](../online-eval-monitoring/) (#21, S6) — extends quality monitoring with production eval sampling
  - [Drift Detection](../drift-detection/) (#28, S8) — detects when quality metrics trend away from baseline
  - [Prompt Diffing](../prompt-diffing/) (#35, S9) — correlates quality changes with prompt changes

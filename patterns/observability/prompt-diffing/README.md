# Prompt Diffing

## The Problem

Prompts change over time, but understanding the impact of changes is hard. A one-word tweak can dramatically shift output behavior — changing "concise" to "brief" might halve response length. Without diffing, you see that the prompt changed but can't correlate the change to the output quality shift you observed in monitoring. You're left comparing timestamps and guessing which word mattered.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Recommended across RAG, Agents, and Batch (3/4 navigation matrix density)
- Optional for Streaming
- The observability capstone — builds on prompt version registry and quality monitoring
- Prompt changes are frequent and correlating them with quality metrics becomes essential
- Multiple people edit prompts and understanding the impact of each change matters for debugging
- You've had quality regressions that were eventually traced to a prompt change, but the debugging took hours

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

- Systems with a single, rarely-changed prompt — nothing to diff
- Early-stage development where prompts change too rapidly for diffing to be actionable (multiple changes per hour)
- Systems without output quality monitoring — you can diff prompts, but can't measure impact without quality metrics
- Managed prompt platforms that include prompt comparison features — evaluate whether their diffing capabilities meet your needs before building your own

## Companion Content

- Blog post: [Prompt Diffing](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Prompt Version Registry](../prompt-version-registry/) (#10, S3) — stores the versions that diffing compares
  - [Output Quality Monitoring](../output-quality-monitoring/) (#16, S5) — provides the quality metrics to correlate with prompt diffs
  - [Regression Testing](../../testing/regression-testing/) (#11, S4) — diffs help explain why regression tests failed
  - [Drift Detection](../drift-detection/) (#28, S8) — prompt diffs help distinguish prompt-caused drift from model-caused drift
  - [Snapshot Testing](../../testing/snapshot-testing/) (#33, S9) — snapshot diffs for outputs complement prompt diffs for inputs

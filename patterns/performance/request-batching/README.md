# Request Batching

## The Problem

Processing items one-at-a-time through an LLM API wastes throughput. Each request incurs connection overhead, and API rate limits are per-request, not per-token. Without batching, processing 10,000 items takes 10,000 sequential API calls when many could be combined into fewer, larger requests. The per-request overhead dominates total processing time at scale.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Critical for Batch systems processing many items
- High ROI for RAG with multiple retrieval-augmented queries
- Optional for Agents; N/A for Streaming (responses must start immediately)
- Throughput matters more than individual request latency for your workload
- You're processing large datasets through LLM APIs and hitting per-minute rate limits
- Your per-item processing time is dominated by API call overhead rather than generation time

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

- Real-time user-facing requests where batching adds unacceptable latency (users wait for a batch to fill)
- Streaming systems where responses must start immediately
- Very low volume where batching overhead (wait time, complexity) isn't justified by throughput gains
- Single-item processing where there's nothing to batch with

## Companion Content

- Blog post: [Request Batching](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Concurrent Request Management](../concurrent-request-management/) (#23, S7) — manages how many batches run in parallel
  - [Latency Budget](../latency-budget/) (#14, S4) — batching trades latency for throughput; budget determines acceptable tradeoff
  - [Token Budget Middleware](../../cost-control/token-budget-middleware/) (#3, S1) — batching affects token spend per request
  - [State Checkpointing](../../orchestration/state-checkpointing/) (#25, S7) — checkpoints batch progress for recovery on failure

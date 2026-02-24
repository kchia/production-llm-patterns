# Latency Budget

## The Problem

LLM calls are slow — 1-10 seconds each. In a multi-step pipeline, latencies compound. Without a latency budget, you discover at the end of a request chain that you've blown your SLA, with no way to know which step to cut or optimize. A RAG pipeline with retrieval, re-ranking, generation, and validation can easily take 15 seconds — and you only find out it's too slow when the user has already left.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Critical for Streaming systems where users see real-time response generation
- Required for RAG systems with multi-step retrieval chains
- Recommended for Agents; Optional for Batch (no user-facing latency)
- Your pipeline has 3+ steps and you have a user-facing latency SLA
- Tradeoff decisions (skip re-ranking, use a faster model) depend on knowing how much time budget remains

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

- Batch processing where latency isn't user-facing and throughput matters more
- Async workflows where responses are delivered later (email, notifications, queued processing)
- Internal tools with no SLA where users accept variable response times
- Single-step LLM calls where there's no pipeline to budget across

## Companion Content

- Blog post: [Latency Budget](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Token Budget Middleware](../../cost-control/token-budget-middleware/) (#3, S1) — the cost counterpart to latency budgets; often in tension (cheaper models are slower)
  - [Concurrent Request Management](../concurrent-request-management/) (#23, S7) — parallelism is a tool for staying within latency budgets
  - [Streaming Backpressure](../streaming-backpressure/) (#27, S7) — manages latency at the response delivery layer
  - [Multi-Provider Failover](../../resilience/multi-provider-failover/) (#9, S3) — failover latency counts against the budget
  - [Semantic Caching](../../cost-control/semantic-caching/) (#12, S4) — cache hits dramatically improve latency

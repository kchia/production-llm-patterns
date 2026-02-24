# Semantic Caching

## The Problem

Users ask similar questions repeatedly — not identical, but semantically equivalent. "What's the return policy?" and "How do I return an item?" are different strings but the same question. Without semantic caching, you're paying full API cost for every slight rephrasing. At scale, a significant fraction of requests may be cacheable — the exact percentage varies widely by workload, but even modest hit rates translate to meaningful savings in API spend and latency.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- High ROI for RAG and Batch systems with repetitive query patterns
- Low ROI for Agents (outputs are action-dependent, less cacheable); N/A for Streaming
- Your query logs show significant semantic overlap — cluster your queries and check
- You're at a scale where cache hit savings justify the embedding infrastructure cost
- Response freshness requirements allow serving cached answers (minutes to hours, not seconds)

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

- Highly personalized outputs where no two responses should be identical (user-specific recommendations)
- Real-time data that changes between semantically identical queries (stock prices, live scores)
- Low-volume systems where cache infrastructure costs more than the API savings
- Creative applications where output diversity is a feature, not a bug

## Companion Content

- Blog post: [Semantic Caching](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Token Budget Middleware](../token-budget-middleware/) (#3, S1) — caching reduces spend, complementing budget enforcement
  - [Model Routing](../model-routing/) (#13, S4) — routing and caching both reduce cost; routing by choosing cheaper models, caching by avoiding calls entirely
  - [Latency Budget](../../performance/latency-budget/) (#14, S4) — cache hits dramatically improve latency
  - [Embedding Refresh](../../data-pipeline/embedding-refresh/) (#29, S8) — stale embeddings affect cache similarity matching

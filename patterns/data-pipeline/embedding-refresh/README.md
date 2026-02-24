# Embedding Refresh

## The Problem

Embeddings go stale. Your source documents update but your vector store still has embeddings from the old versions — retrieval returns outdated information. New embedding models release with better quality but your vectors are stuck on the old model — you can't mix embedding models in the same index. Without refresh strategies, retrieval quality silently degrades as the gap between stored and current embeddings widens.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Required for RAG and Batch (2/4 navigation matrix density)
- Optional for Agents; N/A for Streaming
- Your source data changes over time (documents updated, added, removed)
- You want to upgrade to a better embedding model without losing index availability
- You've noticed retrieval quality degrading despite no changes to your prompts or pipeline
- Your vector store is months old and source documents have evolved

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

- Static document collections that never change — embeddings don't go stale
- Systems not using embeddings or vector retrieval
- One-time analysis jobs where freshness doesn't matter — process once and discard
- Small enough collections where full re-embedding on every change is feasible and fast

## Companion Content

- Blog post: [Embedding Refresh](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Chunking Strategies](../chunking-strategies/) (#19, S6) — re-chunking triggers re-embedding; chunking changes require full refresh
  - [Index Maintenance](../index-maintenance/) (#30, S8) — refresh and maintenance are the two pillars of RAG data health
  - [Drift Detection](../../observability/drift-detection/) (#28, S8) — detects when stale embeddings cause retrieval quality drift
  - [Semantic Caching](../../cost-control/semantic-caching/) (#12, S4) — stale embeddings affect cache similarity matching

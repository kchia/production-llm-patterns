# Context Management

## The Problem

LLM context windows are finite and expensive. Without management, conversations grow until they hit the token limit and either fail with an error or silently truncate important context. Multi-turn agents lose track of earlier instructions. RAG systems stuff too many retrieved documents, diluting the signal with noise. You're paying for every token in the context window, and most of it may be irrelevant.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Required for Agents and Streaming where conversations are multi-turn and context grows unboundedly
- Recommended for RAG where retrieved context must be managed alongside conversation history
- Optional for Batch (typically stateless, independent inputs)
- Your conversations or pipelines regularly approach context window limits
- You've seen failures or quality degradation from context window exhaustion
- You're paying for large context windows and want to reduce cost by managing what goes in

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

- Single-turn systems with no conversation history — each request is independent
- Batch jobs processing independent inputs that never accumulate context
- Systems where inputs are always well under the context window limit (short queries, small documents)
- Applications using models with very large context windows where limits are never approached in practice

## Companion Content

- Blog post: [Context Management](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Chunking Strategies](../chunking-strategies/) (#19, S6) — determines what units of context are available for management
  - [Token Budget Middleware](../../cost-control/token-budget-middleware/) (#3, S1) — context size directly affects token cost
  - [Latency Budget](../../performance/latency-budget/) (#14, S4) — larger contexts increase latency; management is a latency lever
  - [Streaming Backpressure](../../performance/streaming-backpressure/) (#27, S7) — context size affects generation length and backpressure

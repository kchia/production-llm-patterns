# Streaming Backpressure

## The Problem

LLM streaming responses can overwhelm slow consumers — a mobile client on a bad connection, a UI renderer that can't keep up, or a downstream service that processes tokens slower than they arrive. Without backpressure, you buffer unboundedly until memory is exhausted or data is silently dropped. The producer (LLM) doesn't know the consumer is drowning.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Critical for Streaming systems — the defining performance concern for real-time LLM responses
- Optional for Agents; N/A for Batch and RAG (non-streaming consumption)
- Your consumers can't always keep up with the LLM's token generation rate
- You've seen memory growth, dropped tokens, or client disconnects during streaming
- You serve diverse clients (mobile, web, API consumers) with varying processing speeds

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

- Non-streaming systems that collect full responses before processing
- Batch processing where responses are buffered and processed offline
- Systems where consumers are always faster than the LLM's generation rate (server-to-server with fast consumers)
- Short responses where total buffering is trivial (< 1KB)

## Companion Content

- Blog post: [Streaming Backpressure](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Latency Budget](../latency-budget/) (#14, S4) — backpressure affects perceived latency; budget determines when to stop buffering
  - [Concurrent Request Management](../concurrent-request-management/) (#23, S7) — concurrent streams multiply the backpressure problem
  - [Context Management](../../data-pipeline/context-management/) (#22, S6) — context size affects generation length and backpressure severity
  - [Graceful Degradation](../../resilience/graceful-degradation/) (#1, S1) — when backpressure is unmanageable, degrade (shorter responses, lower quality)

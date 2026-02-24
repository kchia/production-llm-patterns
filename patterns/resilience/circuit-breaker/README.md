# Circuit Breaker

## The Problem

When a provider is failing, continuing to send requests wastes money, adds latency, and delays recovery. Without a circuit breaker, your system keeps hammering a sick provider — making the outage worse for everyone, burning through retry budgets, and preventing the provider from recovering. Users experience compounding latency as each request queues behind failing ones.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Required for Agents, Critical for Streaming systems where stalled requests are immediately visible to users
- Recommended for RAG systems; Optional for Batch (which can pause natively)
- Your system sends enough traffic that continued requests to a failing provider cause meaningful harm
- You've observed cascading failures where one provider's outage degraded your entire system
- You need fast failure detection — seconds, not minutes — to trigger failover or degradation

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

- Low-traffic internal tools where the volume of requests can't meaningfully harm a provider
- Batch jobs with built-in pauses that naturally rate-limit requests
- Systems where the provider is your own infrastructure and you have other health-check mechanisms
- Single-user tools where the "circuit" is just one person who can stop manually

## Companion Content

- Blog post: [Circuit Breaker](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Retry with Budget](../retry-with-budget/) (#5, S2) — the circuit breaker sits above retries, stopping them when failure is systemic
  - [Multi-Provider Failover](../multi-provider-failover/) (#9, S3) — when the circuit opens, failover routes to an alternative provider
  - [Graceful Degradation](../graceful-degradation/) (#1, S1) — when the circuit opens and no failover exists, degrade gracefully
  - [Structured Tracing](../../observability/structured-tracing/) (#8, S3) — traces circuit state transitions for debugging

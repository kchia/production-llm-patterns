# Retry with Budget

## The Problem

Naive retries with fixed delays amplify outages. When a provider is overloaded, 1,000 clients all retrying at the same interval create a thundering herd that turns a 2-second blip into a 30-second cascading failure. Unbounded retries also blow through your token budget — each retry is another paid API call, and without a budget, a single failing request can generate dozens of retries before anyone notices.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Required for Agents, Streaming, and Batch (3/4 navigation matrix density)
- Recommended for RAG systems
- Your system makes enough concurrent calls that retry storms become a real risk (typically >100 req/min)
- You're calling rate-limited APIs where uncoordinated retries trigger rate limit escalation
- You've observed retry amplification during provider incidents — the retries made the outage worse

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

- Single-shot scripts where you can manually retry on failure
- Synchronous UIs where the user controls retry timing and frequency
- Extremely low call volumes where thundering herd is impossible
- Idempotent batch jobs where retrying the entire batch is simpler than per-request retry logic

## Companion Content

- Blog post: [Retry with Budget](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Circuit Breaker](../circuit-breaker/) (#6, S2) — stops retries entirely when a provider is confirmed failing
  - [Graceful Degradation](../graceful-degradation/) (#1, S1) — what to do when retries are exhausted
  - [Token Budget Middleware](../../cost-control/token-budget-middleware/) (#3, S1) — caps the financial cost of retries
  - [Concurrent Request Management](../../performance/concurrent-request-management/) (#23, S7) — manages the concurrency that retry storms disrupt

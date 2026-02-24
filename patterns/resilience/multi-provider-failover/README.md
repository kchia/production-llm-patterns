# Multi-Provider Failover

## The Problem

Single-provider dependency means a single outage takes your entire LLM capability offline. Provider outages happen regularly — every major provider has had multi-hour incidents. Without failover, you're writing incident reports explaining why the whole feature was down because one API had issues. The blast radius of a provider outage equals the blast radius of your LLM feature.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Critical for Streaming systems where downtime is immediately user-visible
- High ROI for Agent systems that can't pause mid-workflow
- Recommended for RAG and Batch systems
- You've had an incident where a provider outage caused a customer-facing feature to go fully offline
- Your SLA requires higher availability than any single LLM provider can guarantee
- You're in a regulated industry where provider concentration is a risk factor

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

- Model behavior differences between providers would produce unacceptable output variation for your use case
- You're locked to a single provider by contract, compliance, or fine-tuned model dependency
- Prototyping where uptime isn't a concern and multi-provider complexity slows iteration
- Cost constraints make maintaining accounts and testing across multiple providers impractical

## Companion Content

- Blog post: [Multi-Provider Failover](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Graceful Degradation](../graceful-degradation/) (#1, S1) — fallback when all providers fail
  - [Circuit Breaker](../circuit-breaker/) (#6, S2) — triggers the failover by detecting provider failure
  - [Model Routing](../../cost-control/model-routing/) (#13, S4) — routes by capability/cost; failover routes by availability
  - [Latency Budget](../../performance/latency-budget/) (#14, S4) — failover latency counts against the budget

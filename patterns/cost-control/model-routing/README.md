# Model Routing

## The Problem

Not every request needs GPT-4. Without model routing, you're paying premium prices for tasks a smaller model handles just as well. Simple classification, extraction, and summarization tasks don't need the most expensive model, but without routing, they all go to the same endpoint. At scale, a large fraction of your spend may be going to an overpowered model for tasks that don't need it.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- High ROI for Agents and Batch systems; Recommended for RAG and Streaming
- Your workload has a mix of complexity levels — some tasks are simple extraction, others need deep reasoning
- You're paying a flat premium rate for everything and your cost analysis shows opportunity for savings
- You've benchmarked your tasks and confirmed that cheaper models produce acceptable quality for a significant fraction

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

- Output quality variation between models is unacceptable for any task in your workload
- Very low volume where routing infrastructure cost isn't justified by savings
- Single-task systems where the optimal model is always the same
- Provider lock-in where you can only use one model family

## Companion Content

- Blog post: [Model Routing](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Token Budget Middleware](../token-budget-middleware/) (#3, S1) — routing to cheaper models is a cost control lever, complementing budget enforcement
  - [Semantic Caching](../semantic-caching/) (#12, S4) — caching avoids calls entirely; routing makes calls cheaper
  - [Cost Dashboard](../cost-dashboard/) (#32, S9) — visualizes the cost impact of routing decisions
  - [Multi-Provider Failover](../../resilience/multi-provider-failover/) (#9, S3) — failover routes by availability; model routing routes by capability and cost
  - [Latency Budget](../../performance/latency-budget/) (#14, S4) — smaller models are faster; routing affects latency

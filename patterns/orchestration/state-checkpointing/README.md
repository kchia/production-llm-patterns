# State Checkpointing

## The Problem

Long-running LLM workflows fail partway through — API timeouts, rate limits, provider outages, process crashes. Without checkpointing, you restart from scratch, re-running expensive LLM calls you already completed successfully. For a 10-step agent workflow, a failure at step 8 means paying for steps 1-7 again. At scale, this turns transient failures into significant cost and latency multipliers.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Critical for Batch systems with long-running processing jobs
- Required for Agent systems with multi-step workflows
- N/A for Streaming; Optional for RAG (typically single-pass)
- Your workflows have 5+ steps where each step involves an LLM call
- Failure recovery cost (re-running completed steps) justifies the checkpointing overhead
- You've had incidents where a late-stage failure wasted significant compute and API spend

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

- Single-step LLM calls — nothing to checkpoint
- Short workflows where restart cost is negligible (< 3 steps, cheap model)
- Stateless request-response patterns where each request is independent
- Streaming systems where state is inherently transient and not worth persisting
- Workflows where idempotency makes re-running cheap and safe

## Companion Content

- Blog post: [State Checkpointing](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Agent Loop Guards](../agent-loop-guards/) (#17, S5) — loop detection triggers checkpoint-based recovery instead of full restart
  - [Multi-Agent Routing](../multi-agent-routing/) (#31, S8) — multi-agent systems need per-agent checkpointing
  - [Retry with Budget](../../resilience/retry-with-budget/) (#5, S2) — retries resume from checkpoint instead of restarting
  - [Token Budget Middleware](../../cost-control/token-budget-middleware/) (#3, S1) — checkpointing prevents re-spending tokens on completed steps

# Multi-Agent Routing

## The Problem

As agent systems grow, a single agent can't handle all task types effectively. Without routing, you either build one monolithic agent with an enormous prompt (fragile, expensive, slow) or manually hardcode task-to-agent mappings (brittle, doesn't scale). The monolithic agent degrades on specialized tasks because its prompt tries to cover everything. Routing decisions need to be dynamic, observable, and recoverable.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Critical for Agent systems with multiple specialized capabilities
- Recommended for Batch; Optional for RAG and Streaming
- Your single agent's prompt is growing unwieldy — a sign this is happening is when instructions exceed a couple thousand tokens and start covering unrelated task types
- Different tasks need different tools, models, or system prompts
- You need observable routing decisions — why was this task sent to this agent?
- You have 3+ distinct task categories that would benefit from specialized handling

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

- Single-purpose agents with one task type — no routing needed
- Systems with fewer than 3 distinct task categories — the overhead of routing isn't justified
- Early-stage agent development where the task taxonomy isn't stable yet — routing too early locks in a premature taxonomy
- Systems where all tasks use the same tools and model — no benefit to specialization

## Companion Content

- Blog post: [Multi-Agent Routing](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Agent Loop Guards](../agent-loop-guards/) (#17, S5) — each routed agent needs its own loop guards
  - [Tool Call Reliability](../tool-call-reliability/) (#20, S6) — each specialized agent has its own tool set to validate
  - [State Checkpointing](../state-checkpointing/) (#25, S7) — multi-agent workflows need coordinated checkpointing
  - [Model Routing](../../cost-control/model-routing/) (#13, S4) — model routing selects models by cost/capability; agent routing selects agents by task type
  - [Human-in-the-Loop](../../safety/human-in-the-loop/) (#34, S9) — routing decisions can include escalation to human agents

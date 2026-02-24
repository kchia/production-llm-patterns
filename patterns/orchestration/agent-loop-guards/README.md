# Agent Loop Guards

## The Problem

An agent gets stuck in a loop — calling the same tool repeatedly, oscillating between two states, or recursing without making progress. Without guards, this runs until your token budget is exhausted. A single infinite agent loop can easily rack up $50+ in wasted API calls before anyone notices. The failure is silent from the outside (the agent looks busy) and expensive by the time anyone notices.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Critical for Agent systems — any LLM that can call tools or take multi-step actions autonomously
- Recommended for Streaming and Batch systems with iterative processing
- Optional for RAG (typically single-pass)
- Your LLM can take actions in a loop — tool calls, multi-step reasoning, or recursive decomposition
- You've seen or can imagine a scenario where the agent generates unbounded actions without converging

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

- Single-step LLM calls with no tool use — no loop possible
- Human-in-the-loop workflows where a person approves each step — the human is the guard
- Systems with inherently bounded execution (fixed pipeline stages, no conditional loops)
- Prototypes where the developer is watching and can kill the process manually

## Companion Content

- Blog post: [Agent Loop Guards](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [State Checkpointing](../state-checkpointing/) (#25, S7) — saves progress so that when a loop is detected, partial work isn't lost
  - [Multi-Agent Routing](../multi-agent-routing/) (#31, S8) — loop guards apply to each agent in a multi-agent system
  - [Token Budget Middleware](../../cost-control/token-budget-middleware/) (#3, S1) — financial backstop when loop guards fail
  - [Tool Call Reliability](../tool-call-reliability/) (#20, S6) — validates tool calls within the loop
  - [Human-in-the-Loop](../../safety/human-in-the-loop/) (#34, S9) — escalation path when loop detection triggers

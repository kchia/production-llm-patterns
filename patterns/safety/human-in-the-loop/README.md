# Human-in-the-Loop

## The Problem

Some LLM decisions are too consequential for full automation — financial transactions, user-facing communications, medical recommendations, content moderation edge cases. Without human-in-the-loop patterns, you either automate everything (risking costly or harmful errors) or review everything (doesn't scale and creates bottlenecks). There's no principled way to decide what needs human oversight, how to route it, or how to learn from human decisions.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Required for Agent systems making consequential decisions with real-world impact
- Optional for RAG and Batch; N/A for Streaming (real-time doesn't allow synchronous review)
- The safety capstone — builds on all safety patterns (#2 validation, #7 PII, #15 injection defense)
- The cost of a wrong LLM action exceeds the cost of human review
- You're in a regulated domain where some actions require human sign-off
- You want to build a feedback loop where human corrections improve the system over time

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

- Low-stakes applications where wrong outputs are harmless (brainstorming, entertainment)
- High-volume systems where human review is economically infeasible at the required throughput
- Internal tools where the user is the reviewer — they're already in the loop by definition
- Systems where automated safety filters (validation, PII, injection defense) provide sufficient protection
- Real-time streaming where synchronous human review would break the user experience

## Companion Content

- Blog post: [Human-in-the-Loop](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Structured Output Validation](../structured-output-validation/) (#2, S1) — automated validation reduces the volume of items needing human review
  - [PII Detection](../pii-detection/) (#7, S2) — PII flags can route items to human review
  - [Prompt Injection Defense](../prompt-injection-defense/) (#15, S5) — injection detection can escalate to human review
  - [Agent Loop Guards](../../orchestration/agent-loop-guards/) (#17, S5) — loop detection can escalate to human intervention
  - [Multi-Agent Routing](../../orchestration/multi-agent-routing/) (#31, S8) — human reviewers as a "routing destination" for high-stakes tasks

# Adversarial Inputs

## The Problem

Your system works great on happy-path inputs but breaks on edge cases — typos, Unicode, extremely long inputs, inputs in unexpected languages, deliberately adversarial prompts. Without adversarial testing, you discover these failure modes in production, one user complaint at a time. Each edge case is a small probability event, but with enough users, they happen daily.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Critical for Agent systems where adversarial inputs could trigger dangerous tool calls
- Recommended for RAG and Streaming systems
- Optional for Batch (controlled inputs)
- Your system accepts user-generated input from untrusted sources
- Verifying that safety filters, validation, and injection defenses hold up against creative attacks matters before shipping
- You're preparing for a security review or compliance audit

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

- Internal tools with controlled input where users are trusted and inputs are predictable
- Systems where all inputs are machine-generated from known schemas — no adversarial surface
- Very early prototypes where edge case hardening is premature
- Batch systems processing curated datasets with known input distributions

## Companion Content

- Blog post: [Adversarial Inputs](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Eval Harness](../eval-harness/) (#4, S1) — provides the evaluation framework for adversarial test suites
  - [Prompt Injection Defense](../../safety/prompt-injection-defense/) (#15, S5) — adversarial tests validate injection defenses
  - [Regression Testing](../regression-testing/) (#11, S4) — adversarial cases become part of the regression suite
  - [PII Detection](../../safety/pii-detection/) (#7, S2) — adversarial inputs can try to bypass PII filters

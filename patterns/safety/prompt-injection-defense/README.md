# Prompt Injection Defense

## The Problem

Users (or data sources retrieved by RAG) can embed instructions in their input that override your system prompt. Without defense, a user typing "Ignore previous instructions and..." can make your LLM leak system prompts, bypass safety filters, exfiltrate data via tool calls, or produce harmful outputs. As LLMs gain access to more tools and data, the blast radius of successful injection grows.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Critical for Agent systems where injected instructions could trigger tool calls with real-world consequences
- Required for RAG (retrieved documents can contain injections) and Streaming systems
- Recommended for Batch systems
- Your LLM has access to tools, APIs, or sensitive data that an attacker could abuse
- You accept user-generated input or process documents from untrusted sources
- Growing regulatory attention makes injection defense an audit expectation

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

- Internal tools with fully trusted users where injection is not a threat model
- Systems where the LLM has no access to tools, sensitive data, or consequential actions
- Offline analysis pipelines where all outputs are human-reviewed before any action is taken
- Prototypes without production exposure where security isn't yet a priority

## Companion Content

- Blog post: [Prompt Injection Defense](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Structured Output Validation](../structured-output-validation/) (#2, S1) — validates output structure as a defense layer; injection defense validates input
  - [PII Detection](../pii-detection/) (#7, S2) — another input safety pattern; injection can be used to exfiltrate PII
  - [Human-in-the-Loop](../human-in-the-loop/) (#34, S9) — human review as a last-resort defense against injection
  - [Adversarial Inputs](../../testing/adversarial-inputs/) (#18, S5) — tests injection defense with adversarial prompts
  - [Tool Call Reliability](../../orchestration/tool-call-reliability/) (#20, S6) — validates tool calls that injection might try to manipulate

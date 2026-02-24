# PII Detection

## The Problem

Users paste sensitive data into LLM-powered features — social security numbers, credit card numbers, medical records, email addresses. Without PII detection, that data flows to third-party API providers, gets logged in your observability stack, and potentially persists in model training data. This creates regulatory exposure under GDPR, HIPAA, CCPA, and other frameworks — exposure that scales linearly with your user count.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Required across all four system types (RAG, Agents, Streaming, Batch) — 4/4 navigation matrix density with all Required
- Regulatory necessity for any system handling user-generated input in regulated industries
- Your system logs LLM inputs/outputs (most observability stacks do) and those logs could contain PII
- You send data to third-party LLM providers and need to comply with data processing agreements
- You've had a compliance audit or data breach scare involving LLM pipelines

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

- Systems processing only synthetic or public data with no user-generated content
- Internal tools where all users have security clearance for the data they're processing
- On-premise deployments with no external API calls where data never leaves your infrastructure
- Systems in jurisdictions with no applicable data protection regulations (rare and shrinking)

## Companion Content

- Blog post: [PII Detection](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Prompt Injection Defense](../prompt-injection-defense/) (#15, S5) — another input safety pattern; injection can be used to exfiltrate PII
  - [Structured Output Validation](../structured-output-validation/) (#2, S1) — validates output structure; PII detection validates output content
  - [Human-in-the-Loop](../human-in-the-loop/) (#34, S9) — human review as a last-resort PII catch
  - [Structured Tracing](../../observability/structured-tracing/) (#8, S3) — traces must also be PII-safe; detection informs what gets logged

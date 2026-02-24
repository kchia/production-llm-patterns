# Structured Tracing

## The Problem

LLM calls are black boxes. When something goes wrong, you can't tell if the problem was the prompt, the model, the parsing, or a downstream service. Without structured tracing, debugging a single bad response means grepping through logs hoping to reconstruct the call chain. Multi-step pipelines (RAG retrieval → augmentation → generation → validation) make this exponentially worse — tracing causality, not just events, becomes the real challenge.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Required for RAG and Streaming, Critical for Agents — the foundation for all observability patterns
- Recommended for Batch systems
- Your LLM calls involve more than one step (retrieval, generation, validation, tool calls)
- You can't currently answer "why did this specific request produce a bad response?" from your logs
- Correlating latency, cost, and quality metrics back to specific pipeline stages matters for diagnosing bottlenecks

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

- Single-step LLM calls with no chain — a single request/response is simple enough to debug with basic logging
- Prototypes where printf debugging suffices and you're iterating too fast for structured instrumentation
- Systems already using comprehensive APM tools (Datadog, Honeycomb) that cover LLM calls natively
- Very low volume systems where you can manually inspect every request

## Companion Content

- Blog post: [Structured Tracing](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Output Quality Monitoring](../output-quality-monitoring/) (#16, S5) — attaches quality scores to traces
  - [Drift Detection](../drift-detection/) (#28, S8) — uses trace data to detect behavioral changes over time
  - [Online Eval Monitoring](../online-eval-monitoring/) (#21, S6) — runs eval on traced production traffic
  - [Prompt Version Registry](../prompt-version-registry/) (#10, S3) — traces reference prompt versions for correlation
  - [PII Detection](../../safety/pii-detection/) (#7, S2) — traces must be PII-safe

# Tool Call Reliability

## The Problem

LLMs generate tool calls with wrong argument types, missing required fields, hallucinated function names, or malformed JSON. Without reliability patterns, a non-trivial percentage of tool calls fail at parse time, and another fraction fail with valid-but-wrong arguments that produce silent errors downstream. The LLM confidently calls a function that doesn't exist, or passes a string where an integer is required.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Critical for Agent systems that rely on tool use as their primary action mechanism
- Recommended for RAG and Batch systems with function calling
- Optional for Streaming
- Your LLM generates function/tool calls and you've seen parse failures or wrong-argument errors
- Tool call failures cause user-visible errors or silent data corruption
- Tool calls that aren't reliable enough end up consuming retry budgets with format errors

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

- Systems without tool/function calling — no tool calls to validate
- Simple tool schemas where validation is trivial (single parameter, string only)
- Human-in-the-loop workflows where a person verifies every tool call before execution
- Prototypes where tool call errors are acceptable and manually corrected

## Companion Content

- Blog post: [Tool Call Reliability](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Structured Output Validation](../../safety/structured-output-validation/) (#2, S1) — tool call reliability is structured output validation applied specifically to function calls
  - [Agent Loop Guards](../agent-loop-guards/) (#17, S5) — guards against loops caused by repeated failed tool calls
  - [State Checkpointing](../state-checkpointing/) (#25, S7) — saves state before tool execution for recovery
  - [Prompt Injection Defense](../../safety/prompt-injection-defense/) (#15, S5) — injection can manipulate tool call arguments
  - [Retry with Budget](../../resilience/retry-with-budget/) (#5, S2) — retries for transient tool call failures

# Chunking Strategies

## The Problem

Poor chunking destroys retrieval quality. Chunk too small and you lose context — a sentence about "the contract" means nothing without knowing which contract. Chunk too large and you dilute relevance with noise, wasting context window tokens. Chunk on arbitrary boundaries (every 500 tokens) and you split sentences, code blocks, tables, and logical units in half, producing fragments that mislead the LLM.

## What I Would Not Do

The naive approach most teams take first, and specifically why it breaks under production conditions.

## When You Need This

- Critical for RAG systems — the single biggest determinant of retrieval quality
- Recommended for Batch pipelines processing documents for downstream indexing
- Optional for Agents; N/A for Streaming
- You're building or maintaining a vector-based retrieval system
- Your retrieval results are "close but not quite" — relevant documents found but wrong chunks selected
- You have heterogeneous document types (prose, code, tables, structured data) that need different chunking

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

- Non-RAG systems that don't use vector retrieval
- Systems using small documents that fit entirely in a single context window — no chunking needed
- Chat applications without document retrieval where the only context is conversation history
- Systems using provider-native document processing (e.g., Anthropic's document support) that handles chunking internally

## Companion Content

- Blog post: [Chunking Strategies](link) -- deeper reasoning on why this pattern matters
- Related patterns:
  - [Embedding Refresh](../embedding-refresh/) (#29, S8) — chunks need re-embedding when the chunking strategy changes
  - [Index Maintenance](../index-maintenance/) (#30, S8) — chunk quality affects index health
  - [Context Management](../context-management/) (#22, S6) — manages how retrieved chunks fit into the context window
  - [Eval Harness](../../testing/eval-harness/) (#4, S1) — measures retrieval quality to evaluate chunking effectiveness

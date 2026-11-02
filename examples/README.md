# Framework Adapters

> **Part of [Production LLM Patterns](../README.md).** These examples show how to wire production LLM patterns alongside popular frameworks.

The patterns in this repo are framework-agnostic — they work with any HTTP client or SDK. These adapters show how to compose them with four common frameworks, each demonstrating 2-3 patterns that address that framework's most common production failure modes.

---

## Adapters

| Framework | Patterns Demonstrated | Best For |
|-----------|----------------------|----------|
| [raw-sdk](./raw-sdk/) | Graceful Degradation + Retry with Budget + Structured Output Validation | Maximum control, no framework overhead |
| [vercel-ai](./vercel-ai/) | Graceful Degradation + Token Budget Middleware + Streaming Backpressure | Streaming-first Next.js and edge deployments |
| [langchain](./langchain/) | Structured Output Validation + Prompt Version Registry + Tool Call Reliability | Chain-based workflows and agent systems |
| [llamaindex](./llamaindex/) | Chunking Strategies + Context Management + Structured Output Validation | RAG pipelines |

---

## How to Navigate

Each adapter directory has:

- `README.md` — what patterns are demonstrated and why, architecture diagram, key wiring points
- `index.ts` — self-contained TypeScript example with inline pattern logic
- `package.json` — minimal dependencies to run the example

The pattern logic in each `index.ts` is inlined to keep the examples runnable without importing from the full pattern directories. For production, import from the pattern implementations directly — for example, `../../patterns/resilience/graceful-degradation/src/ts/index.ts` for the full `DegradationChain` with failure mode handling, benchmarks, and Python parity.

---

## The Pattern Stack by Framework

The way I'd think about it: every framework wraps raw HTTP calls underneath. The failure modes come from the framework layer — what it abstracts away and what it leaves exposed.

**raw-sdk** gives you nothing and exposes everything. Start here to understand the baseline. Every other adapter builds on this foundation.

**vercel-ai** is streaming-first. The streaming path introduces backpressure risk that doesn't exist in batch calls, and token budgeting matters more here because you can't easily truncate a stream mid-flight.

**langchain** is composition-focused. Its chain abstractions are powerful but make prompt changes opaque. Versioned prompt management and tool call validation add the observability and reliability that chain composition otherwise hides.

**llamaindex** is RAG-focused. Its ingestion pipeline and query engine are solid, but the chunking defaults are tuned for demos rather than production retrieval quality, and query responses are unvalidated strings.

---

## Related

- [Integration Guides](../integrations/) — system-type guides showing which patterns to combine for RAG, Agents, Streaming, Batch, Multi-Agent systems
- [Composition Recipes](../docs/recipes/) — 2-3 patterns wired together for a specific cross-cutting problem
- [Pattern Categories](../patterns/) — full pattern implementations with benchmarks and cost analysis

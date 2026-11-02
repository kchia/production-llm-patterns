# Framework Adapter: Vercel AI SDK

> **Patterns demonstrated:** [Graceful Degradation](../../patterns/resilience/graceful-degradation/) · [Token Budget Middleware](../../patterns/cost-control/token-budget-middleware/) · [Streaming Backpressure](../../patterns/performance/streaming-backpressure/)

The Vercel AI SDK (`ai` package) provides `generateText`, `streamText`, and `generateObject` with a unified provider interface. Its streaming-first design makes it a natural fit for real-time LLM features in Next.js and edge deployments — but streaming introduces failure modes that don't exist in batch calls.

The combination I'd want for a streaming feature: graceful degradation across providers, token budgeting before each call, and backpressure-aware streaming that aborts when the consumer falls behind. Without the budget check, a large context window can cost 10× more than expected in a single request. Without backpressure handling, a slow consumer silently buffers the entire response in memory before any of it renders.

---

## Architecture

```
  Request
    │
    ├─[token budget check]─→ over budget → error before API call
    │
    ▼
┌───────────────────────────────────────────────────┐
│  DegradationChain (generateText tiers)            │
│  ├─ tier 1: anthropic/claude-sonnet-4-6           │→ quality: 1.0
│  ├─ tier 2: openai/gpt-4o-mini                    │→ quality: 0.7
│  └─ tier 3: static fallback                       │→ quality: 0.1
└───────────────────────────────────────────────────┘
    │  [streaming path]
    ▼
┌───────────────────────────────────────────────────┐
│  streamText with backpressure signal              │
│  ├─ track chunk processing time per chunk         │
│  └─ abort stream when consumer exceeds threshold  │
└───────────────────────────────────────────────────┘
```

---

## Key Wiring Points

**Token budget check runs before the API call**, not after. The input token cost is paid the moment the request leaves your process — checking after means you've already spent it.

```ts
// Correct: check before calling
checkBudget(prompt, budget);
const result = await generateText({ model, prompt });
budget.remaining -= result.usage.completionTokens;

// Incorrect: enforce after the fact
const result = await generateText({ model, prompt });
if (result.usage.completionTokens > limit) throw new Error('over budget'); // already paid
```

**Streaming backpressure uses AbortController to stop generation**, not buffering to stop consumption. If the consumer is slow, the right move is to abort the stream and surface the error — not buffer an arbitrarily large response waiting for the consumer to catch up.

---

## Running the Example

```bash
cd examples/vercel-ai
npm install
ANTHROPIC_API_KEY=sk-ant-... OPENAI_API_KEY=sk-... npx tsx index.ts
```

---

## What to Watch

| Signal | What it means |
|--------|---------------|
| Budget-exceeded errors at input | Prompt is too long; add context trimming upstream |
| Stream-aborted errors > 10% | Consumer is consistently slow; reduce `maxTokens` or move to batch |
| `degraded=true` in chain result | Primary provider unavailable; check Anthropic / OpenAI status |

---

## Pattern References

- [Graceful Degradation](../../patterns/resilience/graceful-degradation/README.md) — tier design, quality scoring, failure mode analysis
- [Token Budget Middleware](../../patterns/cost-control/token-budget-middleware/README.md) — budget tracking, cost projections, per-request limits
- [Streaming Backpressure](../../patterns/performance/streaming-backpressure/README.md) — backpressure signals, abort strategies, consumer pacing

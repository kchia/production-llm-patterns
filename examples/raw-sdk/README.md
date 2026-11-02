# Framework Adapter: Plain OpenAI / Anthropic SDK

> **Patterns demonstrated:** [Graceful Degradation](../../patterns/resilience/graceful-degradation/) · [Retry with Budget](../../patterns/resilience/retry-with-budget/) · [Structured Output Validation](../../patterns/safety/structured-output-validation/)

The plain SDK is the baseline — no framework abstractions, just HTTP calls. The way I think about it: every other framework adapter in this directory wraps these same raw calls underneath. Understanding this layer means understanding all of them.

Without resilience added at this layer, a single provider hiccup takes your entire feature offline. Three distinct failure modes need three distinct solutions: retries absorb transient blips (rate limits, momentary 503s), graceful degradation handles sustained failures (provider down for minutes or hours), and structured output validation catches schema drift before it reaches your users.

---

## Architecture

```
  Request
    │
    ▼
┌───────────────────────────────────────────────┐
│  DegradationChain                             │
│  ├─ tier 1: gpt-4o      + RetryBudget(3)      │→ quality: 1.0
│  ├─ tier 2: gpt-4o-mini + RetryBudget(2)      │→ quality: 0.7
│  └─ tier 3: static fallback                   │→ quality: 0.1
└───────────────────────────────────────────────┘
    │
    ▼
┌───────────────────────────┐
│  OutputValidator           │→ valid JSON → caller
│  (JSON block extraction)  │→ invalid   → structured error
└───────────────────────────┘
```

---

## Key Wiring Points

**Retry wraps the SDK call, not the chain.** If retry wraps the whole chain, you re-run after every tier has failed — which defeats graceful degradation.

```ts
// Correct: retry is inside the tier handler
const primaryTier = {
  handler: (req) => withRetry(() => openai.chat.completions.create(...), 3),
};

// Incorrect: retry wraps the full chain
const result = await withRetry(() => chain.execute(req), 3); // re-runs exhausted tiers
```

**Validation runs after the chain.** The chain's job is to produce *some* response from *some* tier. Validation decides whether that response is structurally usable — that's a separate concern from which tier served it.

---

## Running the Example

```bash
cd examples/raw-sdk
npm install
OPENAI_API_KEY=sk-... npx tsx index.ts
```

---

## What to Watch

| Signal | What it means |
|--------|---------------|
| `result.degraded === true` | Primary tier failed; check provider status dashboard |
| Validation failures > 5% | Output schema drifting; review the prompt and expected JSON shape |
| All-tiers-exhausted error | Sustained outage; consider adding a circuit breaker upstream |

---

## Pattern References

- [Graceful Degradation](../../patterns/resilience/graceful-degradation/README.md) — full failure mode analysis, tier design, benchmarks
- [Retry with Budget](../../patterns/resilience/retry-with-budget/README.md) — budget management, jitter strategies, budget-exhaustion detection
- [Structured Output Validation](../../patterns/safety/structured-output-validation/README.md) — schema validation, silent failures, retry-on-invalid

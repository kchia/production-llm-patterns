# Recipe: Resilience Stack

> **Patterns combined:** [Retry with Budget](../../patterns/resilience/retry-with-budget/) + [Circuit Breaker](../../patterns/resilience/circuit-breaker/) + [Graceful Degradation](../../patterns/resilience/graceful-degradation/)

A production LLM system that depends on a single external API has a single point of failure. These three patterns compose into layered protection: retries absorb transient blips, the circuit breaker contains systemic failures, and graceful degradation keeps the system responding even when the provider is completely down.

---

## When This Combination Makes Sense

The trigger isn't a single incident — it's recognizing that your system has no middle ground. Either the provider responds or users see errors. A few signals I'd look for:

- A provider outage took a feature entirely offline, even briefly
- Retry logic made a degraded period worse (retry storms amplifying load)
- You have user-facing SLAs and no documented plan for what "reduced service" looks like
- Multiple instances independently retry the same failing endpoint without coordination

Any one of these patterns adds value on its own. The combination is what makes the system composable under adversarial conditions — each layer handles a different failure timescale.

---

## How the Three Patterns Compose

The patterns address three different failure durations:

| Layer | Pattern | Failure Timescale | What It Handles |
|---|---|---|---|
| 1 | Retry with Budget | Milliseconds to seconds | Single transient error — 503, momentary rate limit |
| 2 | Circuit Breaker | Seconds to minutes | Systemic failure — provider degraded, not just hiccupping |
| 3 | Graceful Degradation | Minutes to hours | Full provider outage — nothing works, serve best available |

A request flows through all three on the critical path. The retry layer is the innermost — it wraps individual provider calls. The circuit breaker sits outside the retry layer and watches the aggregate failure rate. The degradation chain wraps both and defines what to do when the primary provider's circuit is open.

### Architecture

```
                     Incoming Request
                            │
                            ▼
             ┌──────────────────────────┐
             │    DegradationChain       │
             │  (tier 1: primary+guards)│
             └──────────────────────────┘
                            │
                 ┌──────────▼──────────┐
                 │   CircuitBreaker    │
                 │   check state       │
                 └──────────┬──────────┘
                            │
              CLOSED/        │        OPEN
              HALF_OPEN      │        │
                   │         │        ▼
                   ▼         │   ┌────────────────────┐
          ┌──────────────┐   │   │ Fast-fail → tier 2 │
          │ RetryBudget  │   │   └────────────────────┘
          │ execute()    │   │
          └──────┬───────┘   │
                 │           │
           success│     ╔════╩══╗
                 │     ║record ║
                 │     ║window ║
                 ▼     ╚═══════╝
             Response
             (quality: 1.0)
                            │
                  ╔═════════╝ (tier 1 fails)
                  ║
                  ▼
     ┌────────────────────────────┐
     │ Tier 2: Alt model/provider │──→ Response (quality: 0.7)
     └────────────────────────────┘
                  │ (fails)
                  ▼
     ┌────────────────────────────┐
     │ Tier 3: Cached response    │──→ Response (quality: 0.5)
     └────────────────────────────┘
                  │ (miss)
                  ▼
     ┌────────────────────────────┐
     │ Tier 4: Static fallback    │──→ Response (quality: 0.1)
     └────────────────────────────┘
```

> Note: quality scores above are illustrative. The right values depend on your SLA and what "acceptable" means for your specific use case.

---

## Wiring Code

### TypeScript

```typescript
import { RetryWithBudget } from '../patterns/resilience/retry-with-budget/src/ts/index.js';
import { CircuitBreaker } from '../patterns/resilience/circuit-breaker/src/ts/index.js';
import { DegradationChain } from '../patterns/resilience/graceful-degradation/src/ts/index.js';
import type { LLMRequest } from '../patterns/resilience/graceful-degradation/src/ts/types.js';

// Shared retry budget — all callers draw from the same pool.
// Prevents N independent instances from multiplying retry load.
const retryBudget = new RetryWithBudget({
  maxAttempts: 3,
  initialDelayMs: 200,
  maxDelayMs: 5000,
  jitterMode: 'full',           // randomizes delays to avoid synchronized retries
  budgetConfig: { maxTokens: 100 },
  onRetry: (event) => {
    console.warn(`retry attempt ${event.attempt}/${event.maxAttempts}`, {
      budgetRemaining: event.budgetRemaining,
      delayMs: event.delayMs,
    });
  },
});

// Circuit breaker watches failure rates across the retry boundary.
// It sees failures after retries are exhausted, not per-attempt.
const primaryBreaker = new CircuitBreaker({
  failureThreshold: 50,     // trip at 50% failure rate
  resetTimeoutMs: 30_000,   // probe after 30s
  minimumRequests: 10,
  onStateChange: (event) => {
    console.error(`circuit ${event.from} → ${event.to}`, {
      failureRate: event.failureRate,
    });
  },
});

// Provider call wrapped in retry + circuit breaker.
// This becomes tier 1 in the degradation chain.
async function callPrimaryProvider(request: LLMRequest) {
  return primaryBreaker.execute(() =>
    retryBudget.execute(() => callOpenAI(request))
  );
}

// Degradation chain — defines what "reduced service" looks like.
const degradationChain = new DegradationChain({
  globalTimeoutMs: 8_000,
  tiers: [
    {
      name: 'primary',
      qualityScore: 1.0,
      timeoutMs: 4_000,
      handler: callPrimaryProvider,
    },
    {
      name: 'fallback-provider',
      qualityScore: 0.7,
      timeoutMs: 4_000,
      handler: (req) => callAnthropicFallback(req),
    },
    {
      name: 'cache',
      qualityScore: 0.5,
      timeoutMs: 100,
      handler: (req) => lookupSemanticCache(req),
    },
    {
      name: 'static',
      qualityScore: 0.1,
      timeoutMs: 10,
      handler: (_req) => Promise.resolve({ content: 'Service is temporarily reduced. Please try again shortly.', model: 'static' }),
    },
  ],
  onDegradation: (result) => {
    // Emit a metric whenever we serve below tier 1.
    recordDegradation(result.tier, result.quality);
  },
});

// Application-level handler — single entry point.
export async function handleRequest(prompt: string) {
  const result = await degradationChain.execute({ prompt });
  return {
    content: result.response.content,
    quality: result.quality,
    degraded: result.degraded,
  };
}
```

### Python

```python
from patterns.resilience.graceful_degradation.src.py import DegradationChain, DegradationTier
from patterns.resilience.circuit_breaker.src.py import CircuitBreaker, CircuitBreakerConfig
from patterns.resilience.retry_with_budget.src.py import RetryWithBudget, RetryWithBudgetConfig

# Shared retry budget — module-level singleton so all callers share the pool.
retry_budget = RetryWithBudget(
    config=RetryWithBudgetConfig(
        max_attempts=3,
        initial_delay_ms=200,
        max_delay_ms=5000,
        jitter_mode="full",
        budget_config={"max_tokens": 100},
    )
)

# Circuit breaker tracks failures after retries are exhausted.
primary_breaker = CircuitBreaker(
    config=CircuitBreakerConfig(
        failure_threshold=50,
        reset_timeout_ms=30_000,
        minimum_requests=10,
        on_state_change=lambda event: print(
            f"circuit {event.from_state} → {event.to_state} "
            f"(failure_rate={event.failure_rate:.1f}%)"
        ),
    )
)

async def call_primary_provider(request):
    return await primary_breaker.execute(
        lambda: retry_budget.execute(lambda: call_openai(request))
    )

# Degradation chain with four tiers. Tiers are tried in order.
chain = DegradationChain(
    tiers=[
        DegradationTier(
            name="primary",
            quality_score=1.0,
            timeout_ms=4_000,
            handler=call_primary_provider,
        ),
        DegradationTier(
            name="fallback-provider",
            quality_score=0.7,
            timeout_ms=4_000,
            handler=call_anthropic_fallback,
        ),
        DegradationTier(
            name="cache",
            quality_score=0.5,
            timeout_ms=100,
            handler=lookup_semantic_cache,
        ),
        DegradationTier(
            name="static",
            quality_score=0.1,
            timeout_ms=10,
            handler=lambda _req: {"content": "Service is temporarily reduced."},
        ),
    ],
    global_timeout_ms=8_000,
    on_degradation=lambda result: record_degradation(result.tier, result.quality),
)

async def handle_request(prompt: str) -> dict:
    result = await chain.execute({"prompt": prompt})
    return {
        "content": result.response["content"],
        "quality": result.quality,
        "degraded": result.degraded,
    }
```

---

## What to Watch

The three patterns generate overlapping signals. The key is understanding what each one tells you and which layer is responsible.

### Metrics to Track

| Metric | What It Signals | Alert If |
|---|---|---|
| `retry.attempts` per request | Transient error rate | p99 > 1 (most requests retrying) |
| `retry.budget_remaining` | Retry pool health | < 20% of max |
| `circuit.failure_rate` | Provider health (in window) | > 40% before trip, trend matters |
| `circuit.state` gauge | Whether circuit is open | State OPEN for > 60s |
| `degradation.tier` distribution | How often each tier serves | Tier 2+ serving > 5% of traffic |
| `degradation.quality` p50/p99 | Average response quality | p50 quality drops below 0.8 |

### Combined Failure Modes

**Retry budget depleted, circuit still CLOSED.** Retries are exhausted but the circuit hasn't seen enough requests to trip. The system keeps trying tier 1, spending latency budget without triggering fast-fail. Watch `retry.budget_remaining` — if it stays near zero while circuit is CLOSED, the threshold for `minimumRequests` may be too high for your traffic volume.

**Circuit OPEN but degradation tier 2 also failing.** Both primary and fallback providers are degraded simultaneously. The degradation chain walks to cache or static. Watch `degradation.tier` distribution — if tier 3+ serves > 1% of traffic, both providers have a problem and you need cross-provider alerting.

**Slow provider recovery masked by caching.** Circuit resets and CLOSED, but the cache tier was serving during the outage. Traffic returns to tier 1 while cache still holds stale data. Some users get stale answers after recovery because their queries hit cache before the circuit opened, and TTL hasn't expired. Monitor `cache.age_p99` alongside `circuit.state` transitions.

**Silent quality erosion.** Tier 1 returns 200 OK but response quality is degraded — provider is up but returning low-quality outputs (e.g., shorter answers, higher hallucination rate). The circuit doesn't trip, retries don't fire, quality scores look fine in aggregate. Add an output quality check as a custom `isFailure` function in the circuit breaker configuration if quality is measurable.

### Runbook: Circuit OPEN

1. Check `circuit.failure_rate` trend — was this gradual or sudden?
2. Check provider status page for announced incidents.
3. Verify `degradation.tier` shows tier 2+ serving (degradation is actually active).
4. If provider is recovering: wait for `resetTimeoutMs`, watch for HALF_OPEN probe results.
5. If provider is not recovering: consider manually calling `primaryBreaker.forceOpen()` to prevent probe attempts from wasting budget.

---

## Tension Between Patterns

**Retry budget vs. circuit breaker window.** If `maxAttempts=3` and the circuit's `minimumRequests=10`, a failing provider may burn 30 requests (10 from the window, each with 3 retries) before the circuit trips. For low-traffic systems, lower `minimumRequests` or disable retries when the circuit is already approaching its threshold.

**Degradation chain timeout vs. retry delays.** If `globalTimeoutMs=5000` and retry backoff can reach `maxDelayMs=5000`, a single retry cycle can consume the entire degradation budget before tier 2 is ever attempted. Keep `maxDelayMs` well below `globalTimeoutMs / maxAttempts`.

**Circuit breaker per-provider vs. per-endpoint.** A single circuit breaker for the entire provider is coarser than one per endpoint. A broken `/v1/completions` endpoint won't trip a global breaker if `/v1/embeddings` is healthy. Consider separate breakers per endpoint if your provider has endpoint-level incidents.

---

## Related Recipes

- [Cost Control Stack](./cost-control-stack.md) — pairs with this when the degradation chain's tier 2 is a cheaper model
- [Agent Safety Stack](./agent-safety-stack.md) — agent loops need loop guards alongside this resilience stack

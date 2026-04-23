# Recipe: Cost Control Stack

> **Patterns combined:** [Token Budget Middleware](../../patterns/cost-control/token-budget-middleware/) + [Model Routing](../../patterns/cost-control/model-routing/) + [Semantic Caching](../../patterns/cost-control/semantic-caching/)

Three patterns that each cut LLM costs from a different angle: caching eliminates redundant calls entirely, routing sends cheaper models what they can handle, and budget enforcement prevents runaway spend. The combination compounds — a cached response costs nothing, a routed response costs 85% less than the frontier alternative, and budget enforcement caps the floor.

---

## When This Combination Makes Sense

The trigger is when your monthly LLM spend has become a line item that product or finance is asking about — or when you can see it trending that direction. Specific signals:

- Monthly spend exceeds $1,000 and no per-user or per-feature ceiling exists
- Query logs show repetitive or near-duplicate requests at scale (>5K req/day)
- Your workload mixes simple tasks (classification, extraction) with complex ones (reasoning, synthesis) but all hit the same model
- A surprise invoice or runaway agent loop has already happened once
- Multiple teams share an API key with no spend isolation

Each pattern addresses a different cost driver. Caching helps when queries repeat. Routing helps when tasks have variable complexity. Budget middleware helps regardless — it's the safety net under the other two.

---

## How the Three Patterns Compose

The patterns compose as a pre-call pipeline. A request enters, and the pipeline tries to avoid an API call entirely (cache), then optimizes the API call if it must happen (routing), then enforces that the cost of that call doesn't exceed limits (budget).

| Stage | Pattern | Cost Lever | When It Fires |
|---|---|---|---|
| 1 | Semantic Cache | Eliminate the call | Query is semantically similar to a cached query |
| 2 | Model Router | Route to cheaper model | Query is below complexity threshold |
| 3 | Token Budget | Cap per-request and daily spend | Every call that reaches the provider |

### Architecture

```
                    Incoming Request
                          │
          ┌───────────────▼───────────────┐
          │       Semantic Cache          │
          │  embed → vector search        │
          │  score ≥ threshold?           │
          └──────────┬────────────────────┘
                     │
           HIT ──────┤────── MISS
           │                │
           ▼                ▼
    Cached Response  ┌──────────────────────┐
    (cost: $0.00)    │   Complexity Router   │
                     │   score input [0–1]  │
                     └──────┬───────────────┘
                            │
              simple (< 0.4)│  complex (≥ 0.4)
                   │        │       │
                   ▼        │       ▼
            cheap model     │  frontier model
            (e.g. mini)     │  (e.g. GPT-4o)
                   │        │       │
                   └────────┤───────┘
                            │
               ┌────────────▼────────────┐
               │    Token Budget Check   │
               │  estimate input tokens  │
               │  check daily/req limit  │
               │  over budget? → reject  │
               └────────────┬────────────┘
                            │
                      ┌─────▼─────┐
                      │ Provider  │
                      └─────┬─────┘
                            │
               ┌────────────▼────────────┐
               │  Update Budget Tracker  │
               │  Store in Cache         │
               └─────────────────────────┘
```

---

## Wiring Code

### TypeScript

```typescript
import { SemanticCache } from '../patterns/cost-control/semantic-caching/src/ts/index.js';
import { ModelRouter } from '../patterns/cost-control/model-routing/src/ts/index.js';
import { TokenBudgetMiddleware } from '../patterns/cost-control/token-budget-middleware/src/ts/index.js';

// Semantic cache — similarity threshold of 0.92 balances hit rate vs. correctness.
// Tune down to 0.88 for higher recall (more hits), up to 0.95 for higher precision.
const cache = new SemanticCache({
  similarityThreshold: 0.92,
  ttlMs: 3_600_000,       // 1 hour — adjust based on how often your data changes
  maxEntries: 50_000,
  embed: async (text: string) => callEmbeddingModel(text),
});

// Model router — routes below 0.4 complexity to mini, above to frontier.
// Starting values; calibrate against your actual task mix after 1 week of logs.
const router = new ModelRouter({
  complexityThreshold: 0.4,
  cheapModel: 'gpt-4o-mini',
  expensiveModel: 'gpt-4o',
  onRoute: (event) => {
    recordMetric('model.routed', { model: event.selectedModel, score: event.score });
  },
});

// Token budget — per-request cap and shared daily budget across all callers.
const budget = new TokenBudgetMiddleware({
  maxTokensPerRequest: 4_096,
  dailyTokenBudget: 10_000_000,   // ~$5/day at GPT-4o-mini rates
  onBudgetExceeded: (event) => {
    recordMetric('budget.exceeded', { windowTokens: event.windowTokens });
    throw new Error(`Token budget exceeded: ${event.reason}`);
  },
});

// Composed pipeline — order matters: cache → route → budget → provider.
export async function completionWithCostControl(
  prompt: string,
  options: { userId?: string; taskType?: string } = {}
): Promise<{ content: string; cost: CostInfo }> {
  // 1. Check cache first — zero cost if hit.
  const cached = await cache.get(prompt);
  if (cached) {
    return { content: cached.content, cost: { model: 'cache', tokens: 0, usd: 0 } };
  }

  // 2. Route to the right model based on complexity.
  const { selectedModel, score } = router.route({ prompt, ...options });

  // 3. Enforce token budget — rejects if the projected call would exceed limits.
  const response = await budget.execute(
    { prompt, model: selectedModel },
    () => callProvider({ prompt, model: selectedModel })
  );

  // 4. Store result in cache for future identical/similar queries.
  await cache.set(prompt, response);

  const usd = estimateCost(response.tokensUsed, selectedModel);
  return {
    content: response.content,
    cost: { model: selectedModel, tokens: response.tokensUsed, usd },
  };
}
```

### Python

```python
from patterns.cost_control.semantic_caching.src.py import SemanticCache, SemanticCacheConfig
from patterns.cost_control.model_routing.src.py import ModelRouter, ModelRouterConfig
from patterns.cost_control.token_budget_middleware.src.py import TokenBudgetMiddleware, BudgetConfig

# Module-level instances so all callers share the same cache and budget state.
cache = SemanticCache(
    config=SemanticCacheConfig(
        similarity_threshold=0.92,
        ttl_ms=3_600_000,
        max_entries=50_000,
        embed=call_embedding_model,
    )
)

router = ModelRouter(
    config=ModelRouterConfig(
        complexity_threshold=0.4,
        cheap_model="gpt-4o-mini",
        expensive_model="gpt-4o",
        on_route=lambda e: record_metric("model.routed", model=e.selected_model),
    )
)

budget = TokenBudgetMiddleware(
    config=BudgetConfig(
        max_tokens_per_request=4_096,
        daily_token_budget=10_000_000,
        on_budget_exceeded=lambda e: (_ for _ in ()).throw(
            RuntimeError(f"Token budget exceeded: {e.reason}")
        ),
    )
)

async def completion_with_cost_control(
    prompt: str, user_id: str = "", task_type: str = ""
) -> dict:
    # 1. Cache check — returns immediately if hit, no API call.
    cached = await cache.get(prompt)
    if cached:
        return {"content": cached["content"], "cost": {"model": "cache", "usd": 0.0}}

    # 2. Route to cheapest capable model.
    route_result = router.route({"prompt": prompt, "task_type": task_type})
    selected_model = route_result.selected_model

    # 3. Budget check + provider call.
    response = await budget.execute(
        request={"prompt": prompt, "model": selected_model},
        fn=lambda: call_provider(prompt=prompt, model=selected_model),
    )

    # 4. Populate cache for future queries.
    await cache.set(prompt, response)

    usd = estimate_cost(response["tokens_used"], selected_model)
    return {
        "content": response["content"],
        "cost": {"model": selected_model, "tokens": response["tokens_used"], "usd": usd},
    }
```

---

## What to Watch

### Metrics to Track

| Metric | What It Signals | Alert If |
|---|---|---|
| `cache.hit_rate` | Duplicate query rate | Falls below 15% after week 1 (threshold may be too tight) |
| `cache.hit_rate` | Over-caching risk | Rises above 80% (threshold may be too loose — wrong answers cached) |
| `router.cheap_model_rate` | Routing effectiveness | Falls below 40% (complexity scorer may be miscalibrated) |
| `budget.daily_tokens` | Spend trajectory | Hits 70% of daily limit before 5pm |
| `budget.rejections` | Budget pressure | Any rejections during business hours |
| `cost.usd_per_request` p99 | Request cost distribution | p99 > 10× p50 (outlier requests blowing budget) |

### Combined Failure Modes

**Cache returns stale answers after data changes.** The cache TTL is set for query similarity, not data freshness. If the underlying knowledge base changes (product catalog update, policy change), cached responses may be factually wrong for hours until TTL expires. Track a separate `cache.invalidation_events` counter and wire it to your content update pipeline.

**Router mis-classifies complex tasks as simple.** A high-complexity legal interpretation prompt scores below the threshold and gets routed to the mini model. The response is subtly wrong but syntactically valid — no error thrown, just wrong content. Track quality scores per model segment (see [Output Quality Monitoring](../../patterns/observability/output-quality-monitoring/)) and watch for quality divergence between cheap and expensive model traffic.

**Budget exhausted silently during off-hours.** A batch job or runaway loop burns the daily budget overnight. Morning traffic hits budget rejections before anyone checks. Set budget alerts at 50% and 80% of daily limit, not just at 100%. Consider separate budget pools for interactive vs. batch traffic.

**Cache poisoning — wrong answer stored and served repeatedly.** A request with bad upstream data produces a wrong response, which gets cached. Future semantically similar queries get the wrong cached response. Cache hit rate looks healthy; no errors. Wire cache invalidation to quality monitoring — if a response receives negative feedback, evict it from the cache.

### Runbook: Unexpected Cost Spike

1. Check `router.cheap_model_rate` — did routing shift toward the expensive model? (Complexity scores may have drifted.)
2. Check `cache.hit_rate` — did it drop? (Cache may have been cleared or TTL may have expired on a high-volume query cluster.)
3. Check `budget.rejections` — if near zero, the spike happened before the budget was hit. Check for a new traffic source or an agent loop.
4. Pull `cost.usd_per_request` percentile breakdown — if p99 spiked but p50 is stable, it's an outlier request type, not general inflation.

---

## Tension Between Patterns

**Cache hit rate vs. answer freshness.** A high similarity threshold (0.92+) means fewer hits but more accurate matching. A lower threshold (0.85) means more hits but risks serving cached answers to queries that needed fresh data. This isn't a single right answer — it depends on how often your source data changes.

**Routing threshold calibration.** The complexity threshold needs calibration against your actual workload, not a default. Set it too high (routing everything to the frontier model) and you lose routing savings. Set it too low (routing complex tasks to cheap models) and quality degrades silently. I'd run both models on a 5% sample for the first week and compare quality scores before locking in the threshold.

**Budget windows and traffic patterns.** A daily budget window resets at midnight — which means a job that runs at 11pm can burn the entire next day's budget before morning traffic starts. Consider hourly sub-windows inside the daily budget, or time-of-day budget splits for interactive vs. batch traffic.

---

## Related Recipes

- [Resilience Stack](./resilience-stack.md) — the circuit breaker that trips when providers fail, often pairs with graceful degradation to a cached tier
- [RAG Quality Stack](./rag-quality-stack.md) — semantic caching in this stack complements the chunk quality work in RAG

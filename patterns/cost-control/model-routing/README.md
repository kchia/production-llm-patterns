# Model Routing

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

The pricing spread between frontier and lightweight LLMs is 60–300x. GPT-4o charges $2.50/$10.00 per million input/output tokens; GPT-4o-mini charges $0.15/$0.60. Claude Sonnet sits at $3.00/$15.00. Without routing, every request — whether it's a simple classification or a nuanced multi-step reasoning task — hits the same model at the same price.

In practice, 60–80% of production requests are routine: extracting structured fields, summarizing short text, classifying intent. Research from [RouteLLM](https://arxiv.org/abs/2406.18665) (published at ICLR 2025) demonstrates that routing these to a cheaper model achieves approximately 95% of GPT-4's quality while cutting costs by up to 85% on MT-Bench and MMLU benchmarks (see RouteLLM Table 2).

The cost compounds fast. Studies show 60–80% of that spend comes from just 20–30% of use cases — high-volume, low-complexity tasks that a cheaper model handles identically.

Without routing, the math is simple and bad: every request costs the same, regardless of whether it needs the expensive model.

## What I Would Not Do

It's tempting to hardcode model selection per endpoint. "Summarization always goes to GPT-4o-mini, reasoning always goes to GPT-4o." It's intuitive and works initially.

It breaks in three specific ways:

1. **Task complexity isn't static.** A summarization endpoint receives a 200-word email and a 15-page legal contract. The short email is fine on the small model; the contract needs the frontier model. Hardcoded routing can't distinguish them.

2. **Model capabilities shift.** When a cheaper model gets an update that improves its reasoning, hardcoded routes keep paying for the expensive one. When a frontier model degrades on a specific task category (it happens), hardcoded routing keeps sending traffic there. There's no feedback loop.

3. **The threshold is invisible.** Without routing metadata, there's no data about which requests _could_ have gone to a cheaper model. Teams can't quantify the savings opportunity because the system never tried. This means the case for routing infrastructure never gets made — the cost just stays high.

I'd also avoid building a complex ML-based router from day one. Training a classifier on preference data (like RouteLLM does) is powerful but requires substantial labeled data and ongoing maintenance. Starting with rule-based complexity estimation — token count, presence of structured output requirements, task type — gets 70–80% of the savings with 10% of the complexity.

## When You Need This

- Monthly LLM spend exceeds $1,000 and your workload includes a mix of simple and complex tasks
- Cost analysis shows >40% of requests are low-complexity (classification, extraction, simple summarization)
- You've validated that a cheaper model produces acceptable quality on your simpler tasks — even informally
- Your p99 latency is higher than needed because every request waits for a large model, when smaller models respond 2–5x faster
- You're running batch processing where speed isn't critical but volume makes cost savings compound

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

| System Type   | Designation | Reasoning                                                                                                                                                                                                                                                                                           |
| ------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agents**    | High ROI    | Agent systems make many calls per session — tool selection, parameter extraction, response synthesis. Most of those intermediate calls are simple. I'd want routing in place once agent costs become a line item, because the call volume multiplier makes even small per-call savings significant. |
| **Batch**     | High ROI    | Batch systems process thousands to millions of items. The sheer volume means even a 30% cost reduction per call translates to meaningful savings. I'd want routing here once I'm processing more than a few thousand items per run.                                                                 |
| **RAG**       | Recommended | RAG pipelines typically have a retrieval stage (cheap) and a generation stage (potentially expensive). Routing the generation call based on query complexity is worthwhile, but the savings are more modest since there's usually one LLM call per query.                                           |
| **Streaming** | Recommended | Streaming systems have strict latency requirements, and smaller models are faster. Routing simple queries to a smaller model isn't just about cost — it's about getting tokens to the user sooner. The savings are real but latency is the bigger driver here.                                      |

## The Pattern

### Architecture

```
 1. ┌─────────────────────────┐
    │    Incoming Request     │
    │  (prompt + metadata)    │
    └────────────┬────────────┘
                 │
 2. ┌────────────▼────────────┐
    │  Complexity Classifier  │
    │  (heuristics → 0–1)    │
    └────────────┬────────────┘
                 │
        score < 0.3?  score > 0.7?
         ┌───────┼───────┐
         │       │       │
 3.  ┌───▼───┐ ┌▼────┐ ┌▼──────┐
     │ Weak  │ │ Mid │ │Strong │
     │ Tier  │ │Tier │ │ Tier  │
     └───┬───┘ └──┬──┘ └───┬───┘
         │        │        │
     ┌───▼────┐┌──▼───┐┌──▼─────┐
     │GPT-4o- ││Claude││ GPT-4o │
     │ mini   ││Sonnet││        │
     └───┬────┘└──┬───┘└──┬─────┘
         │        │        │
         └────────┼────────┘
                  │
 4. ┌─────────────▼─────────────┐
    │ Log: model, tier, score,  │──► Metrics
    │ latency, tokens, cost     │
    └─────────────┬─────────────┘
                  │
 5. ┌─────────────▼─────────────┐
    │         Response          │
    └───────────────────────────┘
```

Note: the specific models shown are illustrative — the actual model pool and tier boundaries depend on your provider, pricing, and quality requirements.

**Core abstraction: `ModelRouter`**

The router exposes a single method that wraps your LLM call:

```typescript
interface ModelRouter {
  route(request: RouteRequest): Promise<RouteResponse>;
  getStats(): RouterStats;
}

interface RouteRequest {
  prompt: string;
  taskType?: string; // optional hint: "classification", "summarization", "reasoning"
  metadata?: Record<string, unknown>;
  qualityThreshold?: number; // 0-1, minimum acceptable quality score
}

interface RouteResponse {
  response: string;
  model: string; // which model actually handled the request
  tier: "strong" | "mid" | "weak";
  complexityScore: number; // 0-1, the router's estimate of request complexity
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}
```

**Complexity classifier**

The classifier scores each request on a 0–1 complexity scale using a set of heuristics:

1. **Token count** — longer prompts tend to need stronger models for coherent handling
2. **Task type hint** — if provided, maps directly to a tier (classification → weak, reasoning → strong)
3. **Structural signals** — presence of multi-step instructions, nested conditionals, or code in the prompt
4. **Keyword signals** — terms like "analyze", "compare", "evaluate" push the score up; "extract", "list", "classify" push it down

The complexity score maps to a tier via configurable thresholds.

**Configurability**

| Parameter          | Default           | Description                                                        |
| ------------------ | ----------------- | ------------------------------------------------------------------ |
| `weakThreshold`    | 0.3               | Complexity score below this routes to the weak (cheap) model       |
| `strongThreshold`  | 0.7               | Complexity score above this routes to the strong (expensive) model |
| `models.strong`    | `"gpt-4o"`        | Model ID for the strong tier                                       |
| `models.mid`       | `"claude-sonnet"` | Model ID for the mid tier                                          |
| `models.weak`      | `"gpt-4o-mini"`   | Model ID for the weak tier                                         |
| `fallbackModel`    | `"gpt-4o"`        | Model to use if routing classification fails                       |
| `enableLogging`    | `true`            | Log every route decision with complexity score and tier            |
| `qualityThreshold` | `0.8`             | Default minimum quality threshold (0–1)                            |

These defaults are starting points. The right thresholds depend on your workload's complexity distribution, your SLA requirements, and the actual quality gap between models in your specific use case. A workload that's 80% simple extraction tasks might push `weakThreshold` up to 0.5; a safety-critical system might set `strongThreshold` to 0.4 to route more aggressively to the expensive model.

**Key design tradeoffs**

1. **Rule-based vs. ML-based classification.** This implementation uses rule-based heuristics. An ML classifier (like [RouteLLM](https://github.com/lm-sys/RouteLLM)'s matrix factorization approach) would be more accurate but requires training data, ongoing model maintenance, and adds inference latency. Rule-based gets most of the savings with much less operational overhead. The router interface is designed so the classifier can be swapped later.

2. **Three tiers vs. two.** Two tiers (strong/weak) is simpler but leaves money on the table for medium-complexity tasks. Three tiers capture the pricing sweet spot where mid-tier models offer 90% of frontier quality at 30–50% of the cost. More than three tiers adds classification complexity without proportional savings.

3. **Complexity estimation at request time vs. response time.** Classifying before the call means the router never sees the response quality. Classifying after (cascading — try cheap first, escalate if quality is low) catches more misroutes but adds latency and doubles token cost on escalated requests. This design classifies upfront for simplicity; cascading is a valid alternative for systems where response quality is measurable in real-time.

4. **Per-request classification vs. per-task-type configuration.** Per-request classification handles within-task-type variance (the 200-word email vs. 15-page contract problem). Per-task-type configuration is simpler but loses that granularity. This design supports both: task type hints short-circuit the classifier when the mapping is known, while untyped requests get full classification.

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

| Failure Mode                                     | Detection Signal                                                                                                                                                                           | Mitigation                                                                                                                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Misroute to weak model (quality degradation)** | Quality scores drop on requests classified as "simple"; user complaints increase on specific task types; eval harness shows regression on routed-to-weak subset                            | Lower `weakThreshold` to route fewer requests to the cheap model; add task-type overrides for categories where quality dipped; review classifier heuristic weights                                                           |
| **Misroute to strong model (wasted spend)**      | Cost per request increases without quality improvement; strong-tier utilization rises while quality metrics stay flat; routing logs show high-complexity scores on simple requests         | Raise `weakThreshold`; audit classifier signals — check if token count heuristic is overweighting long but simple prompts; sample routing decisions weekly                                                                   |
| **Classifier latency adds to critical path**     | p50/p99 latency increases by >10ms after router deployment; latency distribution shows a new constant-time bump before model response time                                                 | Profile classifier independently; if heuristic-based, target <5ms classification time; consider async classification for non-latency-critical paths                                                                          |
| **Fallback model overload**                      | Fallback model usage spikes (>5% of requests); error rate increases on classification failures; logs show frequent classifier exceptions                                                   | Fix the classifier bug causing exceptions; add circuit breaker to fallback path; monitor fallback percentage as a health signal                                                                                              |
| **Model pool staleness (silent degradation)**    | Over weeks/months, the cost savings percentage gradually declines without config changes; the ratio of strong-to-weak routing drifts toward 50/50; newer cheaper models aren't in the pool | Review model pool quarterly; compare current model pricing and capabilities against pool configuration; add automated pricing checks that flag when a new model offers better price/quality than the current weak-tier model |
| **Threshold drift from workload shift**          | Task complexity distribution changes (e.g., product adds a new feature generating more complex queries); routing tier percentages shift >10% from baseline without config changes          | Monitor tier distribution weekly; set alerts on tier percentage drift; re-evaluate thresholds when workload composition changes significantly                                                                                |

## Observability & Operations

**Key metrics:**

| Metric                              | Description                                                                                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `router.tier_distribution`          | Percentage of requests routed to each tier (weak/mid/strong). This is the primary health signal. Track as a time-series gauge.                                                      |
| `router.classification_errors`      | Count of classifier failures per minute. Any non-zero value deserves investigation.                                                                                                 |
| `router.complexity_score_histogram` | Distribution of complexity scores. A bimodal distribution (clusters at 0.1 and 0.8) is healthy; a flat or unimodal distribution suggests the classifier isn't differentiating well. |
| `router.cost_per_request`           | Weighted average cost per request across tiers. Compare against the no-routing baseline to track actual savings.                                                                    |
| `router.fallback_rate`              | Percentage of requests hitting the fallback path.                                                                                                                                   |
| `quality.score_by_tier`             | If you have eval infrastructure, track quality scores segmented by routing tier. This catches misrouting.                                                                           |

**Alerting:**

| Severity | Condition                                                                       | Action                                                                                                   |
| -------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Warning  | Tier distribution drift >10% from baseline over 24 hours without config changes | Something shifted in the workload — investigate product changes or new prompt patterns                   |
| Warning  | `cost_per_request` exceeds 50% of no-routing baseline                           | Router isn't delivering value — could indicate classifier drift or model pool staleness                  |
| Critical | Fallback rate >5%                                                               | Classifier is failing too often — at 20%, routing savings are significantly eroded                       |
| Critical | Quality score regression on weak-tier requests                                  | Weak model is being asked to handle requests it can't — lower `weakThreshold` or add task-type overrides |
| Warning  | Weak tier percentage suspiciously high (>90%)                                   | Classifier might be broken in the other direction — routing everything cheap. Check quality.             |

These thresholds are starting points. Adjust based on your baseline tier distribution, SLA requirements, and how much quality variance is acceptable for your use case.

**Runbook:**

_Tier distribution drift alert fires:_

1. Check if a product change deployed recently (new features often change query complexity distribution)
2. Sample 20 recent routing decisions — are complexity scores reasonable for the prompts?
3. If scores look wrong: check classifier heuristic weights, look for new prompt patterns not covered by keywords
4. If scores look right: the workload genuinely shifted. Adjust thresholds to match new distribution.

_Fallback rate spike:_

1. Check classifier error logs — what exception is being thrown?
2. If it's a specific prompt pattern causing the crash: add handling for that pattern
3. If it's intermittent: check for resource pressure (memory, event loop blocking)
4. Temporary mitigation: set fallback tier to "mid" instead of "strong" to limit cost impact

_Quality regression on weak tier:_

1. Pull recent weak-tier requests and evaluate quality manually
2. Identify the request categories failing — are they genuinely simple tasks the model handles poorly, or misrouted complex tasks?
3. If misrouted: lower `weakThreshold` to reduce weak-tier volume
4. If the weak model degraded: check model versioning — did the provider push an update?

## Tuning & Evolution

**Tuning levers:**

| Lever                    | Safe Range                   | Dangerous Extreme                                                          | Effect                                                                    |
| ------------------------ | ---------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `weakThreshold`          | 0.2–0.5                      | >0.7 (routes medium tasks to cheap model)                                  | Higher = more traffic to weak tier = more savings but higher quality risk |
| `strongThreshold`        | 0.6–0.85                     | <0.4 (routes most tasks to expensive model, defeating routing)             | Lower = more traffic to strong tier = higher quality but less savings     |
| Model pool composition   | 2–3 tiers from 1–2 providers | Single tier (no routing benefit) or >4 tiers (classification too granular) | More tiers = finer cost optimization but harder to classify correctly     |
| Classifier keyword lists | 5–15 keywords per direction  | >30 keywords (overfitting to specific prompts)                             | More keywords = more precise classification but harder to maintain        |

**Drift signals:**

| Signal                                                                                   | Meaning                                                                    |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Tier distribution shifts >15% over a month without config changes                        | Workload evolution — task complexity mix has changed                       |
| Cost savings percentage declines quarter-over-quarter                                    | Model pricing changes or classification accuracy degrading                 |
| New task types appearing in logs that the classifier doesn't have keywords for           | Classifier coverage gap — new prompt patterns aren't being classified well |
| Provider releases a new model that's cheaper and better than the current weak-tier model | Model pool is stale — update to capture better price/quality ratio         |

**Silent degradation:**

- **Month 3:** The model pool is using model IDs from three months ago. A newer, cheaper model exists but isn't in the pool. Savings are 10–20% lower than they could be. No alert fires because the current savings percentage is still positive. Detection: quarterly model pool review comparing current pool against provider pricing pages.
- **Month 6:** The product has evolved. New features generate prompts with patterns the classifier doesn't recognize — they default to the mid tier when they could safely go to weak. The classifier's effective accuracy has dropped from 85% to 65%. The tier distribution looks normal because the defaults happen to spread evenly, but the routing decisions are less optimal. Detection: sample 50 routing decisions monthly and manually validate tier assignments against prompt content.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers, all three model baselines, and formulas.

| Scale        | Savings (GPT-4o baseline) | ROI vs. No Pattern                   |
| ------------ | ------------------------- | ------------------------------------ |
| 1K req/day   | -$2.05/day (-63%)         | Break-even immediate — no infra cost |
| 10K req/day  | -$20.50/day (-63%)        | $615/month saved                     |
| 100K req/day | -$205/day (-63%)          | $6,150/month saved                   |

## Testing

See test files in [`src/ts/__tests__/`](src/ts/__tests__/) for full test suite. Run with `cd src/ts && npm test`.

**Unit tests (14 tests):**

- HeuristicClassifier: task type hint routing, prompt-based signal scoring, score bounds
- ModelRouter: routing decisions by task type and prompt complexity, custom threshold configuration, custom model IDs, runtime config updates, stats tracking (total requests, tier counts, average complexity, recent decisions), tier distribution percentages, stats reset

**Failure mode tests (8 tests):**

- FM1 — Misroute to weak: verifies complex untyped prompts don't route to weak tier
- FM2 — Misroute to strong: verifies simple prompts don't route to strong tier
- FM3 — Classifier latency: 1,000 classifications complete in <50ms
- FM4 — Fallback overload: broken classifier falls back to strong tier, tracks error count; flaky classifier tracks intermittent failures
- FM5 — Model pool staleness (silent degradation): tier distribution exposed for monitoring drift
- FM6 — Threshold drift: detects tier distribution shift when workload complexity changes

**Integration tests (3 tests):**

- Mixed workload end-to-end: routes 4 requests of varying complexity, validates all responses and stats consistency
- Provider error handling: propagates provider errors without swallowing them
- Concurrent routing: 20 parallel requests maintain correct stats

## When This Advice Stops Applying

- **Uniform task complexity.** If every request in the system genuinely requires frontier-model capability — complex reasoning, nuanced generation, or safety-critical accuracy — routing adds overhead without savings. Some medical, legal, or financial applications fall here.
- **Volume too low to justify the infrastructure.** Below ~500 requests/day, the engineering time to build and maintain a router likely costs more than the model savings. The breakeven depends on per-request cost, but at low volume, the math rarely works.
- **Single-model pricing collapses the spread.** If the price gap between strong and weak models shrinks below ~3x (which happens as models commoditize), routing infrastructure overhead may exceed the savings. This is already happening for some open-source model pairs.
- **Quality tolerance is zero.** If any degradation on any request is unacceptable — even the occasional borderline case where the weak model underperforms — routing introduces unacceptable risk. The router's classification accuracy is never 100%.
- **Provider lock-in constrains the model pool.** If the organization can only use a single model family (compliance, data residency, or contractual reasons), and that family doesn't have a meaningful price/capability spread, routing has no lever to pull.

<!-- ## Companion Content

- Blog post: [Model Routing — Deep Dive](https://prompt-deploy.com/model-routing) (coming soon)
- Related patterns:
  - [Token Budget Middleware](../token-budget-middleware/) (#3, S1) — routing to cheaper models is a cost control lever, complementing budget enforcement
  - [Semantic Caching](../semantic-caching/) (#12, S4) — caching avoids calls entirely; routing makes calls cheaper
  - [Cost Dashboard](../cost-dashboard/) (#32, S9) — visualizes the cost impact of routing decisions
  - [Multi-Provider Failover](../../resilience/multi-provider-failover/) (#9, S3) — failover routes by availability; model routing routes by capability and cost
  - [Latency Budget](../../performance/latency-budget/) (#14, S4) — smaller models are faster; routing affects latency -->

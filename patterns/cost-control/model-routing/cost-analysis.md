# Cost Analysis: Model Routing

## Pricing (as of March 2026)

| Model | Input (per 1M tokens) | Output (per 1M tokens) |
|-------|----------------------|----------------------|
| GPT-4o | $2.50 | $10.00 |
| Claude Sonnet 4.6 | $3.00 | $15.00 |
| GPT-4o-mini | $0.15 | $0.60 |

## Assumptions

| Assumption | Value | Justification |
|-----------|-------|---------------|
| Average input tokens per request | 500 | Typical for classification/extraction/summarization prompts with some context |
| Average output tokens per request | 200 | Typical completion length for structured tasks |
| Workload distribution (without routing) | 100% strong model | Baseline: everything goes to one model |
| Workload distribution (with routing) | 60% weak, 25% mid, 15% strong | Based on typical production workloads where 60–80% of requests are routine |
| Router infrastructure cost | ~$0 | Heuristic classifier runs in-process, no additional API calls or services |
| Mid-tier model | Claude Sonnet 4.6 for GPT-4o scenario; GPT-4o for Claude scenario | Cross-provider mid-tier |

Note: The 60/25/15 split is conservative. RouteLLM research shows that for general benchmarks, only 14–26% of requests need the strong model. Workloads with higher routine-task fractions will see even greater savings.

## Formulas

```
Per-request cost = (input_tokens / 1M × input_price) + (output_tokens / 1M × output_price)

Without routing:
  Daily cost = requests/day × per_request_cost(strong_model)

With routing:
  Daily cost = requests/day × (
    weak_fraction × per_request_cost(weak_model) +
    mid_fraction × per_request_cost(mid_model) +
    strong_fraction × per_request_cost(strong_model)
  )

Savings = (without_routing - with_routing)
Savings % = savings / without_routing × 100
```

## GPT-4o Baseline (strong=GPT-4o, mid=Claude Sonnet, weak=GPT-4o-mini)

**Per-request costs:**

| Tier | Model | Input Cost | Output Cost | Total/Request |
|------|-------|-----------|------------|--------------|
| Strong | GPT-4o | $0.00125 | $0.00200 | $0.00325 |
| Mid | Claude Sonnet | $0.00150 | $0.00300 | $0.00450 |
| Weak | GPT-4o-mini | $0.0000075 | $0.000012 | $0.0000195 |

**Daily projections:**

| Scale | Without Routing | With Routing | Savings | Savings % |
|-------|----------------|-------------|---------|-----------|
| 1K req/day | $3.25/day | $1.20/day | $2.05/day | 63.1% |
| 10K req/day | $32.50/day | $12.00/day | $20.50/day | 63.1% |
| 100K req/day | $325.00/day | $119.99/day | $205.01/day | 63.1% |

**Monthly projections:**

| Scale | Without Routing | With Routing | Monthly Savings |
|-------|----------------|-------------|----------------|
| 1K req/day | $97.50/mo | $36.00/mo | $61.50/mo |
| 10K req/day | $975.00/mo | $360.00/mo | $615.00/mo |
| 100K req/day | $9,750.00/mo | $3,599.70/mo | $6,150.30/mo |

## Claude Sonnet Baseline (strong=Claude Sonnet, mid=GPT-4o, weak=GPT-4o-mini)

**Per-request costs:**

| Tier | Model | Input Cost | Output Cost | Total/Request |
|------|-------|-----------|------------|--------------|
| Strong | Claude Sonnet | $0.00150 | $0.00300 | $0.00450 |
| Mid | GPT-4o | $0.00125 | $0.00200 | $0.00325 |
| Weak | GPT-4o-mini | $0.0000075 | $0.000012 | $0.0000195 |

**Daily projections:**

| Scale | Without Routing | With Routing | Savings | Savings % |
|-------|----------------|-------------|---------|-----------|
| 1K req/day | $4.50/day | $1.33/day | $3.17/day | 70.4% |
| 10K req/day | $45.00/day | $13.25/day | $31.75/day | 70.6% |
| 100K req/day | $450.00/day | $132.46/day | $317.54/day | 70.6% |

**Monthly projections:**

| Scale | Without Routing | With Routing | Monthly Savings |
|-------|----------------|-------------|----------------|
| 1K req/day | $135.00/mo | $39.90/mo | $95.10/mo |
| 10K req/day | $1,350.00/mo | $397.50/mo | $952.50/mo |
| 100K req/day | $13,500.00/mo | $3,973.80/mo | $9,526.20/mo |

## GPT-4o-mini Baseline (strong=GPT-4o-mini — no routing possible)

If the baseline model is already GPT-4o-mini, routing has no cheaper tier to route to. The pattern doesn't apply — there's no price spread to exploit.

Per-request cost: $0.0000195. At 100K req/day: $1.95/day ($58.50/mo).

## How to Calculate for Your Own Usage

1. **Determine your per-request costs:**
   - Input cost = (your avg input tokens / 1,000,000) × model input price
   - Output cost = (your avg output tokens / 1,000,000) × model output price

2. **Estimate your workload distribution:**
   - Run a sample of 100–500 requests through the classifier (or manually label)
   - Count: what % are simple? Medium? Complex?
   - If you don't know yet, start with 60/25/15 and adjust after a week of production data

3. **Calculate:**
   ```
   without = requests_per_day × strong_per_request_cost
   with = requests_per_day × (
     simple_pct × weak_per_request_cost +
     medium_pct × mid_per_request_cost +
     complex_pct × strong_per_request_cost
   )
   savings = without - with
   ```

4. **Adjust for your quality requirements:**
   - If quality tolerance is tight, shift more to mid/strong (e.g., 40/35/25)
   - If quality tolerance is loose, shift more to weak (e.g., 75/15/10)

## Key Insights

- **The savings come from the weak tier.** GPT-4o-mini is 16x cheaper per input token and 17x cheaper per output token than GPT-4o. The mid tier (Claude Sonnet) is actually *more expensive* per output token than GPT-4o — it's there for capability, not cost savings.
- **Break-even is almost immediate.** Since the router runs in-process with heuristic classification (no additional API calls), the only cost is engineering time to set up. Even at 1K req/day with GPT-4o, routing saves ~$60/month.
- **Claude Sonnet baseline saves more from routing** (70% vs 63%) because it starts at a higher per-request cost, so the spread to GPT-4o-mini is even larger.
- **At 100K req/day, routing saves $6,000–$9,500/month** depending on the baseline model. That's $72K–$114K/year.
- **The aggressive threshold config from benchmarks (85% weak)** would push savings even higher — up to ~80% cost reduction — but at the risk of quality degradation on the 25% of medium-complexity requests rerouted to the weak tier.

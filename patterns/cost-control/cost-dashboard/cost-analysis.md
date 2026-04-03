# Cost Analysis: Cost Dashboard

The dashboard pattern itself doesn't add tokens or extra API calls — it's a recording and aggregation layer. Its cost is the infrastructure overhead of storing and querying cost events (database writes, storage, compute for rollups), not additional LLM spend.

## Assumptions

| Parameter | Value | Justification |
|---|---|---|
| Average input tokens/request | 500 | Typical short-to-medium prompt with system context |
| Average output tokens/request | 150 | Moderate completion length |
| Cost event size (stored) | ~400 bytes (JSON) | requestId + feature + model + tokens + cost + tags |
| Rollup interval | 60 minutes | Default config; one row per feature per hour |
| Storage engine | Time-series DB (self-hosted) or equivalent | ClickHouse, TimescaleDB, or a hosted metrics platform |
| Storage cost | $0.02/GB-month | Approximate for self-hosted or cloud object storage |
| Query compute cost | $0.005/query | Low-end cloud DB, ~10 queries/day |

## Infrastructure Cost by Scale

The dashboard's cost is proportional to event volume, not LLM spend.

### Storage cost (raw events + rollups)

```
Raw event size     = 400 bytes/event
Daily raw storage  = requests/day × 400 bytes
Rollup storage     = (hours/day × dimensions × models) × 200 bytes
                   ≈ 24 × 10 × 5 × 200 = ~240 KB/day (negligible)

Monthly storage cost = (daily raw storage × 30 days × retentionDays/30)
                       × $0.02/GB
```

### Compute cost (rollup jobs + query API)

```
Rollup compute ≈ $0.01–$0.05/day (background job, low CPU)
Query compute   ≈ $0.005 × 10 queries/day = $0.05/day
Total compute   ≈ $0.06–$0.10/day (all scales)
```

## Cost Projections

| Scale | Daily Events | Daily Storage | Monthly Storage | Monthly Compute | Total Monthly | vs. Baseline LLM Cost |
|---|---|---|---|---|---|---|
| 1K req/day | 1,000 | 0.4 MB | 12 MB | ~$3.00 | ~$3.20 | GPT-4o: adds ~1% overhead |
| 10K req/day | 10,000 | 4 MB | 120 MB | ~$3.00 | ~$3.24 | GPT-4o: adds ~0.08% overhead |
| 100K req/day | 100,000 | 40 MB | 1.2 GB | ~$3.00 | ~$3.24 | GPT-4o: adds ~0.007% overhead |

> Storage estimate uses 90-day retention at $0.02/GB-month. Compute is relatively fixed because rollup and query work is independent of request volume once rollups are pre-aggregated.

## LLM Cost Context (What the Dashboard Is Tracking)

For comparison: what the dashboard is tracking (baseline LLM costs before any optimization).

| Model | Input price | Output price | Cost at 1K req/day | Cost at 10K req/day | Cost at 100K req/day |
|---|---|---|---|---|---|
| GPT-4o | $2.50/1M | $10.00/1M | $3.25/day | $32.50/day | $325/day |
| Claude Sonnet 4.6 | $3.00/1M | $15.00/1M | $3.75/day | $37.50/day | $375/day |
| GPT-4o-mini | $0.15/1M | $0.60/1M | $0.17/day | $1.65/day | $16.50/day |

Assumptions: 500 input + 150 output tokens per request.

## Dashboard Infrastructure Cost vs. LLM Spend

```
Infrastructure_monthly = $3.20 (mostly fixed)
LLM_monthly_gpt4o      = $97.50 at 1K/day, $975 at 10K/day, $9,750 at 100K/day

Infrastructure as % of LLM spend:
  1K req/day:   $3.20 / $97.50   = 3.3%
  10K req/day:  $3.20 / $975     = 0.33%
  100K req/day: $3.20 / $9,750   = 0.033%
```

The infrastructure cost dominates at 1K req/day — the dashboard is the same monthly cost as your LLM spend. This is the threshold below which the pattern is premature (use the provider dashboard + a monthly manual check instead).

## Optimization Savings the Dashboard Enables

A cost dashboard's value comes from enabling optimization decisions. From production data:

| Optimization | Expected Savings | Dashboard Contribution |
|---|---|---|
| Model routing (GPT-4o → GPT-4o-mini for simple queries) | 50–80% on routed queries | Dashboard shows per-feature cost-effectiveness enabling routing decisions |
| Semantic caching | 40–70% on cached queries | Dashboard shows cache hit rate and cost-per-cache-miss |
| Prompt compression (removing 200 avg input tokens) | 40% on input costs | Dashboard shows per-prompt-version cost comparison |

At 10K req/day on GPT-4o ($975/month), routing 50% of queries to GPT-4o-mini saves ~$350–$450/month. The $3.20/month dashboard infrastructure cost pays back in under 3 days.

## Formulas (Plug In Your Own Numbers)

```
Monthly LLM cost = (requests/day × 30)
                   × (avg_input_tokens × input_price_per_token
                      + avg_output_tokens × output_price_per_token)

Dashboard monthly cost = (requests/day × 400 bytes × 30 × retention_days/30 × $0.02/GB)
                         + $3.00 (compute, mostly fixed)

Dashboard cost as % of LLM spend = Dashboard_monthly / LLM_monthly × 100

Break-even (dashboard pays for itself via model routing):
  routing_savings = LLM_monthly × routed_fraction × (1 - cheap_model_cost / expensive_model_cost)
  payback_days    = Dashboard_monthly / (routing_savings / 30)
```

## Key Insights

1. **Infrastructure cost is nearly fixed** (~$3/month) regardless of scale from 1K to 100K req/day. Storage is the only variable component, but it's small at $0.02/GB.

2. **The pattern is premature below ~$100/month LLM spend** (roughly 1K req/day on GPT-4o). At that scale, the dashboard costs as much as the LLM spend itself.

3. **ROI accelerates with scale** — at 100K req/day on GPT-4o ($9,750/month), the dashboard costs 0.033% of LLM spend and enables optimization decisions that can reduce that bill by 40–80%.

4. **The dashboard's value is informational, not operational** — it doesn't reduce costs directly, but makes optimization decisions (model routing, caching, prompt compression) data-driven rather than guesswork.

5. **Model price volatility matters** — prices dropped ~300x from 2023 to 2026. A dashboard that uses stale prices makes wrong optimization decisions. Automate price refreshes.

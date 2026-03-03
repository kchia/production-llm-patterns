# Cost Analysis: Structured Tracing

## Key Insight

Structured tracing doesn't add extra LLM calls or tokens — it's a wrapper around existing calls that captures metadata. The direct LLM cost impact is zero. The costs this pattern introduces are infrastructure costs: trace storage, export bandwidth, and backend query costs. The ROI comes from faster debugging (less engineer time) and from enabling downstream patterns (quality monitoring, drift detection) that can reduce wasted LLM spend.

## Assumptions

| Assumption | Value | Justification |
|---|---|---|
| Average input tokens/request | 500 | Typical for RAG prompt with 2-3 retrieved documents |
| Average output tokens/request | 200 | Standard completion length |
| Average spans per trace | 4 | Root + retrieval + generation + validation |
| Average trace size (with content capture off) | 5 KB | Span metadata, attributes, timing — no prompt/completion text |
| Average trace size (with content capture on) | 25 KB | Includes prompt and completion text (~50x a traditional trace) |
| Sampling rate | 1.0 | Full capture; adjust with sampling_rate for cost reduction |
| Backend storage cost | $0.023/GB/month | S3-equivalent cold storage |
| Backend query cost | Varies | Depends on backend (self-hosted Jaeger ≈ free, Datadog ≈ $1.70/M spans) |

## LLM Cost Impact: Zero Additional LLM Spend

Structured tracing adds no extra API calls or tokens. The LLM cost is identical with or without tracing.

### Base LLM Cost (for context)

```
Base daily cost = requests/day × (input_tokens × input_price + output_tokens × output_price)
```

| Scale | GPT-4o | Claude Sonnet | GPT-4o-mini |
|---|---|---|---|
| 1K req/day | $3.75/day | $4.50/day | $0.20/day |
| 10K req/day | $37.50/day | $45.00/day | $1.95/day |
| 100K req/day | $375.00/day | $450.00/day | $19.50/day |

*GPT-4o: (500 × $2.50/1M) + (200 × $10.00/1M) = $0.00325 + $0.002 = $0.00375/req*
*Claude Sonnet: (500 × $3.00/1M) + (200 × $15.00/1M) = $0.0015 + $0.003 = $0.0045/req*
*GPT-4o-mini: (500 × $0.15/1M) + (200 × $0.60/1M) = $0.000075 + $0.00012 = $0.000195/req*

## Infrastructure Costs Introduced by Tracing

### Trace Storage

```
Daily storage = requests/day × trace_size × sampling_rate
Monthly storage = daily_storage × 30
Monthly cost = monthly_storage × storage_price_per_GB
```

**Content capture off (5 KB/trace):**

| Scale | Daily Storage | Monthly Storage | Monthly Storage Cost |
|---|---|---|---|
| 1K req/day | 5 MB | 150 MB | $0.003 |
| 10K req/day | 50 MB | 1.5 GB | $0.035 |
| 100K req/day | 500 MB | 15 GB | $0.345 |

**Content capture on (25 KB/trace):**

| Scale | Daily Storage | Monthly Storage | Monthly Storage Cost |
|---|---|---|---|
| 1K req/day | 25 MB | 750 MB | $0.017 |
| 10K req/day | 250 MB | 7.5 GB | $0.173 |
| 100K req/day | 2.5 GB | 75 GB | $1.725 |

### Backend Costs (self-hosted vs. SaaS)

| Backend | 1K req/day | 10K req/day | 100K req/day |
|---|---|---|---|
| Self-hosted (Jaeger + S3) | ~$5/month (storage only) | ~$20/month | ~$50-100/month |
| Langfuse Cloud (free tier → paid) | Free | ~$59-149/month | ~$399+/month |
| Datadog LLM Observability | ~$50/month (baseline) | ~$200/month | ~$1,000+/month |

*SaaS costs vary significantly by provider and plan. Self-hosted is cheapest but requires operational investment.*

### Compute Overhead

From benchmarks: tracing adds ~0.014ms per call at p50. At 100K req/day, this totals:

```
100,000 × 0.014ms = 1,400ms = 1.4 seconds total per day
```

This is negligible and does not require additional compute resources.

## Total Pattern Cost (self-hosted, content capture off)

```
Pattern cost = storage_cost + backend_infra_cost + zero_additional_LLM_cost
```

| Scale | Monthly Infrastructure Cost | As % of LLM Spend (GPT-4o) |
|---|---|---|
| 1K req/day | ~$5/month | 4.4% |
| 10K req/day | ~$20/month | 1.8% |
| 100K req/day | ~$75/month | 0.7% |

## ROI: Debugging Time Savings

The primary ROI is engineer time, not LLM cost savings.

**Without tracing:** Debugging a single bad output takes 20-60 minutes (manually correlating logs, grepping, reproducing).

**With tracing:** Debugging takes 2-10 minutes (open trace, inspect span tree, identify failing stage).

```
Time saved per incident: ~30 minutes
Engineer cost: ~$75/hour → ~$37.50 per incident
```

| Scale | Estimated Incidents/Month | Monthly Time Saved | Monthly Engineer Cost Saved |
|---|---|---|---|
| 1K req/day | 5-10 | 2.5-5 hours | $187-375 |
| 10K req/day | 20-40 | 10-20 hours | $750-1,500 |
| 100K req/day | 50-100 | 25-50 hours | $1,875-3,750 |

## Cost Summary (GPT-4o)

| Scale | Additional Cost | ROI vs. No Pattern |
|---|---|---|
| 1K req/day | +$5/month infra | Pays for itself with 1-2 debugging incidents/month |
| 10K req/day | +$20/month infra | 37-75x ROI from debugging time savings alone |
| 100K req/day | +$75/month infra | 25-50x ROI; enables downstream patterns that reduce wasted LLM spend |

## Formulas: How to Calculate for Your Own Usage

### Step 1: Estimate trace volume
```
monthly_traces = requests_per_day × 30 × sampling_rate
```

### Step 2: Estimate storage
```
monthly_storage_GB = monthly_traces × trace_size_KB / 1_000_000
monthly_storage_cost = monthly_storage_GB × $0.023 (or your storage price)
```

### Step 3: Estimate backend cost
- Self-hosted: storage + ~$5-20/month for a small Jaeger/ClickHouse instance
- SaaS: check your provider's per-span or per-event pricing × monthly_traces

### Step 4: Estimate debugging ROI
```
monthly_incidents = requests_per_day × incident_rate (typical: 0.5-1% of days have incidents)
time_saved_per_incident = 30 minutes (conservative)
monthly_savings = monthly_incidents × time_saved_per_incident × hourly_rate / 60
```

### Step 5: Net cost
```
net_monthly_cost = backend_cost + storage_cost - debugging_savings
```

## Key Insights

- **Scale doesn't change the calculus much.** Infrastructure cost scales linearly with volume but stays under 5% of LLM spend at all scales. The debugging time savings scale faster than the costs.
- **Content capture is the biggest cost lever.** Storing prompts and completions (25 KB/trace vs. 5 KB/trace) multiplies storage by 5x. Start with content capture off and enable it selectively for debugging sessions.
- **Sampling is effective at scale.** At 100K req/day, sampling at 10% reduces storage from 15 GB to 1.5 GB/month while keeping enough traces for statistical analysis.
- **The hidden ROI is enabling downstream patterns.** Structured traces are the foundation for Output Quality Monitoring, Drift Detection, and Online Eval Monitoring. Those patterns can identify and fix quality regressions that waste LLM spend on bad outputs — the indirect savings can dwarf the direct infrastructure cost.

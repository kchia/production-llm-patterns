# Cost Analysis: Circuit Breaker

## How the Circuit Breaker Affects Costs

The circuit breaker doesn't add extra LLM calls — it prevents unnecessary ones. The cost impact comes from two opposing forces:

1. **Savings during outages:** When the circuit opens, requests fail immediately instead of burning tokens on calls that would timeout or return 5xx errors. This eliminates wasted spend during provider degradation.
2. **No cost when healthy:** When the circuit is closed and the provider is healthy, the circuit breaker adds zero token cost. It's pure computation overhead (measured at ~1.6µs per request in benchmarks).

The key variable is **how often your provider degrades** and **how long outages last**. A provider that's down 1% of the time saves you 1% of would-be-wasted spend. A provider that flaps every hour saves significantly more.

## Assumptions

| Parameter | Value | Justification |
|-----------|-------|---------------|
| Average input tokens/request | 500 | Typical prompt with system context for an LLM API call |
| Average output tokens/request | 200 | Typical completion response |
| Provider degradation frequency | 1% of requests | Conservative — based on typical cloud provider SLAs (99-99.9% uptime). Real-world degradation during OpenAI's Dec 2024 outages exceeded 90% error rates for hours. |
| Average outage retry multiplier | 3x | Without circuit breaker, each failed request is retried ~3 times before giving up |
| Circuit breaker detection time | 10 seconds | Time for the circuit to trip after degradation starts (at >1K req/day with default thresholds) |
| Wasted tokens per failed request | 500 input | Requests that timeout or 5xx still consume input tokens on the provider side |

## Pricing Reference

| Model | Input | Output |
|-------|-------|--------|
| GPT-4o | $2.50 / 1M tokens | $10.00 / 1M tokens |
| Claude Sonnet | $3.00 / 1M tokens | $15.00 / 1M tokens |
| GPT-4o-mini | $0.15 / 1M tokens | $0.60 / 1M tokens |

## Formula

```
Base daily cost = requests/day × (avg_input_tokens × input_price + avg_output_tokens × output_price)

Wasted cost during outage (without CB) =
  degradation_rate × requests/day × retry_multiplier × (avg_input_tokens × input_price)

Wasted cost during outage (with CB) =
  degradation_rate × detection_requests × (avg_input_tokens × input_price)
  where detection_requests = requests arriving in the detection window before circuit trips

Savings = Wasted_without_CB - Wasted_with_CB

Pattern infrastructure cost = $0 (no external services, in-memory state only)
```

## Cost Projections: GPT-4o

| Scale | Base Daily Cost | Wasted Without CB | Wasted With CB | Daily Savings | Monthly Savings |
|-------|----------------|-------------------|----------------|---------------|-----------------|
| 1K req/day | $3.25/day | $0.04/day | $0.00/day | **+$0.04/day** | **+$1.13/mo** |
| 10K req/day | $32.50/day | $0.38/day | $0.01/day | **+$0.36/day** | **+$11.03/mo** |
| 100K req/day | $325.00/day | $3.75/day | $0.07/day | **+$3.68/day** | **+$110.25/mo** |

**Calculation for 10K req/day (GPT-4o):**
- Base: 10,000 × (500 × $0.0000025 + 200 × $0.000010) = 10,000 × $0.00325 = $32.50/day
- Without CB: 1% × 10,000 × 3 × (500 × $0.0000025) = 300 × $0.00125 = $0.375/day
- With CB: 1% × ~7 detection requests × (500 × $0.0000025) = 7 × $0.00125 = $0.009/day
- Savings: $0.375 - $0.009 = $0.366/day

## Cost Projections: Claude Sonnet

| Scale | Base Daily Cost | Wasted Without CB | Wasted With CB | Daily Savings | Monthly Savings |
|-------|----------------|-------------------|----------------|---------------|-----------------|
| 1K req/day | $4.50/day | $0.05/day | $0.00/day | **+$0.04/day** | **+$1.35/mo** |
| 10K req/day | $45.00/day | $0.45/day | $0.01/day | **+$0.44/day** | **+$13.19/mo** |
| 100K req/day | $450.00/day | $4.50/day | $0.08/day | **+$4.42/day** | **+$132.45/mo** |

## Cost Projections: GPT-4o-mini

| Scale | Base Daily Cost | Wasted Without CB | Wasted With CB | Daily Savings | Monthly Savings |
|-------|----------------|-------------------|----------------|---------------|-----------------|
| 1K req/day | $0.20/day | $0.00/day | $0.00/day | **+$0.00/day** | **+$0.07/mo** |
| 10K req/day | $1.95/day | $0.02/day | $0.00/day | **+$0.02/day** | **+$0.66/mo** |
| 100K req/day | $19.50/day | $0.23/day | $0.00/day | **+$0.22/day** | **+$6.62/mo** |

## Key Insights

**The circuit breaker's cost savings are proportional to outage frequency and scale.** At 1% degradation, the savings are modest — a few dollars per month for GPT-4o at 10K req/day. But real outages aren't 1% — the OpenAI Dec 2024 incidents hit >90% error rates for hours.

**During a real outage, the math changes dramatically.** Consider a 2-hour outage at 100K req/day (GPT-4o):
- Without CB: ~8,333 requests × 3 retries × $0.00125 = **$31.25 wasted** in 2 hours
- With CB: ~7 detection requests × $0.00125 = **$0.01 wasted** in 2 hours
- That's a 3,125x reduction in wasted spend during a single incident.

**The real ROI isn't in the daily savings — it's in the tail events.** A single multi-hour outage without circuit breaking can waste more than months of normal-operation savings. The circuit breaker is insurance against the expensive failure, not an optimizer for the common case.

**GPT-4o-mini shows why the pattern matters less at lower price points.** At $0.15/1M input tokens, even aggressive retry storms during outages waste pennies. The cost argument for circuit breaking is strongest with expensive models (GPT-4o, Claude Sonnet) at high scale (>10K req/day).

**Infrastructure cost is zero.** The circuit breaker runs in-process with in-memory state. No Redis, no external services, no additional infrastructure to maintain or pay for. The only "cost" is the ~1.6µs latency overhead per request, which is immeasurable against LLM API latency.

## How to Calculate for Your Own Usage

1. **Estimate your base daily cost:**
   ```
   requests/day × (your_avg_input_tokens × model_input_price + your_avg_output_tokens × model_output_price)
   ```

2. **Estimate your provider degradation rate:**
   - Check your provider's status page for historical uptime
   - 99.9% uptime = 0.1% degradation = ~1.4 minutes/day
   - 99% uptime = 1% degradation = ~14.4 minutes/day

3. **Calculate wasted spend without circuit breaker:**
   ```
   degradation_rate × requests/day × your_retry_count × (avg_input_tokens × input_price)
   ```

4. **Calculate wasted spend with circuit breaker:**
   ```
   degradation_rate × requests_in_detection_window × (avg_input_tokens × input_price)
   ```
   Detection window: typically 5-15 requests at your normal traffic rate.

5. **Calculate savings:** Subtract step 4 from step 3. This is your conservative daily savings. Multiply by 30 for monthly.

6. **Factor in tail events:** Multiply your hourly request rate by outage duration, then by retry count and input token cost. This is what a single outage costs you without a circuit breaker. Even one incident per quarter can exceed the annual steady-state savings.

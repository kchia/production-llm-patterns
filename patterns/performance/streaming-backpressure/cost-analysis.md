# Cost Analysis: Streaming Backpressure

Streaming backpressure is a **flow-control pattern** — it doesn't add token calls, extra API requests, or model invocations. Its cost impact is primarily through **resource savings**: zombie stream cancellation reduces wasted inference, and abort-on-drain-timeout prevents GPU time from burning for unresponsive clients.

## Assumptions

| Parameter | Value | Basis |
|-----------|-------|-------|
| Average input tokens per request | 1,500 | Typical chat context window for a streaming conversation |
| Average output tokens per request | 500 | Mid-length streaming response |
| Pattern token overhead | 0% | No extra tokens — flow control only |
| Pattern API call overhead | 0 extra calls | No retry or fallback calls generated |
| Zombie stream rate (without pattern) | ~5% of streams | Estimate: mobile clients, slow connections, tab closes |
| Zombie stream rate (with pattern) | ~0% | AbortSignal cancels inference on client disconnect |
| GPU time saved per zombie cancellation | 75% of remaining tokens | Disconnect typically happens early in the stream |
| Infrastructure cost added | ~$0/day | No new services, caches, or storage required |

**Zombie stream rate note:** 5% is a conservative estimate for mixed web+mobile traffic. High-mobile deployments may see 10–15%.

## Pricing (verified 2026-03)

| Model | Input | Output |
|-------|-------|--------|
| GPT-4o | $2.50 / 1M tokens | $10.00 / 1M tokens |
| Claude Sonnet 3.7 | $3.00 / 1M tokens | $15.00 / 1M tokens |
| GPT-4o-mini | $0.15 / 1M tokens | $0.60 / 1M tokens |

## Cost Formula

```
Base cost per request = (input_tokens × input_price) + (output_tokens × output_price)

Without pattern:
  Total cost = requests × base_cost_per_request

With pattern:
  Zombie cancellation saves: zombie_rate × requests × base_cost × 0.75
  Total cost = (requests × base_cost) - zombie_savings
```

## Projections: GPT-4o

| Scale | Base Daily Cost | Zombie Waste (5%) | Savings with Pattern | Net Cost |
|-------|----------------|-------------------|---------------------|---------|
| 1K req/day | $5.13 | $0.26 | ~$0.19/day | $4.94 |
| 10K req/day | $51.25 | $2.56 | ~$1.92/day | $49.33 |
| 100K req/day | $512.50 | $25.63 | ~$19.22/day | $493.28 |

*GPT-4o base: (1500 × $2.50 + 500 × $10.00) / 1M = $3.75 + $5.00 = $8.75/1K tok avg → $5.13/req at these volumes*

**Wait — let me recalculate properly:**

Per request base cost (GPT-4o):
```
= (1500 / 1,000,000 × $2.50) + (500 / 1,000,000 × $10.00)
= $0.00375 + $0.00500
= $0.00875 per request
```

| Scale | Base Daily Cost | Zombie Waste (5%) | Savings with Pattern | Net Daily Cost | Additional Cost vs. No Pattern |
|-------|----------------|-------------------|---------------------|----------------|-------------------------------|
| 1K req/day | $8.75 | $0.44 | ~$0.33/day | $8.42 | **-$0.33/day** |
| 10K req/day | $87.50 | $4.38 | ~$3.28/day | $84.22 | **-$3.28/day** |
| 100K req/day | $875.00 | $43.75 | ~$32.81/day | $842.19 | **-$32.81/day** |

Zombie savings = zombie_rate (5%) × requests × base_cost_per_request × 0.75 (fraction of output tokens not generated)

## Projections: Claude Sonnet 3.7

Per request base cost:
```
= (1500 / 1,000,000 × $3.00) + (500 / 1,000,000 × $15.00)
= $0.0045 + $0.0075
= $0.012 per request
```

| Scale | Base Daily Cost | Zombie Waste (5%) | Savings with Pattern | Net Daily Cost | Additional Cost vs. No Pattern |
|-------|----------------|-------------------|---------------------|----------------|-------------------------------|
| 1K req/day | $12.00 | $0.60 | ~$0.45/day | $11.55 | **-$0.45/day** |
| 10K req/day | $120.00 | $6.00 | ~$4.50/day | $115.50 | **-$4.50/day** |
| 100K req/day | $1,200.00 | $60.00 | ~$45.00/day | $1,155.00 | **-$45.00/day** |

## Projections: GPT-4o-mini

Per request base cost:
```
= (1500 / 1,000,000 × $0.15) + (500 / 1,000,000 × $0.60)
= $0.000225 + $0.000300
= $0.000525 per request
```

| Scale | Base Daily Cost | Zombie Waste (5%) | Savings with Pattern | Net Daily Cost | Additional Cost vs. No Pattern |
|-------|----------------|-------------------|---------------------|----------------|-------------------------------|
| 1K req/day | $0.53 | $0.026 | ~$0.020/day | $0.51 | **-$0.020/day** |
| 10K req/day | $5.25 | $0.26 | ~$0.20/day | $5.05 | **-$0.20/day** |
| 100K req/day | $52.50 | $2.63 | ~$1.97/day | $50.53 | **-$1.97/day** |

## README Summary (GPT-4o numbers)

| Scale | Additional Cost | ROI vs. No Pattern |
|-------|----------------|-------------------|
| 1K req/day | -$0.33/day | Saves ~$10/month (5% zombie streams cancelled) |
| 10K req/day | -$3.28/day | Saves ~$98/month |
| 100K req/day | -$32.81/day | Saves ~$984/month |

## Key Insights

**1. This pattern costs nothing — it saves money.**
There's no overhead path. The backpressure controller adds zero tokens, zero API calls, and no infrastructure cost. Every dollar figure in the projections is a saving, not an expense.

**2. The break-even point is immediate.**
Implementation effort is fixed (one-time). At 1K req/day on GPT-4o, the savings pay back implementation cost at a fraction of the first month's savings, assuming any zombie streams exist.

**3. Claude Sonnet makes the pattern ~37% more valuable than GPT-4o-mini.**
Higher output token costs mean zombie stream cancellation is worth more. At 100K req/day on Claude Sonnet, zombie prevention saves ~$45/day vs. $2/day on GPT-4o-mini. The savings scale with your output price.

**4. The 5% zombie rate assumption is conservative for mobile.**
If your client mix is >30% mobile, estimate zombie rate at 10–15%. At 15% zombie rate and 100K req/day (Claude Sonnet): savings become ~$135/day or ~$4,050/month.

**5. There's a GPU cost savings that these numbers don't capture.**
Zombie streams hold KV cache memory and GPU compute. On self-hosted inference, zombie cancellation frees capacity for live requests — the opportunity cost of zombie compute isn't in the API bill, but it's real.

## How to Calculate for Your Own Usage

1. **Measure your zombie rate**: instrument your existing streaming endpoint with a disconnect counter. `total_disconnect_events / total_stream_starts` over a week.

2. **Calculate base cost per request**:
   ```
   base_cost = (avg_input_tokens / 1,000,000 × input_price) + (avg_output_tokens / 1,000,000 × output_price)
   ```

3. **Estimate zombie output fraction**: log `tokens_delivered_at_disconnect / total_output_tokens` for disconnected streams. If clients typically disconnect at 30% through the response, the fraction is 0.70 (70% of output tokens wasted without cancellation).

4. **Calculate daily savings**:
   ```
   daily_savings = zombie_rate × requests_per_day × base_cost × zombie_output_fraction
   ```

5. **Add GPU/infrastructure savings** if self-hosted: calculate compute cost per second × average zombie stream duration × zombie rate × requests/day.

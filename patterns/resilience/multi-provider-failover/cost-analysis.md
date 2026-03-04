# Cost Analysis: Multi-Provider Failover

## Assumptions

| Parameter | Value | Justification |
|-----------|-------|---------------|
| Avg input tokens/request | 500 | Typical prompt with system message + user query |
| Avg output tokens/request | 200 | Standard response length |
| Provider failure rate | 2% | Conservative estimate; real rates are spiky (0% normally, 100% during outages) |
| Failover overhead multiplier | 1.02x | 2% of requests incur one extra API call to the backup provider |
| Timeout waste | 0.5% | Half of failures timeout before erroring — tokens sent but response incomplete |
| Multi-provider account overhead | ~$0 | No additional API account costs; both providers charge per-use |

**Key insight:** Multi-provider failover doesn't change the number of *successful* API calls. It adds costs in two ways: (1) failed attempts that consumed tokens before failing, and (2) price differences between primary and backup providers.

## Model Pricing (as of March 2026)

| Model | Input | Output |
|-------|-------|--------|
| GPT-4o | $2.50 / 1M tokens | $10.00 / 1M tokens |
| Claude Sonnet | $3.00 / 1M tokens | $15.00 / 1M tokens |
| GPT-4o-mini | $0.15 / 1M tokens | $0.60 / 1M tokens |

## Formulas

```
Base cost per request = (input_tokens × input_price) + (output_tokens × output_price)

Failover cost per request = base_cost × (1 + failure_rate × price_ratio_adjustment)
  + timeout_waste_rate × input_tokens × input_price

Daily cost = requests_per_day × failover_cost_per_request

Additional cost vs. no pattern = daily_failover_cost - daily_base_cost
```

Where `price_ratio_adjustment` accounts for the backup provider potentially costing more or less than the primary.

## Cost Projections

### GPT-4o (Primary) → Claude Sonnet (Backup)

Base cost per request: (500 × $2.50/1M) + (200 × $10.00/1M) = $0.00125 + $0.00200 = **$0.00325**

Failover cost components:
- 2% of requests fail over to Claude Sonnet: (500 × $3.00/1M) + (200 × $15.00/1M) = $0.00450 per failover request
- 0.5% timeout waste: 500 × $2.50/1M = $0.00125 per wasted request (input tokens only)

| Scale | Base Cost (No Pattern) | With Failover | Additional Cost | Notes |
|-------|----------------------|---------------|-----------------|-------|
| 1K req/day | $3.25/day | $3.29/day | +$0.04/day (+1.2%) | Negligible — 20 failover requests × $0.00125 extra |
| 10K req/day | $32.50/day | $32.87/day | +$0.37/day (+1.1%) | 200 failover requests; savings from avoided downtime far exceed cost |
| 100K req/day | $325.00/day | $328.70/day | +$3.70/day (+1.1%) | At this scale, a 2-hour outage without failover costs ~$27 in SLA credits alone |

### Claude Sonnet (Primary) → GPT-4o (Backup)

Base cost per request: (500 × $3.00/1M) + (200 × $15.00/1M) = $0.00150 + $0.00300 = **$0.00450**

| Scale | Base Cost (No Pattern) | With Failover | Additional Cost | Notes |
|-------|----------------------|---------------|-----------------|-------|
| 1K req/day | $4.50/day | $4.52/day | +$0.02/day (+0.4%) | Backup (GPT-4o) is *cheaper* — failover actually saves on the 2% |
| 10K req/day | $45.00/day | $45.16/day | +$0.16/day (+0.4%) | Price asymmetry means failover direction matters |
| 100K req/day | $450.00/day | $451.60/day | +$1.60/day (+0.4%) | Minimal overhead; the pattern pays for itself on first avoided outage |

### GPT-4o-mini (Primary) → GPT-4o-mini on Azure (Backup)

Base cost per request: (500 × $0.15/1M) + (200 × $0.60/1M) = $0.000075 + $0.000120 = **$0.000195**

| Scale | Base Cost (No Pattern) | With Failover | Additional Cost | Notes |
|-------|----------------------|---------------|-----------------|-------|
| 1K req/day | $0.20/day | $0.20/day | +$0.00/day | Same-model failover: zero price difference |
| 10K req/day | $1.95/day | $1.95/day | +$0.01/day | Timeout waste is the only cost: ~$0.006 |
| 100K req/day | $19.50/day | $19.56/day | +$0.06/day | Same-model, different-region failover is the cheapest option |

## How to Calculate for Your Own Usage

1. **Find your base cost per request:**
   ```
   base = (your_avg_input_tokens × your_model_input_price / 1_000_000)
        + (your_avg_output_tokens × your_model_output_price / 1_000_000)
   ```

2. **Estimate your failure rate:** Check your provider dashboard for error rates over the last 90 days. Use the spiky-average, not the smooth average — a 0.1% average might mean 0% for 89 days and 100% for 1 day.

3. **Calculate failover overhead:**
   ```
   overhead_per_day = requests_per_day × failure_rate × (backup_cost_per_req - primary_cost_per_req)
                    + requests_per_day × timeout_waste_rate × primary_input_cost_per_req
   ```

4. **Compare to downtime cost:** Estimate the cost of downtime (SLA credits, lost revenue, support tickets). If `overhead_per_day × 365 < cost_of_one_outage`, the pattern pays for itself.

## Key Insights

- **The pattern is nearly free.** At 2% failure rate, the additional cost is 0.4-1.2% — well within the noise of daily API cost variation. The actual cost driver is *which* providers you pair, not the failover mechanism itself.
- **Failover direction matters.** GPT-4o → Claude Sonnet costs slightly more per failover request ($0.00450 vs. $0.00325). Claude Sonnet → GPT-4o actually *saves* money on failover requests. Choose your primary based on capability/latency, not failover cost.
- **Same-model, different-region is cheapest.** Using GPT-4o via OpenAI (primary) and GPT-4o via Azure (backup) eliminates the price differential entirely. The only overhead is timeout waste on failed attempts.
- **The break-even is essentially one avoided outage.** At 100K req/day with GPT-4o pricing, the pattern costs ~$3.70/day extra. A single 2-hour outage affects ~8,333 requests. Even at $0 SLA cost, the user experience savings justify the <1% overhead on the first incident.
- **Timeout waste is the real hidden cost.** When a provider hangs for 30 seconds before timing out, you've already sent the input tokens. With 500 input tokens at GPT-4o rates, that's $0.00125 wasted per timeout. Aggressive timeouts (5s instead of 30s) reduce this waste.

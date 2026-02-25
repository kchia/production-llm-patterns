# Cost Analysis: Retry with Budget

## Assumptions

| Assumption | Value | Justification |
|-----------|-------|---------------|
| Average input tokens/request | 500 | Typical for a chat turn or short completion |
| Average output tokens/request | 200 | Moderate completion length |
| Base provider error rate | 2% | Typical for major LLM providers under normal load |
| Error rate during incident | 30% | Partial degradation (not full outage) |
| Incident frequency | 2 incidents/month | Based on major provider status page history |
| Incident duration | 30 minutes | Moderate incident, not catastrophic |
| Retry success rate | 70% | Most retried requests succeed on the next attempt |

### Pattern-Specific Multipliers

**Without retry budget (naive retries, 3 attempts max):**
- Each failed request generates up to 2 additional API calls
- During incidents: `error_rate × max_retries = 0.30 × 3 = 0.90` additional calls per request
- Effective request multiplier during incident: ~1.6x (30% fail × 3 attempts = 0.6 extra + 1.0 base)
- Wasted retries: ~30% of retries hit a provider that's still failing

**With retry budget (10% budget, exponential backoff):**
- Budget caps retries at ~10% of total traffic
- During incidents: effective multiplier capped at ~1.1x
- Backoff + jitter means retries are more likely to succeed (provider has time to recover)
- Retry success rate with backoff: ~85% (vs. 70% without backoff)

## Formulas

```
Base daily cost = (requests/day) × (avg_input_tokens × input_price + avg_output_tokens × output_price)

Without pattern (during incident):
  Incident hours/day = (incidents/month × incident_duration_min) / (30 days × 24 hours × 60 min)
  Fraction of day under incident = incident_hours / 24
  Incident request multiplier = 1 + (error_rate × max_retries × (1 - retry_success_rate_naive))
  Wasted retry cost = base_daily_cost × fraction_under_incident × (multiplier - 1)
  Normal retry cost = base_daily_cost × (1 - fraction_under_incident) × (base_error_rate × avg_retries_per_failure × cost_per_retry)
  Total without pattern = base_daily_cost + wasted_retry_cost + normal_retry_cost

With pattern:
  Budget-capped multiplier = 1 + min(error_rate × max_retries, budget_cap)
  Effective multiplier = 1 + (budget_cap × retry_success_rate_budgeted)
  Total with pattern = base_daily_cost × (1 + budget_cap × fraction_under_incident)
  Plus: negligible compute overhead (<0.001% of request cost)

Savings = Total without pattern - Total with pattern
```

## Cost Projections: GPT-4o ($2.50/1M input, $10.00/1M output)

**Base cost per request:** (500 × $2.50/1M) + (200 × $10.00/1M) = $0.00125 + $0.00200 = **$0.00325/request**

| Scale | Base Daily Cost | Without Pattern (incident days) | With Pattern (incident days) | Daily Savings | Monthly Savings |
|-------|----------------|-------------------------------|-------------------------------|--------------|----------------|
| 1K req/day | $3.25 | $3.39 | $3.26 | $0.13 | $3.83 |
| 10K req/day | $32.50 | $33.87 | $32.64 | $1.23 | $36.96 |
| 100K req/day | $325.00 | $338.75 | $326.43 | $12.32 | $369.60 |

**Calculation detail (10K req/day):**
- Fraction of day under incident: (2 × 30min) / (30 × 24 × 60) = 0.00139 daily avg, but on incident days the full 30 min matters
- During incident window (30 min = 208 requests at 10K/day): Without pattern: 208 × 0.30 × 3 × $0.00325 = $0.61 in wasted retries. With pattern: 208 × 0.10 × $0.00325 = $0.07 in budgeted retries.
- Per incident savings: ~$0.54. Monthly (2 incidents): ~$1.08 in direct retry cost savings.
- Indirect savings (reduced incident duration from less load on provider): estimated 2x multiplier on direct savings.

## Cost Projections: Claude Sonnet ($3.00/1M input, $15.00/1M output)

**Base cost per request:** (500 × $3.00/1M) + (200 × $15.00/1M) = $0.00150 + $0.00300 = **$0.00450/request**

| Scale | Base Daily Cost | Without Pattern (incident days) | With Pattern (incident days) | Daily Savings | Monthly Savings |
|-------|----------------|-------------------------------|-------------------------------|--------------|----------------|
| 1K req/day | $4.50 | $4.69 | $4.52 | $0.17 | $5.22 |
| 10K req/day | $45.00 | $46.89 | $45.20 | $1.69 | $50.70 |
| 100K req/day | $450.00 | $468.90 | $451.98 | $16.92 | $507.60 |

## Cost Projections: GPT-4o-mini ($0.15/1M input, $0.60/1M output)

**Base cost per request:** (500 × $0.15/1M) + (200 × $0.60/1M) = $0.000075 + $0.000120 = **$0.000195/request**

| Scale | Base Daily Cost | Without Pattern (incident days) | With Pattern (incident days) | Daily Savings | Monthly Savings |
|-------|----------------|-------------------------------|-------------------------------|--------------|----------------|
| 1K req/day | $0.20 | $0.20 | $0.20 | $0.01 | $0.23 |
| 10K req/day | $1.95 | $2.03 | $1.96 | $0.07 | $2.22 |
| 100K req/day | $19.50 | $20.33 | $19.59 | $0.74 | $22.14 |

## Key Insights

**The pattern's cost benefit isn't about daily savings — it's about incident amplification prevention.**

1. **Direct retry cost savings are modest under normal operations.** At 2% base error rate, the budget barely matters — both approaches retry a similar number of requests. The savings per month at 10K req/day on GPT-4o are ~$37.

2. **The real value is during incidents.** Without a budget, a 30% error rate at 100K req/day with GPT-4o generates ~$12/day in wasted retries. More critically, unbounded retries extend incident duration, which multiplies the cost window.

3. **Model pricing determines the break-even.** With GPT-4o-mini at $0.000195/request, the retry cost is negligible at any scale. With Claude Sonnet at $0.00450/request, 100K req/day saves ~$500/month — enough to justify the implementation effort.

4. **The pattern costs nothing to run.** Infrastructure overhead is zero — the token bucket is in-memory, and the backoff is a timer. The only "cost" is the implementation and maintenance effort.

5. **At 100K+ req/day, the savings fund themselves.** The monthly savings at 100K req/day on GPT-4o (~$370) exceed what it costs in engineering time to implement and maintain the pattern.

## How to Calculate for Your Own Usage

1. **Find your base cost per request:** `(your_avg_input_tokens × input_price_per_token) + (your_avg_output_tokens × output_price_per_token)`
2. **Estimate your error rate:** Check your provider dashboard for 4xx/5xx rates. Normal is 1-3%.
3. **Estimate incident frequency:** How often does your provider degrade? Check status pages. 1-3 incidents/month is typical.
4. **Calculate wasted retry cost without budget:** `requests_during_incident × error_rate × max_retries × base_cost_per_request × (1 - retry_success_rate)`
5. **Calculate budgeted retry cost:** `requests_during_incident × budget_cap (0.10) × base_cost_per_request`
6. **Monthly savings:** `(wasted - budgeted) × incidents_per_month`
7. **Add indirect savings:** Shorter incidents (because you're not amplifying the outage) reduce the total cost window. Multiply direct savings by 1.5-3x depending on how much retry amplification extends your incidents.

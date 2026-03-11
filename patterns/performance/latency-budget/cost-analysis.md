# Cost Analysis: Latency Budget

## How This Pattern Affects Costs

The latency budget pattern's cost impact is indirect but significant. It doesn't add or remove API calls in the happy path — but under budget pressure, it _skips optional steps_ and may _route to cheaper/faster models_, both of which reduce spend on tail-latency requests.

**Cost-reducing effects:**
- Skipping optional steps (re-ranking, validation) avoids API calls on requests that would blow the SLA anyway
- Model downgrade under pressure (e.g., GPT-4o → GPT-4o-mini for generation when budget is tight) reduces per-request cost
- Early abort on exhausted budgets prevents spending on responses no user will see

**Cost-increasing effects:**
- None in terms of extra API calls — the pattern is a wrapper, not a call multiplier
- Marginal compute overhead (~0.05ms per request) is negligible

**Net effect:** The pattern _saves_ money, primarily by avoiding wasted API spend on requests that would exceed the SLA. The savings scale with tail-latency frequency.

## Assumptions

| Parameter | Value | Justification |
|-----------|-------|---------------|
| Average input tokens/request | 800 | Typical RAG prompt with 2-3 retrieved chunks |
| Average output tokens/request | 300 | Standard generation response |
| Pipeline steps with LLM calls | 2 | Generation + optional validation/re-ranking |
| Tail-latency rate (>SLA) | 5% | Typical p95–p100 band for LLM pipelines |
| Skip rate under budget pressure | 50% | Half of tail requests skip at least one LLM step |
| Model downgrade rate | 10% | Fraction of tail requests routed to cheaper model |
| Requests where output is wasted (no pattern) | 3% | User abandoned before response arrived |

## Baseline: Cost Without Pattern

Every request runs all steps to completion regardless of SLA status.

```
Base cost per request = input_tokens × input_price + output_tokens × output_price
                      = (800/1M × input_price) + (300/1M × output_price)

Extra LLM call (validation/reranking) per request:
  = (400/1M × input_price) + (100/1M × output_price)

Total per request = main_call + optional_call
```

## Cost Projections: GPT-4o ($2.50/1M input, $10.00/1M output)

**Per-request costs:**
- Main generation call: (800 × $2.50 + 300 × $10.00) / 1M = $0.00200 + $0.00300 = $0.00500
- Optional step call: (400 × $2.50 + 100 × $10.00) / 1M = $0.00100 + $0.00100 = $0.00200
- Total per request (no pattern): $0.00700

**With pattern — savings on tail requests:**
- 5% of requests hit budget pressure. Of those:
  - 50% skip the optional LLM call → saves $0.00200 per skipped request
  - 10% downgrade from GPT-4o to GPT-4o-mini → saves ~$0.00480 per downgraded request
- 3% of requests would have been wasted (user abandoned) → saves full $0.00700

| Scale | Without Pattern | With Pattern | Savings/day | Monthly Savings |
|-------|----------------|-------------|-------------|-----------------|
| 1K req/day | $7.00/day | $6.83/day | $0.17/day | ~$5/mo |
| 10K req/day | $70.00/day | $68.30/day | $1.70/day | ~$51/mo |
| 100K req/day | $700.00/day | $683.00/day | $17.00/day | ~$510/mo |

## Cost Projections: Claude Sonnet ($3.00/1M input, $15.00/1M output)

**Per-request costs:**
- Main generation call: (800 × $3.00 + 300 × $15.00) / 1M = $0.00240 + $0.00450 = $0.00690
- Optional step call: (400 × $3.00 + 100 × $15.00) / 1M = $0.00120 + $0.00150 = $0.00270
- Total per request (no pattern): $0.00960

| Scale | Without Pattern | With Pattern | Savings/day | Monthly Savings |
|-------|----------------|-------------|-------------|-----------------|
| 1K req/day | $9.60/day | $9.37/day | $0.23/day | ~$7/mo |
| 10K req/day | $96.00/day | $93.68/day | $2.32/day | ~$70/mo |
| 100K req/day | $960.00/day | $936.80/day | $23.20/day | ~$696/mo |

## Cost Projections: GPT-4o-mini ($0.15/1M input, $0.60/1M output)

**Per-request costs:**
- Main generation call: (800 × $0.15 + 300 × $0.60) / 1M = $0.00012 + $0.00018 = $0.00030
- Optional step call: (400 × $0.15 + 100 × $0.60) / 1M = $0.00006 + $0.00006 = $0.00012
- Total per request (no pattern): $0.00042

| Scale | Without Pattern | With Pattern | Savings/day | Monthly Savings |
|-------|----------------|-------------|-------------|-----------------|
| 1K req/day | $0.42/day | $0.41/day | $0.01/day | ~$0.30/mo |
| 10K req/day | $4.20/day | $4.10/day | $0.10/day | ~$3/mo |
| 100K req/day | $42.00/day | $41.00/day | $1.00/day | ~$30/mo |

## Formulas

```
# Base cost per request
base_cost = (input_tokens / 1M) × input_price + (output_tokens / 1M) × output_price
optional_cost = (opt_input_tokens / 1M) × input_price + (opt_output_tokens / 1M) × output_price
total_per_req = base_cost + optional_cost

# Savings from pattern
skip_savings = total_requests × tail_rate × skip_rate × optional_cost
downgrade_savings = total_requests × tail_rate × downgrade_rate × (base_cost - mini_base_cost)
abandon_savings = total_requests × abandon_rate × total_per_req
total_savings = skip_savings + downgrade_savings + abandon_savings

# With pattern
daily_cost_with_pattern = (total_requests × total_per_req) - total_savings
```

## How to Calculate for Your Own Usage

1. **Measure your pipeline:** Count LLM calls per request and average token counts per call
2. **Measure your tail:** What fraction of requests exceed your SLA? (That's your `tail_rate`)
3. **Estimate skip impact:** How many optional LLM steps would be skipped under budget pressure?
4. **Estimate abandon rate:** What fraction of users leave before the response arrives? (Check your analytics for abandoned requests)
5. **Plug into the formula above** with your model's pricing

## Key Insights

- **The pattern's cost savings are proportional to tail-latency frequency.** If only 1% of requests hit budget pressure, savings are minimal. At 10%+ tail rate, the savings compound quickly.
- **Model pricing matters enormously.** Savings on Claude Sonnet ($15/M output) are ~5x larger than on GPT-4o-mini ($0.60/M output) for the same skip rate. The more expensive your model, the more the pattern saves by avoiding wasted calls.
- **The biggest savings come from avoiding wasted work on abandoned requests** — not from the skip/downgrade mechanics. If 3% of users abandon, that's 3% of your entire spend that produces zero value.
- **Break-even:** The pattern's implementation cost is near zero (no infrastructure, no extra API calls). The only cost is developer time to integrate. At 10K req/day with GPT-4o, the ~$51/mo savings covers a few hours of integration time within the first month.
- **At GPT-4o-mini pricing, the cost savings are negligible** — but the pattern's primary value is latency compliance, not cost reduction. The cost savings are a bonus.

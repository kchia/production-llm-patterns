# Cost Analysis: Prompt Injection Defense

## Assumptions

| Parameter | Value | Justification |
|-----------|-------|---------------|
| Avg input tokens/request | 500 | Typical user message + system prompt context |
| Avg output tokens/request | 300 | Standard LLM response length |
| Defense overhead tokens | 0 | Heuristic defense adds zero token cost — no extra LLM calls |
| ML classifier overhead | +50 tokens (if using LLM-as-classifier) | Only applies if using an LLM call for classification instead of a dedicated model |
| Block rate (benign traffic) | 0.5% | Conservative false positive rate with well-tuned thresholds |
| Block rate (attack traffic) | 5% | Assumed fraction of traffic that contains injection attempts |
| Compute cost (heuristic) | ~$0 | CPU regex + heuristic — negligible at any scale |
| Compute cost (ML classifier) | ~$0.01/1K requests | Prompt Guard 22M on CPU, or ~$0.001/1K on GPU |

### Key Insight: Defense Strategy Determines Cost

Prompt injection defense is unusual among LLM patterns because the **primary implementation adds zero token cost**. The heuristic classifier, pattern matching, and output scanning all run on CPU without making additional LLM calls.

Cost only enters the picture in two scenarios:
1. **LLM-as-classifier** — Using a second LLM call to evaluate whether input is an injection attempt (adds ~50 input tokens per request)
2. **Blocked requests save money** — Every blocked injection is a request that doesn't hit the LLM API. At 5% attack traffic, this saves 5% of API costs.

## Cost Projections

### Scenario A: Heuristic/ML Classifier (No Extra LLM Calls)

This is the recommended approach and what the reference implementation uses.

#### GPT-4o ($2.50/1M input, $10.00/1M output)

| Scale | Base Cost (no defense) | With Defense | Net Impact | ROI |
|-------|----------------------|-------------|------------|-----|
| 1K req/day | $4.25/day | $4.04/day | **-$0.21/day** | Defense saves 5% by blocking attacks |
| 10K req/day | $42.50/day | $40.38/day | **-$2.13/day** | Saves ~$63/month |
| 100K req/day | $425.00/day | $403.75/day | **-$21.25/day** | Saves ~$637/month |

#### Claude Sonnet ($3.00/1M input, $15.00/1M output)

| Scale | Base Cost (no defense) | With Defense | Net Impact | ROI |
|-------|----------------------|-------------|------------|-----|
| 1K req/day | $6.00/day | $5.70/day | **-$0.30/day** | Defense saves 5% |
| 10K req/day | $60.00/day | $57.00/day | **-$3.00/day** | Saves ~$90/month |
| 100K req/day | $600.00/day | $570.00/day | **-$30.00/day** | Saves ~$900/month |

#### GPT-4o-mini ($0.15/1M input, $0.60/1M output)

| Scale | Base Cost (no defense) | With Defense | Net Impact | ROI |
|-------|----------------------|-------------|------------|-----|
| 1K req/day | $0.26/day | $0.24/day | **-$0.01/day** | Negligible savings |
| 10K req/day | $2.55/day | $2.42/day | **-$0.13/day** | Saves ~$4/month |
| 100K req/day | $25.50/day | $24.23/day | **-$1.28/day** | Saves ~$38/month |

### Scenario B: LLM-as-Classifier (Extra LLM Call per Request)

If using a secondary LLM call for injection classification (not recommended for cost, but some teams prefer the accuracy).

#### GPT-4o

| Scale | Base Cost | With LLM Classifier | Net Impact | Notes |
|-------|-----------|-------------------|------------|-------|
| 1K req/day | $4.25/day | $4.17/day | **-$0.08/day** | Classifier cost ($0.13) partially offset by block savings ($0.21) |
| 10K req/day | $42.50/day | $41.63/day | **-$0.88/day** | Classifier: $1.25/day, Savings: $2.13/day |
| 100K req/day | $425.00/day | $416.25/day | **-$8.75/day** | Classifier: $12.50/day, Savings: $21.25/day |

## Formulas

```
# Base daily cost (no defense)
base_cost = requests_per_day × (avg_input_tokens × input_price + avg_output_tokens × output_price) / 1_000_000

# With heuristic defense (no extra LLM calls)
blocked_savings = base_cost × block_rate
defense_cost = base_cost - blocked_savings
# Note: compute cost for heuristic defense is negligible (~$0)

# With LLM classifier defense
classifier_cost = requests_per_day × classifier_tokens × input_price / 1_000_000
defense_cost = base_cost + classifier_cost - blocked_savings

# Net impact
net_impact = defense_cost - base_cost
```

### Plugging in GPT-4o numbers at 10K req/day:

```
base_cost = 10,000 × (500 × $2.50 + 300 × $10.00) / 1,000,000
         = 10,000 × ($0.00125 + $0.003) / 1
         = 10,000 × $0.00425
         = $42.50/day

blocked_savings = $42.50 × 0.05 = $2.13/day

heuristic_defense_cost = $42.50 - $2.13 = $40.38/day
net_impact = $40.38 - $42.50 = -$2.13/day (savings)
```

## How to Calculate for Your Own Usage

1. **Determine your average tokens per request.** Check your LLM provider dashboard or sample 100 requests. Use median, not mean (outliers skew averages).
2. **Estimate your attack traffic rate.** Start with 5% as a conservative estimate. If you're a high-profile target or accept public input, use 10-15%. Internal tools can use 1-2%.
3. **Choose your classifier approach.** Heuristic (free) vs. ML model (minimal compute) vs. LLM-as-classifier (adds token cost). The reference implementation uses heuristic.
4. **Plug into the formulas above.** The key variable is `block_rate` — higher attack traffic means more savings from blocking.
5. **Don't forget the cost of NOT defending.** IBM Security reports the average cost of a data breach at $4.88M (2024). One successful injection leading to data exfiltration can dwarf years of API savings.

## Key Insights

- **Heuristic defense is essentially free.** No extra tokens, negligible compute. The 5% block rate actually *saves* money by preventing wasted API calls on attack traffic.
- **The real ROI isn't in token savings — it's in breach prevention.** The API cost difference is marginal. The value is in preventing a $4.88M average data breach, system compromise, or reputational damage.
- **Model pricing barely matters for this pattern.** Whether you're on GPT-4o or Claude Sonnet, the defense cost is effectively zero (heuristic) or minimal (ML classifier). This is one of the cheapest patterns to implement relative to its risk reduction.
- **LLM-as-classifier is cost-negative above ~2% attack rate.** The extra classifier token cost is offset by blocked-request savings once attack traffic exceeds ~2% of total requests.
- **Scale makes the savings more visible.** At 100K req/day on GPT-4o, blocking 5% of traffic saves $21/day ($637/month). Not transformative, but also not nothing.

# Cost Analysis: Semantic Caching

## Assumptions

| Parameter | Value | Justification |
|-----------|-------|---------------|
| Average input tokens/request | 500 | Typical user query with system prompt context |
| Average output tokens/request | 300 | Standard conversational or informational response |
| Cache hit rate | 35% | Conservative estimate for FAQ/knowledge-base workloads. Research suggests ~31% of queries are semantically similar; actual hit rates vary from 20–70% depending on query diversity. |
| Embedding cost | ~$0.00002/query | ~500 tokens at $0.02/1M for text-embedding-3-small; negligible at all scales |
| Vector storage | ~$0.001/entry/day | In-memory or Redis-based; minimal at <10K entries |
| Cache infrastructure | ~$5/day fixed | Small Redis instance or in-memory process overhead |

## Formulas

```
Base daily cost = (requests/day) × (avg_input_tokens × input_price + avg_output_tokens × output_price) / 1,000,000

Without caching:
  Daily cost = requests × (500 × input_price + 300 × output_price) / 1,000,000

With caching (35% hit rate):
  LLM calls = requests × (1 - hit_rate)
  LLM cost = LLM_calls × (500 × input_price + 300 × output_price) / 1,000,000
  Embedding cost = requests × 500 × 0.00002 / 1,000  ≈ negligible
  Infra cost = $5/day fixed (cache storage/compute)
  Total = LLM_cost + Embedding_cost + Infra_cost

Savings = (Base daily cost) - (Total with caching)
ROI = Savings / Infra_cost
```

## Cost Projection: GPT-4o ($2.50 input / $10.00 output per 1M tokens)

| Scale | Without Pattern | With Pattern (35% hit) | Savings | ROI |
|-------|----------------|----------------------|---------|-----|
| 1K req/day | $4.25/day | $2.81/day | +$1.44/day | Pattern saves $1.44/day vs. $5 infra — **not worth it at this scale** |
| 10K req/day | $42.50/day | $27.63/day + $5 infra = $32.63/day | +$9.87/day | 2x return on infra spend. **Break-even.** |
| 100K req/day | $425.00/day | $276.25/day + $5 infra = $281.25/day | +$143.75/day | 29x return on infra. **Clear win.** |

## Cost Projection: Claude Sonnet ($3.00 input / $15.00 output per 1M tokens)

| Scale | Without Pattern | With Pattern (35% hit) | Savings | ROI |
|-------|----------------|----------------------|---------|-----|
| 1K req/day | $6.00/day | $3.90/day + $5 = $8.90/day | -$2.90/day | **Net negative** — infra exceeds savings |
| 10K req/day | $60.00/day | $39.00/day + $5 = $44.00/day | +$16.00/day | 3.2x return. **Solid.** |
| 100K req/day | $600.00/day | $390.00/day + $5 = $395.00/day | +$205.00/day | 41x return. **Compelling.** |

## Cost Projection: GPT-4o-mini ($0.15 input / $0.60 output per 1M tokens)

| Scale | Without Pattern | With Pattern (35% hit) | Savings | ROI |
|-------|----------------|----------------------|---------|-----|
| 1K req/day | $0.26/day | $0.17/day + $5 = $5.17/day | -$4.91/day | **Net negative** — model too cheap to justify caching infra |
| 10K req/day | $2.55/day | $1.66/day + $5 = $6.66/day | -$4.11/day | **Still negative.** Cache infra costs more than savings |
| 100K req/day | $25.50/day | $16.58/day + $5 = $21.58/day | +$3.93/day | **Marginal.** Only worth it if infra costs are already sunk |

## How to Calculate for Your Own Usage

1. **Estimate your base cost:** `requests/day × (input_tokens × model_input_price + output_tokens × model_output_price) / 1,000,000`
2. **Estimate your hit rate:** Sample 1,000 queries from your logs. Embed them and cluster by cosine similarity >0.85. Count the percentage of queries that fall into clusters with >1 member. That's your approximate hit rate.
3. **Calculate savings:** `base_cost × hit_rate`
4. **Subtract infra cost:** Embedding compute (negligible) + cache storage ($5–50/day depending on scale and backend)
5. **Break-even check:** If `savings > infra_cost`, the pattern pays for itself.

## Key Insights

- **Model pricing is the dominant factor.** Semantic caching makes financial sense for expensive models (GPT-4o, Claude Sonnet) at moderate-to-high scale. For cheap models (GPT-4o-mini), the cache infrastructure cost often exceeds the API savings.
- **Break-even scale is ~5K–10K requests/day** for GPT-4o pricing at a 35% hit rate. Below that, the fixed infra cost dominates.
- **Hit rate is the swing variable.** At 50% hit rate instead of 35%, savings nearly double. FAQ-style workloads can achieve 50–70% hit rates; diverse conversational workloads may only hit 15–25%.
- **Latency savings aren't captured in dollar terms** but are often the stronger argument. A cache hit returns in <5ms versus 500ms–2s for a fresh LLM call. For latency-sensitive applications, the latency improvement alone justifies the pattern even when dollar savings are marginal.
- **The embedding cost is negligible.** At $0.02/1M tokens for text-embedding-3-small, embedding every query costs fractions of a cent. The cost analysis is really about cache hits avoiding LLM output tokens, which are 50–250x more expensive.

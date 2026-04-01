# Cost Analysis: Index Maintenance

## Assumptions

Index Maintenance doesn't add LLM API tokens — it doesn't call the model at all. The cost model is about two things:

1. **Infrastructure overhead**: Periodic vacuum, compact, and payload index operations consume CPU and memory on the vector store. These are negligible compared to LLM API costs.

2. **Avoided re-query cost**: A degraded index (recall drop of 10–15%) means some queries fail to retrieve relevant context. In practice, ~3–5% of queries trigger a second retrieval attempt or an additional LLM call when the first attempt returns poor results. Index maintenance prevents this by keeping recall high.

| Parameter | Value | Justification |
|---|---|---|
| Average input tokens per query | 2,000 | ~1,500 token context window + ~500 token prompt |
| Average output tokens per query | 300 | Typical RAG response |
| Re-query rate without maintenance | 3% of requests | Conservative estimate; recall degradation of 10–15% translates to ~3% re-query rate |
| Maintenance infrastructure overhead | $0.04/day | Periodic CPU for vacuum/compact (fixed regardless of request volume) |
| Maintenance frequency | 1–2 runs/day | Typical for collections with 1–5% daily document churn |

## Pricing (verified March 2026)

| Model         | Input           | Output          |
|---------------|-----------------|-----------------|
| GPT-4o        | $2.50 / 1M tok  | $10.00 / 1M tok |
| Claude Sonnet | $3.00 / 1M tok  | $15.00 / 1M tok |
| GPT-4o-mini   | $0.15 / 1M tok  | $0.60 / 1M tok  |

## Formula

```
Cost per LLM call = (avg_input_tokens / 1M × input_price)
                  + (avg_output_tokens / 1M × output_price)

Wasted cost/day  = requests_per_day × re_query_rate × cost_per_call

Infrastructure overhead = $0.04/day (fixed)

Net daily saving  = Wasted cost/day − Infrastructure overhead
```

## Cost Projections

### GPT-4o ($2.50 input / $10.00 output per 1M tokens)

Cost per LLM call = (2000/1M × $2.50) + (300/1M × $10.00) = $0.005 + $0.003 = **$0.008**

| Scale        | Re-queries/day | Wasted cost/day | Maintenance overhead | Net saving/day |
|--------------|---------------|-----------------|----------------------|----------------|
| 1K req/day   |            30 |          $0.24  |               $0.04  |        +$0.20  |
| 10K req/day  |           300 |          $2.40  |               $0.04  |        +$2.36  |
| 100K req/day |         3,000 |         $24.00  |               $0.04  |       +$23.96  |

### Claude Sonnet ($3.00 input / $15.00 output per 1M tokens)

Cost per LLM call = (2000/1M × $3.00) + (300/1M × $15.00) = $0.006 + $0.0045 = **$0.0105**

| Scale        | Re-queries/day | Wasted cost/day | Maintenance overhead | Net saving/day |
|--------------|---------------|-----------------|----------------------|----------------|
| 1K req/day   |            30 |          $0.32  |               $0.04  |        +$0.28  |
| 10K req/day  |           300 |          $3.15  |               $0.04  |        +$3.11  |
| 100K req/day |         3,000 |         $31.50  |               $0.04  |       +$31.46  |

### GPT-4o-mini ($0.15 input / $0.60 output per 1M tokens)

Cost per LLM call = (2000/1M × $0.15) + (300/1M × $0.60) = $0.0003 + $0.00018 = **$0.00048**

| Scale        | Re-queries/day | Wasted cost/day | Maintenance overhead | Net saving/day |
|--------------|---------------|-----------------|----------------------|----------------|
| 1K req/day   |            30 |          $0.01  |               $0.04  |        −$0.03  |
| 10K req/day  |           300 |          $0.14  |               $0.04  |        +$0.10  |
| 100K req/day |         3,000 |          $1.44  |               $0.04  |        +$1.40  |

## Key Insights

**At small scale with cheap models, the ROI is marginal.** At 1K req/day with GPT-4o-mini, the maintenance infrastructure overhead ($0.04/day) slightly exceeds the avoided re-query cost ($0.01/day). The correctness and recall benefits still matter, but the dollar case is weak below 5K req/day with mini models.

**At scale with capable models, the ROI is strong.** At 100K req/day with GPT-4o or Claude Sonnet, the pattern saves $24–$31/day. The $0.04/day maintenance overhead is less than 0.2% of savings.

**The 3% re-query rate assumption is conservative.** Teams that instrument retrieval quality often find higher rates — some report 5–10% of queries returning no useful context after months of index neglect. If your actual re-query rate is 5%, double the savings figures above.

**Model tier changes the break-even point significantly.** GPT-4o-mini's per-call cost is 17× lower than GPT-4o, so the dollar value of avoiding re-queries is proportionally lower. If your system runs on mini-tier models, the financial case for index maintenance is primarily about correctness, not cost.

## How to Calculate for Your Own Usage

1. **Measure your actual re-query rate**: Instrument your RAG pipeline to count queries that trigger a second retrieval or LLM call. This is your actual multiplier.

2. **Find your cost per LLM call**: `(avg_input_tokens / 1M × input_price) + (avg_output_tokens / 1M × output_price)`

3. **Estimate wasted cost without maintenance**: `requests_per_day × your_re_query_rate × cost_per_call`

4. **Estimate infrastructure overhead**: For most deployments, vacuum + compaction costs are < $0.10/day in CPU time. Your cloud provider's compute billing will show this.

5. **Break-even point**: `Infrastructure overhead / (cost_per_call × re_query_rate)` gives the request volume where the pattern starts saving money.

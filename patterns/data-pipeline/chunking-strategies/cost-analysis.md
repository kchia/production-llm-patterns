# Cost Analysis: Chunking Strategies

> Pricing as of 2026-03: GPT-4o $2.50/1M input, $10.00/1M output; Claude Sonnet 4.6 $3.00/1M input, $15.00/1M output; GPT-4o-mini $0.15/1M input, $0.60/1M output.

## How Chunking Affects Cost

Chunking is a preprocessing step — it runs at document ingestion time, not query time. The pattern itself makes no LLM API calls (for the recommended `recursive` and `structure-aware` strategies). Its cost impact is indirect: better chunks reduce wasted context tokens at query time.

**The mechanism:**
- Naive fixed-size chunking produces large, poorly-bounded chunks (~800 tokens avg from common defaults)
- At retrieval, 5 retrieved chunks × 800 tokens = 4,000 context tokens per RAG query
- Optimized recursive chunking produces tighter, semantically-bounded chunks (~400 tokens avg)
- At retrieval, 5 retrieved chunks × 400 tokens = 2,000 context tokens per RAG query
- **Net effect: ~44% reduction in LLM input tokens per query with no change in output**

**Additional cost of chunking itself:**
- `recursive` and `structure-aware` strategies: CPU-only, no API calls. Effectively $0.
- LLM-based semantic chunking (e.g., LLM chunker with GPT-4o): significant cost at ingestion time — not recommended in this pattern.

---

## Assumptions

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Retrieved chunks per query (k) | 5 | Standard k=5 retrieval default |
| Avg chunk tokens — naive (baseline) | 800 | Common vendor default (OpenAI Assistants); [NVIDIA research](https://developer.nvidia.com/blog/finding-the-best-chunking-strategy-for-accurate-ai-responses/) found 800 + 400 overlap underperforms |
| Avg chunk tokens — optimized (this pattern) | 400 | Midpoint of 256–512 recommended range from Chroma and Weaviate research |
| Query overhead (system prompt + question) | 500 tokens input | Typical RAG system prompt + user question |
| Average output per query | 200 tokens | Short factual answer; adjust for your use case |
| Ingestion cost per document | $0 | Recursive/structure-aware chunking is CPU-only |

**"Req/day" definition:** One RAG query (retrieve context → generate answer). Not document ingestion.

---

## Cost Formulas

```
# Per-query input tokens
naive_input    = query_overhead + (k × avg_chunk_tokens_naive)
               = 500 + (5 × 800) = 4,500 tokens/query

optimized_input = query_overhead + (k × avg_chunk_tokens_optimized)
               = 500 + (5 × 400) = 2,500 tokens/query

# Daily cost (GPT-4o example)
daily_cost = (reqs/day × input_tokens × input_price) + (reqs/day × output_tokens × output_price)

naive_daily    = (reqs × 4,500 × $2.50/1M) + (reqs × 200 × $10.00/1M)
optimized_daily = (reqs × 2,500 × $2.50/1M) + (reqs × 200 × $10.00/1M)

# Savings
savings = naive_daily - optimized_daily
        = reqs × (4,500 - 2,500) × $2.50/1M
        = reqs × 2,000 × $0.0000025
        = reqs × $0.005 per day
```

---

## GPT-4o Projections ($2.50/1M input, $10.00/1M output)

| Scale | Without Pattern (naive) | With Pattern (optimized) | Savings | ROI |
|-------|------------------------|-------------------------|---------|-----|
| 1K req/day | $13.25/day | $8.25/day | **−$5.00/day** | Break-even: immediate (no setup cost) |
| 10K req/day | $132.50/day | $82.50/day | **−$50.00/day** | ~$1,500/month savings |
| 100K req/day | $1,325/day | $825/day | **−$500/day** | ~$15,000/month savings |

---

## Claude Sonnet 4.6 Projections ($3.00/1M input, $15.00/1M output)

| Scale | Without Pattern | With Pattern | Savings |
|-------|----------------|--------------|---------|
| 1K req/day | $16.50/day | $10.50/day | −$6.00/day |
| 10K req/day | $165/day | $105/day | −$60/day |
| 100K req/day | $1,650/day | $1,050/day | −$600/day |

---

## GPT-4o-mini Projections ($0.15/1M input, $0.60/1M output)

| Scale | Without Pattern | With Pattern | Savings |
|-------|----------------|--------------|---------|
| 1K req/day | $0.79/day | $0.49/day | −$0.30/day |
| 10K req/day | $7.90/day | $4.90/day | −$3.00/day |
| 100K req/day | $79/day | $49/day | −$30/day |

---

## Key Insights

**1. Savings scale linearly with request volume.** At 100K req/day, chunking optimization saves ~$500/day with GPT-4o — ~$180K/year. At 1K req/day, the $5/day savings are real but modest.

**2. LLM-based semantic chunking reverses the math.** If you use GPT-4o to chunk each document, you pay ~2,000 tokens per document at ingestion. At 1,000 docs/day: 2M tokens × $2.50/1M = $5/day just for ingestion. For most use cases, recursive chunking (CPU-only, free) performs comparably.

**3. Model choice matters for savings magnitude, not direction.** The savings percentage (~44% input reduction) is consistent across models. Claude Sonnet saves slightly more in dollar terms than GPT-4o-mini because input token pricing is higher in absolute terms.

**4. Break-even is immediate.** The pattern has no incremental setup cost (no API calls, no additional infrastructure). Any request volume shows positive ROI.

**5. These numbers assume you're currently using naive chunking.** If your current system already uses proper chunking, the improvement margin is smaller. Run a retrieval precision benchmark first to measure your actual baseline.

---

## How to Calculate for Your Own Usage

1. **Measure your current average chunk size:** Check your vector store's chunk token distribution (p50 is what you want). Compare to your `maxTokens` setting.

2. **Estimate your context token reduction:**
   ```
   token_reduction = k × (current_avg_chunk_tokens - target_avg_chunk_tokens)
   ```
   Example: k=5, reducing from 800 → 400 tokens → saves 2,000 tokens/query.

3. **Calculate daily savings:**
   ```
   savings = reqs_per_day × token_reduction × (input_price / 1_000_000)
   ```

4. **Adjust for your actual k value.** If you retrieve k=10 chunks, the savings double. If k=3, they're 40% smaller.

5. **Add output token cost:** Output tokens are unaffected by chunking strategy. Focus optimization efforts on input reduction.

6. **Account for precision improvement:** Better chunking may allow you to reduce k while maintaining recall. Reducing k from 10 to 5 is a 50% input reduction beyond the chunk size savings.

# Cost Analysis: Prompt Diffing

Prompt Diffing is infrastructure for your prompt management workflow — not something that runs in the request path. It adds cost primarily through embedding API calls used to compute semantic distance, and these costs are proportional to how often prompts change, not how many user requests you process.

## Assumptions

| Parameter | Value | Justification |
|-----------|-------|---------------|
| Average prompt length | 200 tokens | Typical system prompt: 150–300 tokens |
| Embedding model | `text-embedding-3-small` | $0.02/1M tokens; adequate for semantic distance at this scale |
| Embedding calls per diff | 2 | One per version (before and after) |
| Embedding cache hit rate | 80% | Most diffs are `latest vs. previous` — the prior version's embedding is already cached |
| Effective embedding calls per diff | 0.4 | `2 × (1 - 0.80)` cache-adjusted |
| Prompt changes per day (1K req/day system) | ~3/day | Active development; slows to 1–2/day in steady state |
| Prompt changes per day (10K req/day system) | ~5/day | More active product iteration at this scale |
| Prompt changes per day (100K req/day system) | ~8/day | Larger team, more prompts, more changes |
| LLM model for quality correlation (optional) | GPT-4o | $2.50/1M input tokens |
| Correlation eval calls | 0 | Quality correlation uses your existing monitoring metrics; no extra LLM calls |

**Note:** Prompt Diffing has no per-request costs — it only runs when a prompt changes. A system processing 100K requests/day might have only 8 prompt changes per day.

## Formulas

```
Embedding cost per diff = 2 × avg_prompt_tokens × embedding_price × (1 - cache_hit_rate)
                        = 2 × 200 × $0.00000002 × 0.20
                        = $0.0000016 per diff

Daily embedding cost = changes_per_day × cost_per_diff

Storage cost = negligible (text blobs + embeddings are kilobytes per version)

Total daily cost ≈ daily embedding cost
```

For your own numbers:
```
cost_per_diff = 2 × your_avg_prompt_tokens × $0.00000002 × (1 - your_cache_hit_rate)
daily_cost = your_changes_per_day × cost_per_diff
```

## Cost Projections

### Embedding Costs (text-embedding-3-small at $0.02/1M tokens)

| Scale | Prompt Changes/Day | Cost/Diff (cached) | Daily Embedding Cost | Monthly Cost |
|-------|-------------------|-------------------|---------------------|--------------|
| 1K req/day | 3 | $0.0000016 | ~$0.000005 | ~$0.00015 |
| 10K req/day | 5 | $0.0000016 | ~$0.000008 | ~$0.00025 |
| 100K req/day | 8 | $0.0000016 | ~$0.000013 | ~$0.0004 |

**The embedding cost is effectively zero.** Even at 100K req/day with 8 prompt changes/day, monthly embedding cost is under $0.001.

### Actual Cost Driver: Incident Prevention

The relevant cost comparison isn't embedding API cost — it's the cost of a debugging session without this pattern vs. with it.

A prompt regression that takes 2 hours to root-cause (common without version correlation) costs:
- ~$200–400 in engineering time at average SWE cost
- Plus any degraded output cost during the incident window

A single prevented incident pays for years of embedding API calls.

### Infrastructure Cost

If you run the diff computation as a microservice or sidecar:
- Storage for version content: <1MB per 1,000 versions (text is tiny)
- Storage for embeddings: ~6KB per version (1536-dimensional float32 vector)
- At 1,000 versions total: ~6MB for embeddings — negligible

## Summary Table (GPT-4o model, for README)

| Scale | Additional Cost/Day | ROI vs. No Pattern |
|-------|--------------------|--------------------|
| 1K req/day | +$0.000005/day | Prevents ~$200+ debugging sessions; ROI positive after first incident prevented |
| 10K req/day | +$0.000008/day | Same — cost is completely negligible |
| 100K req/day | +$0.000013/day | At this scale, undetected prompt regressions affect millions of outputs; cost is irrelevant |

## How to Calculate for Your Own Usage

1. **Count your prompts**: How many distinct prompts does your system use?
2. **Estimate change frequency**: How often does each prompt change per day? (Check git history or deploy logs for a week.)
3. **Measure prompt length**: Average token count per prompt (use a tokenizer on your system prompts).
4. **Apply the formula**:
   ```
   monthly_cost = prompts × changes_per_day × 30 × 2 × avg_tokens × $0.00000002 × (1 - cache_hit_rate)
   ```
5. **Compare to debugging cost**: What does your team spend per incident tracing quality regressions? If it's more than $10/month (it almost certainly is), the pattern pays for itself.

## Key Insights

- **This pattern has effectively zero marginal cost** at all request volumes — cost scales with prompt change frequency, not with request volume
- **Caching is the main lever**: if you cache embeddings per version ID (the pattern's default), each version is embedded at most once. An 80% cache hit rate cuts already-negligible costs by 4×.
- **The ROI framing is unusual**: most cost patterns trade off cost reduction vs. implementation effort. Prompt Diffing is pure infrastructure investment — its cost is so low it's essentially free, and the value is in incident prevention, not cost reduction.

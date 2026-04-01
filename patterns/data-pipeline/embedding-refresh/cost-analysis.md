# Cost Analysis: Embedding Refresh

Embedding Refresh adds periodic API cost to re-embed changed or stale documents. The key cost driver isn't the refresh infrastructure itself — it's the **re-embedding frequency × corpus size**. These projections separate the two scenarios: document-drift refresh (content changes trigger re-embedding) and model upgrade (full corpus re-embed when switching to a new model version).

---

## Assumptions

- **Average document size:** 500 tokens (typical for chunked text at ~300–800 token range)
- **Request volume ≠ refresh volume:** the 1K/10K/100K req/day scale refers to RAG query volume. Refresh volume depends on corpus change rate.
- **Change rate:** 10% of corpus changes per day (moderate for knowledge bases with daily updates)
- **Corpus size:** approximately proportional to query volume — 1K req/day ≈ 10K documents; 10K req/day ≈ 100K documents; 100K req/day ≈ 1M documents
- **OpenAI text-embedding-3-large pricing:** $0.13 / 1M tokens (current as of March 2026)
- **Model upgrade frequency:** once every 12 months (conservative)
- **Refresh overhead vs. base cost:** base LLM generation cost is separate from embedding refresh cost

---

## Embedding Model Pricing (verified March 2026)

| Model | Input tokens | Price |
|---|---|---|
| OpenAI text-embedding-3-large | $0.13 / 1M tokens | Best general-purpose quality |
| OpenAI text-embedding-3-small | $0.02 / 1M tokens | Lower quality, much cheaper |
| OpenAI text-embedding-ada-002 | $0.10 / 1M tokens | Legacy model |

*Note: Embedding costs are input-only — no output tokens. This is separate from GPT-4o / Claude generation costs.*

---

## Cost Projections: Document-Drift Refresh (Daily)

**Scenario:** 10% of corpus changes daily, triggering incremental re-embedding.

### Formula

```
Corpus size (docs) = query_volume × 10  (rough heuristic)
Daily changed docs = corpus_size × 0.10
Tokens per refresh = daily_changed_docs × 500 tokens/doc
Daily refresh cost = (tokens_per_refresh / 1,000,000) × $0.13
Annual refresh cost = daily_refresh_cost × 365
```

### Projections (text-embedding-3-large, 10% daily change rate)

| Scale | Corpus | Daily changed | Daily tokens | Daily cost | Annual cost |
|---|---|---|---|---|---|
| 1K req/day | ~10K docs | 1,000 docs | 500K tokens | $0.065 | $24/year |
| 10K req/day | ~100K docs | 10,000 docs | 5M tokens | $0.65 | $237/year |
| 100K req/day | ~1M docs | 100,000 docs | 50M tokens | $6.50 | $2,373/year |

*At text-embedding-3-small ($0.02/1M): roughly 6.5× cheaper across the board.*

---

## Cost Projections: Model Upgrade (Annual Full Re-Embed)

**Scenario:** Full corpus re-embedding once per year when switching embedding model versions.

### Formula

```
Full re-embed tokens = corpus_size × 500 tokens/doc
Full re-embed cost = (full_re_embed_tokens / 1,000,000) × $0.13
```

### Projections (one-time upgrade cost, text-embedding-3-large)

| Scale | Corpus | Total tokens | One-time upgrade cost |
|---|---|---|---|
| 1K req/day | ~10K docs | 5B tokens | $0.65 |
| 10K req/day | ~100K docs | 50B tokens | $6.50 |
| 100K req/day | ~1M docs | 500B tokens | $65 |

*Model upgrades are cheap at these scales. The engineering cost of the migration (building the shadow index pipeline) dominates, not the API cost.*

---

## README Summary Table

| Scale | Additional Cost | ROI vs. No Pattern |
|---|---|---|
| 1K req/day | +$0.065–$0.65/day | Negligible. Protects retrieval quality and enables zero-downtime model upgrades. |
| 10K req/day | +$0.65–$6.50/day | Small relative to total LLM spend. The cost of stale retrieval (user-reported errors, support volume) typically exceeds this within weeks. |
| 100K req/day | +$6.50–$65/day | Manual refresh at this scale isn't operationally viable. Refresh infrastructure is a requirement, not an optimization. |

---

## Cost Sensitivity Analysis

| Variable | Impact | Notes |
|---|---|---|
| Document change rate | Linear | If only 1% changes daily (slow-moving knowledge bases), daily cost is 10× lower |
| Document token length | Linear | 1,000-token docs → 2× the cost vs. 500-token baseline |
| Embedding model choice | 6.5× range | text-embedding-3-small is 6.5× cheaper; quality difference is domain-dependent |
| Refresh frequency | Linear | Weekly vs. daily: 7× cost difference on time-triggered refresh |
| Full re-embed frequency | Proportional | Triggered by model upgrades — typically 1–2× per year |

---

## How to Calculate for Your Own Usage

1. **Measure your corpus size:** how many chunks are stored in your vector index?
2. **Estimate your change rate:** what fraction of documents change per day/week?
3. **Choose a refresh trigger:** time-based (staleness threshold) or event-driven (document update webhook)?
4. **Calculate:**
   ```
   Daily refresh tokens = corpus_size × change_rate × avg_tokens_per_doc
   Daily refresh cost   = (daily_refresh_tokens / 1,000,000) × model_price_per_million
   ```
5. **Add upgrade cost:** multiply corpus_size × avg_tokens × model_price for each planned model migration (typically once per year)

**Example:** 50,000-doc corpus, 5% daily changes, 400 tokens/doc, text-embedding-3-large:
```
Daily: 50,000 × 0.05 × 400 = 1,000,000 tokens → $0.13/day → $47/year
Annual upgrade: 50,000 × 400 / 1,000,000 × $0.13 = $2.60 per migration
```

**Key insight:** Embedding refresh costs are dominated by corpus size and change rate — not query volume. A slow-moving 1M-doc corpus may be cheaper to maintain than a fast-moving 100K-doc corpus.

---

## Infrastructure Costs (Beyond API)

| Cost | Approximate | Notes |
|---|---|---|
| Change detection storage | Minimal | Content hashes: ~64 bytes × corpus_size. 1M docs ≈ 64MB. |
| Shadow index during migration | 2× vector store cost | Required for zero-downtime upgrade; temporary (days, not months) |
| Refresh job compute | Low | Async background job; batched API calls dominate over compute |
| Monitoring / alerting | Negligible | Staleness metrics are lightweight counters |

The infrastructure overhead is small. The major cost is API tokens for re-embedding.

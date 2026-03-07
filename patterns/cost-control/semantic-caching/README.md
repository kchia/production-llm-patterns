# Semantic Caching

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

Users ask similar questions repeatedly — not identical strings, but semantically equivalent. "What's the return policy?" and "How do I return an item?" hit the same intent. Without semantic caching, every rephrasing pays full API cost and full latency. Research suggests roughly [31% of LLM queries exhibit semantic similarity](https://arxiv.org/abs/2403.02694) to previous requests, which at scale means a significant fraction of API spend goes toward generating answers that already exist.

The cost adds up fast. At 100K requests/day with 0.05 average cost per request, a 50% cache hit rate saves ~$2,450/day — and that's before counting the latency improvement. Cache hits return in single-digit milliseconds instead of the typical 500ms–2s for a fresh LLM call.

But cost isn't the only problem. Without caching, identical questions get slightly different answers each time. For customer-facing systems, that inconsistency erodes trust: a user asks about the return policy twice and gets two different phrasings, or worse, two contradictory answers.

## What I Would Not Do

The first instinct is exact-match caching — hash the query string, look it up, done. It's simple and it works for traditional APIs. For LLM workloads, it doesn't. SHA-256 hashes give a 0% hit rate on semantic duplicates because "What's your refund policy?" and "How do I get a refund?" produce completely different hashes. The cache sits there, full of entries that never match, burning storage for zero savings.

The second instinct is to overcorrect: set a low similarity threshold (say 0.75) so the cache catches more queries. This breaks in the opposite direction. At 0.75, "sort ascending" and "sort descending" look similar enough to match — and the system returns the wrong answer with a 200 OK. In dense embedding spaces, even 0.85 can match semantically different questions with different answers. The failure is silent: no errors, no alerts, just wrong responses served confidently.

A fixed global threshold fails because embedding space density varies across query types. Code-related queries pack tightly — small semantic differences sit close together in vector space. Conversational queries are sparser — genuine paraphrases may score lower than expected. A single cutoff either catches too much garbage or misses legitimate hits, and there's no threshold that works well for both.

## When You Need This

- Query logs show significant semantic overlap — cluster a sample with embeddings and check the duplication rate
- API spend at a scale where even a 20–30% cache hit rate produces meaningful savings (typically >5K requests/day)
- Response freshness requirements allow serving cached answers for minutes to hours, not seconds
- p50 latency targets that benefit from sub-10ms cache hits versus 500ms–2s LLM calls
- Consistency matters — users seeing different answers to the same question creates support burden

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **RAG → High ROI.** RAG systems often field repetitive questions against the same knowledge base — product FAQs, documentation lookups, support queries. I'd expect meaningful hit rates here, and the latency improvement from skipping both retrieval and generation is substantial. It's not critical because the system works fine without it, but the cost-to-benefit ratio is compelling.
- **Batch → High ROI.** Batch processing often runs similar prompts across large datasets — classification, extraction, summarization of similar documents. Cache hits here directly reduce job duration and API spend. The ROI scales with dataset homogeneity.
- **Agents → Low ROI.** Agent outputs depend heavily on tool state, conversation history, and intermediate results. Two semantically identical instructions produce different outputs depending on context. Caching is possible at the sub-task level, but the hit rate is typically low enough that the embedding overhead doesn't pay for itself.
- **Streaming → N/A.** Streaming is about real-time token delivery. Serving a cached complete response defeats the streaming UX, and the freshness requirements of real-time interactions make cached responses inappropriate.

## The Pattern

### Architecture

```
          ┌───────────────────┐
          │  Incoming Query   │
          └────────┬──────────┘
                   │
        1. ┌──────▼──────┐
           │ Embed Query │
           └──────┬──────┘
                  │
        2. ┌──────▼────────────┐
           │ Vector Search     │
           │ (top-k = 1)       │
           └──────┬────────────┘
                  │
        3. ┌──────▼────────────┐
           │ Score ≥ threshold? │
           └───┬──────────┬────┘
               │          │
          YES  │          │  NO
               │          │
     4a. ┌─────▼─────┐  ┌▼──────────────┐ 4b.
         │  Return   │  │  Call LLM      │
         │  Cached   │  │  Provider      │
         │  Response │  └──┬─────────────┘
         └─────┬─────┘     │
               │     5. ┌──▼─────────────┐
               │        │ Store Entry    │
               │        │ (embedding +   │
               │        │  response)     │
               │        └──┬─────────────┘
               │           │
         ┌─────▼───────────▼──────┐
         │    Return Response     │
         └─────────┬──────────────┘
                   │
         ┌─────────▼──────────────┐
         │ Emit Metrics           │
         │ (hit/miss, latency,    │
         │  similarity score)     │
         └────────────────────────┘
```

Numerical thresholds in the diagram are illustrative — actual values depend on embedding model, query domain, and acceptable false-positive rate.

**Core abstraction**: `SemanticCache` — wraps any LLM provider call. On each request, it embeds the query, searches the vector store for a match above the similarity threshold, and either returns the cached response or calls through to the provider and caches the result.

**Interface:**

```typescript
interface SemanticCache {
  query(input: string, options?: QueryOptions): Promise<CacheResult>;
  invalidate(filter: InvalidationFilter): Promise<number>;
  stats(): CacheStats;
}

interface QueryOptions {
  similarityThreshold?: number; // Override default threshold
  ttl?: number; // TTL in seconds for this entry
  bypassCache?: boolean; // Force LLM call, still cache result
  namespace?: string; // Isolate cache by context
}
```

**Configurability:**

| Parameter             | Default       | Description                                                     |
| --------------------- | ------------- | --------------------------------------------------------------- |
| `similarityThreshold` | 0.85          | Minimum cosine similarity to count as a cache hit               |
| `ttl`                 | 3600 (1 hour) | Time-to-live for cached entries in seconds                      |
| `maxEntries`          | 10000         | Maximum cache entries before eviction                           |
| `embeddingDimensions` | 384           | Embedding vector size (must match embedding model)              |
| `evictionPolicy`      | `lru-score`   | How to evict when cache is full (LRU weighted by hit frequency) |
| `namespace`           | `"default"`   | Cache isolation key for multi-tenant or multi-prompt setups     |

These defaults are starting points. The right similarity threshold depends heavily on embedding model characteristics and query domain density. A customer FAQ system with clear intents might work well at 0.82; a code-related system where small differences matter might need 0.92+. TTL depends on how quickly your underlying data changes.

**Key design tradeoffs:**

1. **In-process vector store vs. external service.** This implementation uses an in-process vector store (simple cosine similarity over an array) to keep the pattern framework-agnostic and zero-dependency. A production deployment at scale would swap this for [Redis](https://redis.io/blog/what-is-semantic-caching/) with vector search, Qdrant, or Pinecone — the interface stays the same. The tradeoff: simplicity and portability over distributed cache sharing and horizontal scaling.

2. **Single threshold vs. per-category thresholds.** A single global threshold is simpler to configure and reason about, but research shows optimal thresholds vary by query type. The namespace mechanism provides a partial workaround — different namespaces can use different threshold overrides via `QueryOptions`. Full category-aware caching would require query classification, which adds latency and complexity.

3. **Synchronous embedding vs. async pipeline.** The embedding step runs synchronously in the request path. This adds ~5–20ms latency on every request (hit or miss). An async approach could embed in the background and only cache after the response returns, but then the first occurrence of any query always misses — and concurrent duplicates all miss too. Synchronous embedding trades a small latency floor for immediate cache population.

4. **Store full response vs. response reference.** Storing the full LLM response in the cache alongside the embedding is simple but memory-intensive. For large responses (multi-paragraph, code generation), a reference-based approach stores responses externally and keeps only metadata in the vector index. This implementation stores full responses for simplicity — the interface supports swapping storage backends without changing the cache logic.

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

How this pattern itself can fail. Every solution creates new failure modes.

| Failure Mode                                                                                                                                                                                               | Detection Signal                                                                                                                                                                                                                | Mitigation                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **False-positive cache hit** — semantically different queries score above threshold, returning wrong answers                                                                                               | User complaints about incorrect answers; spot-check audits comparing cached responses to fresh LLM output; sudden drop in downstream task accuracy                                                                              | Raise similarity threshold; add per-namespace thresholds for dense embedding regions; implement periodic sample verification against fresh LLM calls                                            |
| **Stale cache poisoning** — cached responses become incorrect as underlying data changes (policy updates, product changes, knowledge drift)                                                                | Compare cached response age against known data change events; track response accuracy over entry age; user reports of outdated information                                                                                      | TTL-based expiration; event-driven invalidation on known data changes; periodic freshness sampling where a fraction of cache hits are verified against the LLM                                  |
| **Embedding model mismatch** — updating or changing the embedding model makes all existing cache entries unsearchable (new vectors don't match old vectors)                                                | Cache hit rate drops to near zero after model change; vector dimension mismatch errors; all queries become cache misses                                                                                                         | Version cache entries with embedding model identifier; flush cache on model change; run migration to re-embed cached queries with new model                                                     |
| **Cache capacity exhaustion** — cache fills up, eviction kicks in and removes frequently-hit entries, or insertion slows down                                                                              | Memory usage alerts; insertion latency spikes; hit rate drops while query volume stays constant; eviction rate exceeds insertion rate                                                                                           | Set appropriate `maxEntries` based on query diversity; use frequency-weighted eviction (not pure LRU); monitor eviction rate vs. hit rate                                                       |
| **Similarity threshold drift (silent)** — over weeks/months, query distribution shifts so the original threshold becomes too loose or too tight, gradually degrading hit quality without triggering alerts | No immediate signal — manifests as slow accuracy degradation; detectable via periodic accuracy audits comparing a sample of cache hits against fresh LLM responses; hit rate changes without corresponding query volume changes | Scheduled accuracy audits (weekly/monthly); log similarity scores and track distribution over time; alert on significant shifts in mean similarity score of cache hits                          |
| **Namespace pollution** — queries from different contexts (different prompts, different system instructions) share the same cache namespace, returning responses generated under wrong context             | Responses reference wrong product/context; user confusion about out-of-context answers; inconsistent behavior across different system prompts                                                                                   | Use distinct namespaces per prompt template or system instruction set; include prompt version hash in namespace key; validate that cached responses were generated under current system context |

## Observability & Operations

**Key metrics:**

| Metric                    | Type                      | Description                                                                                                                            | Healthy Range                                    |
| ------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `cache.hit_rate`          | Ratio (rolling 5-min avg) | Cache hits to total queries                                                                                                            | 30–60% (diverse queries), 60–80% (FAQ workloads) |
| `cache.similarity_score`  | Histogram                 | Cosine similarity scores for cache hits. Track mean and p10. A dropping p10 indicates the threshold is catching lower-quality matches. | Mean >0.88                                       |
| `cache.latency_ms`        | Histogram (hit/miss)      | Separate histograms for cache hits and cache misses. Hits should be <10ms; misses include full LLM latency.                            | Hits <10ms                                       |
| `cache.entry_count`       | Gauge (by namespace)      | Current cache entries. Approaching `maxEntries` triggers eviction.                                                                     | <80% of maxEntries                               |
| `cache.eviction_rate`     | Rate (per minute)         | Evictions per minute. Sustained high eviction rate means the cache is too small for the query diversity.                               | <50/min                                          |
| `cache.entry_age_seconds` | Histogram                 | Ages of cache entries being served. Useful for detecting stale responses.                                                              | Within TTL bounds                                |

**Alerting:**

| Severity | Condition                                             | Window  | What It Means                                                                                                                                   |
| -------- | ----------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Warning  | Hit rate drops below 20% OR rises above 90%           | 15 min  | Below 20%: pattern may not be worth the overhead. Above 90%: suspiciously high — possible threshold misconfiguration returning false positives. |
| Warning  | Mean similarity score for cache hits drops below 0.88 | 1 hour  | Threshold might be too loose — cache is matching lower-quality results                                                                          |
| Warning  | Eviction rate exceeds 50/minute sustained             | 10 min  | Cache is undersized for query diversity                                                                                                         |
| Critical | Cache hit latency p99 exceeds 50ms                    | 5 min   | Vector search performance degradation — check entry count and memory                                                                            |
| Critical | Cache entry count drops to 0 unexpectedly             | Instant | Cache cleared or process crash — verify infrastructure health                                                                                   |

These thresholds are starting points — adjust based on your baseline hit distribution, SLA requirements, and traffic profile. A system with naturally low query diversity might have a healthy hit rate of 15%.

- **Runbook:**
  - **Hit rate drop:** Check if query distribution has changed (new feature, new user segment). Check if embedding model was updated (invalidates all cached embeddings). Check if TTL is too short for the workload. Verify cache infrastructure is healthy (Redis connection, memory).
  - **High eviction rate:** Increase `maxEntries` if memory allows. Check for bot traffic or crawler queries inflating unique query count. Consider per-namespace entry limits.
  - **High false-positive rate (user complaints about wrong cached answers):** Raise `similarityThreshold` by 0.03–0.05 increments. Review the similarity score distribution — if scores cluster just above the threshold, the threshold is in the "grey zone." Consider per-namespace thresholds for dense embedding domains.
  - **Latency spike on cache hits:** Check cache entry count — linear scan slows at very high entry counts (>10K). Check for memory pressure or GC pauses. Consider switching to an approximate nearest neighbor index.

## Tuning & Evolution

**Tuning levers:**

| Parameter               | Safe Range                | Effect                                                                                                                                                            | Dangerous Extreme                                                                                               |
| ----------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `similarityThreshold`   | 0.83–0.90                 | Lower catches more hits but risks false positives                                                                                                                 | Below 0.80 risks serving wrong answers; above 0.95 approaches exact-match behavior and misses valid paraphrases |
| `ttl`                   | 300–86400s                | Shorter TTL means fresher responses but lower hit rates. FAQ workloads: 3600–86400s. Time-sensitive data: 300–1800s.                                              | 0 (effectively disables caching) or no TTL (serves arbitrarily stale responses)                                 |
| `maxEntries`            | 1000–100000               | Sized to your unique query cardinality                                                                                                                            | Too small: constant eviction, low hit rate. Too large: memory pressure, slow searches without ANN indexing.     |
| `namespace` granularity | Per-feature or per-prompt | Coarse (one namespace per app) gives higher hit rates but risks cross-context pollution. Fine (one per prompt template version) is safer but fragments the cache. | Single namespace for all contexts (pollution risk) or namespace per user (fragments cache entirely)             |

- **Drift signals:**
  - Hit rate trending down over weeks without traffic changes — query distribution is shifting away from cached patterns
  - Mean similarity score of cache hits trending down — the threshold is catching lower-quality matches as the embedding space fills
  - Increasing user complaints about incorrect or outdated answers — stale cache or false positive rate is climbing
  - Embedding model updated by provider — all cached embeddings are potentially invalid
  - Review cadence: weekly check on hit rate and similarity score distribution; monthly spot-check of cache hit quality against fresh LLM responses

- **Silent degradation:**
  - **Month 3:** The underlying data has changed (product catalog updates, policy revisions) but the cache still serves old answers. TTL handles this partially, but content that changes on irregular schedules slips through. Responses are technically "correct" per the cache but factually outdated. Detection: periodic freshness audits comparing cached responses to fresh LLM output on a random sample.
  - **Month 6:** Query patterns have shifted significantly — new features, new user demographics. The cache is full of entries that match old query patterns. Hit rate looks stable but the entries being hit are increasingly irrelevant. The similarity scores are high (same old queries matching same old entries) but the cache isn't serving the new traffic well. Detection: track hit rate segmented by query recency — if only old queries hit the cache, the cache isn't adapting.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed projections across GPT-4o, Claude Sonnet, and GPT-4o-mini at three scales.

| Scale        | Additional Cost (GPT-4o)              | ROI vs. No Pattern                        |
| ------------ | ------------------------------------- | ----------------------------------------- |
| 1K req/day   | -$1.44/day savings, but $5 infra cost | Not worth it — infra exceeds savings      |
| 10K req/day  | -$9.87/day net savings                | Break-even at 35% hit rate, solid at 50%+ |
| 100K req/day | -$143.75/day net savings              | 29x return on infra — clear win           |

## Testing

See test files in `src/ts/__tests__/index.test.ts`. Run with `cd src/ts && npm test`.

- **Unit tests (16):** cosine similarity math, config defaults and overrides, cache hit/miss behavior, namespace isolation, TTL expiration, invalidation by namespace and timestamp, eviction under capacity pressure, per-query threshold and bypass options
- **Failure mode tests (6):** false-positive cache hit at high threshold, stale cache poisoning via TTL, embedding model version mismatch, cache capacity exhaustion, similarity threshold drift detection via stats, namespace pollution prevention
- **Integration tests (3):** full cache lifecycle (cold start → hits → invalidation → re-population), concurrent query safety with 10 parallel requests, LLM error propagation (errors not cached)

## When This Advice Stops Applying

| Condition                                                                                        | Why Caching Doesn't Fit                                                                                                                               |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Personalized outputs** — recommendation engines, personalized coaching, user-specific analysis | Same question should yield different answers per user. Caching here serves one user's answer to another.                                              |
| **Real-time data dependencies** — stock prices, live scores, inventory counts                    | Underlying facts change between identical queries. TTLs help but can't fully solve this; the cache can only be as fresh as its invalidation strategy. |
| **Low-volume systems** (under ~1K requests/day)                                                  | Embedding compute, vector storage, and operational overhead cost more than the API savings. The break-even math just doesn't work.                    |
| **Creative applications** — brainstorming tools, creative writing assistants, content generation | Output diversity is a feature. Caching actively harms the product by returning the same creative output twice.                                        |
| **Rapidly evolving models or prompts**                                                           | Cached responses from the old prompt/model contaminate results. The invalidation burden becomes the dominant operational cost.                        |

## Companion Content

- Blog post: [Semantic Caching — Deep Dive](https://prompt-deploy.com/semantic-caching) (coming soon)
- Related patterns:
  - [Token Budget Middleware](../token-budget-middleware/) — caching reduces spend, complementing budget enforcement
  - [Model Routing](../model-routing/) — routing and caching both reduce cost; routing by choosing cheaper models, caching by avoiding calls entirely
  - [Latency Budget](../../performance/latency-budget/) — cache hits dramatically improve latency
  - [Embedding Refresh](../../data-pipeline/embedding-refresh/) — stale embeddings affect cache similarity matching
  - [Regression Testing](../../testing/regression-testing/) — validates that cache responses remain accurate over time

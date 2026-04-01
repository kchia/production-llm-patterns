# Embedding Refresh

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

Embeddings go stale in two distinct ways, and both are invisible until retrieval quality has already degraded.

The first is **document drift**: your source documents update — policy pages get revised, product details change, support articles are rewritten — but the vector store still holds embeddings from the old versions. Retrieval returns outdated information. The LLM doesn't know its context is stale. The user gets a confidently wrong answer.

The second is **model incompatibility**: a better embedding model releases and you want to upgrade. But you can't mix embedding models in the same index. Cosine similarity is only reliable when comparing vectors from the same model trained in the same geometric space. If you re-embed even a fraction of your corpus with the new model while the rest stays on the old one, similarity scores become unreliable — directions and neighborhood structures shift, and approximate nearest neighbor indexes built for the old geometry search the wrong space.

Neither failure triggers an alert. Latency looks fine. The LLM is responding. Retrieval precision is collapsing — but p99 doesn't know that.

The economics are concrete: one production RAG deployment reported that [re-embedding a 1TB corpus weekly cost $12,000/month](https://medium.com/@eyosiasteshale/the-refresh-trap-the-hidden-economics-of-vector-decay-in-rag-systems-f73bc15aa011) just to maintain freshness — a cost that arrives only after the team discovers their refresh pipeline is the only way to stay current. That's one production cost of not building refresh infrastructure from the start.

## What I Would Not Do

The naive approach is to treat embeddings as write-once. Embed your corpus at ingestion time, build the index, ship it. If something seems off, re-embed everything.

The problem with that approach surfaces in a few ways:

**Full re-embed on every change** becomes unworkable fast. Re-embedding a 1TB corpus weekly can run to $12,000/month in API costs just to maintain freshness. At smaller scales, the math is friendlier — but the operational pattern is the same: no incremental strategy means the refresh job grows linearly with corpus size, and eventually the nightly job doesn't finish before the next one starts.

**No model version tracking** means you can't do a zero-downtime model upgrade. When you want to switch from `text-embedding-ada-002` to `text-embedding-3-large`, you discover you have no metadata about which model generated which vectors. You can't do a phased migration. You rebuild from scratch with an availability gap.

**Rolling updates into a live index** is the most dangerous naive move. If you re-embed some documents with the new model and leave others on the old one, you're now comparing vectors from incompatible geometric spaces. The index is silently corrupted — everything still responds, but [similarity scores are meaningless across the model boundary](https://medium.com/data-science-collective/different-embedding-models-different-spaces-the-hidden-cost-of-model-upgrades-899db24ad233).

I'd be uncomfortable shipping a RAG system without at least tracking which model version produced each embedding and having a refresh path that doesn't require full downtime.

## When You Need This

- Your source documents change on any regular cadence — weekly policy updates, daily product catalog changes, even monthly procedure revisions
- You're planning to upgrade to a newer or better-fit embedding model in the next 6–12 months (which is almost always true)
- Your RAG system has been running for more than 3–4 months without a refresh and document staleness is a plausible concern
- Retrieval quality has declined without obvious prompt or pipeline changes — stale embeddings are a likely culprit
- You're approaching a corpus size where full re-embedding costs start to matter (roughly 1M+ chunks, depending on model pricing)
- Multiple teams or pipelines contribute documents to the same index — without refresh coordination, staleness windows accumulate unevenly

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **RAG → Required.** Retrieval is the ceiling. I wouldn't want to get paged on a RAG system where the vector store hasn't been refreshed in months and I have no staleness metrics to even know the answer to "how stale is it?" The system runs without this, but it's not production-ready.
- **Batch → Required.** Batch jobs often process large corpora over hours or days. Without refresh coordination, a batch run can interleave old and new embeddings, silently corrupting similarity calculations mid-job. I'd want refresh lifecycle management in place before running batch at scale.
- **Agents → Optional.** Agents use retrieval opportunistically. Staleness still matters, but agents typically have other quality signals (tool call results, user corrections) that surface problems faster than pure RAG. Worth implementing, but not the first thing I'd reach for.
- **Streaming → N/A.** Streaming is about token delivery latency, not retrieval freshness. Embedding refresh doesn't apply here.

## The Pattern

### Architecture

The core idea is to separate the **staleness detection** problem from the **re-embedding execution** problem, and to run them on independent schedules. Detection is cheap and can run frequently. Re-embedding is expensive and should run only when staleness thresholds are crossed or model versions change.

```
Source Documents
       │
       ▼
┌─────────────────────────────────────────┐
│  1. Change Detector (runs frequently)   │
│     Hash / timestamp vs. stored         │
│     fingerprints                        │
│                                         │
│     unchanged doc ──► skip              │
│     changed doc    ──► enqueue  ─────►  │
└─────────────────────────────────────────┘
                                    │ Stale doc IDs
                                    ▼
                         ┌─────────────────────┐
                         │  2. Refresh Queue   │
                         │     (batched)       │
                         └──────────┬──────────┘
                                    │ Batches of doc IDs
                                    ▼
                         ┌─────────────────────┐
                         │  3. Embedding Model  │
                         │     (versioned)      │
                         └──────────┬──────────┘
                                    │ Vectors + model_version
                                    ▼
                         ┌─────────────────────┐
                         │  4. Vector Store     │
                         │     (upsert by ID)   │
                         └──────────┬──────────┘
                                    │ (side channel)
                                    ▼
                         ┌─────────────────────┐
                         │  Freshness Tracker   │
                         │  last_refreshed_at   │
                         │  model_version       │
                         │  staleness_score     │
                         └─────────────────────┘
```

*Illustrative flow — staleness thresholds and scoring depend on corpus change velocity and acceptable freshness windows.*

**Model upgrade path** (zero-downtime):

```
Live Index (model v1)       Shadow Index (model v2)
       │                            │
       │ ── serve queries ─────────►│ (traffic stays on v1)
       │                            │◄── re-embed corpus (background)
       │                            │
       │    coverage check          │
       │    v2 >= 99.9%? ──── NO ──►│ (keep re-embedding)
       │                   │
       │                  YES
       │                   │
       └── swap index ptr ─┘ v2 becomes live
       keep v1 for rollback (N days)
```

### Core Abstraction

```typescript
interface EmbeddingRefreshConfig {
  embeddingModel: string;           // model identifier, e.g. "text-embedding-3-large"
  modelVersion: string;             // semantic version for migration tracking
  stalenessThresholdDays: number;   // refresh if last_refreshed > N days ago (default: 7)
  batchSize: number;                // documents per embedding API call (default: 100)
  maxConcurrentBatches: number;     // parallel API calls (default: 4)
  hashAlgorithm: 'md5' | 'sha256';  // document fingerprint algorithm (default: 'sha256')
}

interface DocumentRecord {
  id: string;
  content: string;
  contentHash: string;              // fingerprint of current content
  lastRefreshedAt: Date;
  embeddingModelVersion: string;    // which model produced this vector
  embedding?: number[];
}

interface RefreshResult {
  refreshed: number;
  skipped: number;
  failed: number;
  durationMs: number;
  stalenessByModel: Record<string, number>; // count of docs per model version
}
```

**Configurability:**

| Parameter | Default | Effect | Dangerous extreme |
|---|---|---|---|
| `stalenessThresholdDays` | 7 | How old before forced refresh | Too low → expensive; too high → stale content |
| `batchSize` | 100 | Docs per API call | Too large → timeouts; too small → high request overhead |
| `maxConcurrentBatches` | 4 | Parallel embedding calls | Too high → rate limits; too low → slow refresh |
| `hashAlgorithm` | 'sha256' | Fingerprint for change detection | 'md5' → faster but higher collision risk |

*Defaults are starting points. Staleness threshold depends on how frequently your source content changes; batch size depends on your embedding provider's rate limits and document sizes.*

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

| Failure Mode | Detection Signal | Mitigation |
| --- | --- | --- |
| **Mixed model versions in live index** — partial re-embed leaves old and new vectors coexisting; similarity scores become unreliable across the model boundary | `stalenessByModel` shows >1 distinct `embeddingModelVersion`; retrieval quality scores diverge between "old" and "new" document segments | Enforce atomic model upgrades: never upsert new-model vectors into a live index; use shadow index pattern with full-corpus cutover |
| **Change detection misses content updates** — if only hash is checked but metadata changes (author, timestamp) don't alter content hash, semantically important updates go undetected | `last_refreshed_at` is recent but retrieval returns stale facts; user-reported factual errors on recently-updated documents | Include metadata fields in hash computation; implement time-bounded refresh as a fallback regardless of hash match |
| **Refresh job timeout on large corpus** — batched re-embedding of large corpora exceeds job scheduler limits; job is killed mid-run, leaving partial updates | Job duration metrics; `stalenessByModel` shows inconsistent version coverage; refresh completion rate < 100% | Checkpoint progress by document ID; design refresh as restartable — query which docs still need refresh and resume from there |
| **Embedding API rate limiting during bulk refresh** — concurrent batch refresh exhausts embedding provider rate limits; retries with backoff amplify total duration | 429 errors in refresh job logs; refresh batch latency spikes; `failed` count in `RefreshResult` is non-zero | Implement exponential backoff per batch; reduce `maxConcurrentBatches`; schedule large refreshes during off-peak hours |
| **Silent staleness accumulation (6-month failure)** — documents accumulate without triggering staleness threshold because content hash didn't change, but the *context* they live in shifted (new competing products, changed regulations, deprecated features); embeddings are technically current but semantically outdated | No direct signal — this is the invisible failure. Catch it via periodic retrieval quality evaluation against known-good query sets; if retrieval precision drops without document hash changes, context-staleness is the likely cause | Schedule full corpus refresh quarterly regardless of hash state; implement semantic drift detection (compare embedding centroids over time); treat "no changes detected" for more than 3 months as a signal to investigate, not celebrate |
| **Shadow index promotion before full coverage** — model upgrade completes re-embedding of 80% of corpus; promotion is triggered prematurely; 20% of queries hit missing vectors | Coverage metric in shadow index refresh job; promote only when `refreshed / total_documents >= 0.999`; validate with test query set before promotion | Gate promotion on explicit coverage threshold check; run holdout query set against shadow index before cutover |

## Observability & Operations

**Key metrics:**

| Metric | Unit | Collection | What it signals |
|---|---|---|---|
| `embedding_refresh_staleness_p50` / `p95` | days | Gauge, per corpus | How old the average / tail embedding is |
| `embedding_refresh_stale_doc_count` | count | Gauge | Documents past the staleness threshold |
| `embedding_refresh_model_version_coverage` | fraction (0–1) | Gauge, per model version | Progress of model upgrade migrations |
| `embedding_refresh_batch_duration_p99` | ms | Histogram | Slow batches → rate limiting or large docs |
| `embedding_refresh_failed_count` | count | Counter | API errors during re-embedding |
| `embedding_refresh_job_completion_rate` | fraction | Gauge | Whether scheduled jobs finish before the next one starts |

**Alerting:**

| Alert | Threshold | Severity | Notes |
|---|---|---|---|
| `stale_doc_count` high | > 5% of corpus | Warning | Refresh job may be falling behind |
| `stale_doc_count` critical | > 20% of corpus | Critical | Retrieval quality is measurably impacted at this level |
| `model_version_coverage` mixed | < 1.0 for > 24h during migration | Warning | Partial migration is active; don't leave it unresolved |
| `failed_count` non-zero | > 0 over 1h window | Warning | API errors in refresh; investigate before they accumulate |
| `job_completion_rate` low | < 1.0 for 2+ consecutive runs | Critical | Job isn't finishing; next run compounds the backlog |
| `staleness_p95` too low | < 0.5 days | Warning | Refreshing too aggressively; check if cost/frequency is justified |

*These thresholds are starting points. How quickly staleness matters depends on how frequently your source content changes and how freshness-sensitive your use case is.*

**Runbook:**

When `stale_doc_count` critical fires:
1. Check `job_completion_rate` — if < 1.0, the refresh job isn't finishing. Check job logs for timeouts or OOM.
2. Check `failed_count` — if elevated, check embedding API status and rate limit headroom.
3. Run `SELECT COUNT(*), embedding_model_version FROM document_records GROUP BY embedding_model_version` — if multiple model versions appear, a migration may have stalled mid-way.
4. If job is completing but staleness is still high, the staleness threshold may be too loose relative to content change velocity. Reduce `stalenessThresholdDays` or move to event-driven refresh.
5. For emergency: trigger a manual full refresh, prioritizing documents with the oldest `last_refreshed_at`.

## Tuning & Evolution

**Tuning levers:**

| Lever | Safe range | Dangerous extreme | When to adjust |
|---|---|---|---|
| `stalenessThresholdDays` | 1–30 days | < 1 day (cost spike) or > 60 days (semantic drift risk) | Lower when source content changes frequently; raise for mostly-static corpora |
| `batchSize` | 50–200 docs | > 500 (timeout risk) or < 10 (request overhead dominates) | Tune based on average document token length and provider batch limits |
| `maxConcurrentBatches` | 2–8 | > 16 (rate limit exhaustion) | Scale up only after verifying provider rate limits |
| Refresh schedule | Hourly to weekly | Sub-hourly for large corpora | Set based on acceptable staleness window, not arbitrary defaults |

**Drift signals:**

- Retrieval quality scores (recall@k against evaluation sets) declining without document hash changes — context staleness, not content staleness
- `staleness_p95` creeping up week-over-week despite the job running — corpus is growing faster than refresh capacity
- Multiple model versions appearing in `stalenessByModel` for more than 48 hours — model migration is stuck
- Refresh job duration approaching the scheduling interval — need to scale concurrency or move to incremental/event-driven triggering

**Silent degradation:**

At Month 3: The refresh job is running, hash-based change detection is working, and freshness metrics look fine. But a category of documents that used to be authoritative is now stale in a way that doesn't change the text hash — they reference products, policies, or procedures that have changed *elsewhere* in the corpus but the documents themselves haven't been edited. Retrieval returns these documents confidently. The LLM generates answers based on a world model that's three months out of date in specific, non-obvious ways.

At Month 6: The embedding model used at launch has been superseded by two generations. The performance gap is measurable on your domain. But migration requires a full corpus re-embed and a shadow index rollout. Without having built the infrastructure for this at the start, the path is a painful weekend of downtime rather than a background job.

Proactive check: Run a monthly retrieval quality evaluation against a curated query set with known-good answers. This is the only reliable early warning for semantic staleness that doesn't change the document hash.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers.

| Scale | Additional Cost | ROI vs. No Pattern |
| --- | --- | --- |
| 1K req/day | +$0.15–$2.40/day | Protects retrieval quality; cost depends heavily on corpus size and change rate |
| 10K req/day | +$1.50–$24/day | Required for production-grade RAG; cost of stale retrieval exceeds refresh infrastructure |
| 100K req/day | +$15–$240/day | Amortized cost is small relative to total LLM spend; manual refresh at this scale isn't viable |

## Testing

How to verify this pattern works correctly. See test files in `src/ts/` and `src/py/`.

- **Unit tests:** Hash-based change detection correctly identifies changed vs. unchanged documents; staleness scoring returns correct values; model version metadata is persisted with each upsert; batch splitting handles edge cases (empty corpus, single doc, large corpus)
- **Failure mode tests:** Mixed model version detection; partial refresh job (simulated timeout at 50% coverage); API rate limit handling with backoff; shadow index promotion blocked when coverage < threshold; silent staleness accumulation test (content hash unchanged but semantic context shifted)
- **Integration tests:** End-to-end refresh cycle with mock embedding provider; model upgrade path from v1 to v2 via shadow index with zero-downtime promotion; incremental refresh processes only changed docs; full corpus refresh restarts cleanly from checkpoint after simulated failure

Run: `cd src/ts && npm test` / `cd src/py && python -m pytest`

## When This Advice Stops Applying

- Static document collections that genuinely never change — embeddings don't go stale, and refresh infrastructure adds cost with no benefit
- Systems not using vector retrieval — if you're not embedding, this pattern doesn't apply
- One-time analysis jobs where freshness doesn't matter — process once and discard
- Small corpora (< ~10K chunks) where full re-embedding takes seconds and costs pennies — at that scale, the incremental machinery may be more complex than just re-embedding everything on every change
- Very high-frequency document updates (sub-minute) where event-driven refresh is the only viable model — the batch-and-schedule approach described here doesn't fit streaming document ingestion at that cadence

## Companion Content

- Blog post: [Embedding Refresh — Deep Dive](https://prompt-deploy.com/embedding-refresh) (coming soon)
- Related patterns:
  - [Chunking Strategies](../chunking-strategies/) (#19, S6) — re-chunking triggers re-embedding; changing chunk boundaries requires full index rebuild
  - [Index Maintenance](../index-maintenance/) (#30, S8) — refresh and maintenance are the two pillars of RAG data health; refresh keeps content current, maintenance keeps the index performant
  - [Drift Detection](../../observability/drift-detection/) (#28, S8) — detects when stale embeddings cause retrieval quality drift at the output level
  - [Semantic Caching](../../cost-control/semantic-caching/) (#12, S4) — stale embeddings affect cache similarity matching; cache invalidation strategy needs to account for embedding refresh cycles

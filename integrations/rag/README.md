# Integration Guide: RAG Systems

> **Part of [Production LLM Patterns](../../README.md).** This guide shows which patterns to combine for RAG systems, in what order to adopt them, and how they wire together in practice.

A RAG system is a pipeline: documents go in, get chunked and embedded, land in a vector store, get retrieved on query, and feed a language model that generates the final answer. Each hand-off is a failure surface. The output quality ceiling is bounded by the weakest step in the chain — and a few steps (chunking, retrieval) tend to dominate the others. Because all the intermediate steps are invisible to users, quality problems accumulate silently before anyone notices.

The way I'd think about RAG in production: it's not one system, it's three loosely coupled subsystems that each need their own reliability layer. The **data pipeline** (chunking → embedding → index) determines what's retrievable. The **retrieval layer** (vector search → context assembly) determines what the model sees. The **generation layer** (prompt → LLM → output validation) determines what the user receives. A failure in any one collapses the whole thing, but the failure mode in each looks different.

---

## Pattern Priority for RAG

These designations come from the [Navigation Matrix](../../README.md#navigation-matrix). The way I'd read these tables: **Critical** goes in before launch, **Required** should be in place before I'd be comfortable being paged, **High ROI** pays back quickly once the foundation is solid, **Recommended** is solid practice once those are in place, and **Optional** depends on the specific deployment.

### Critical — absence risks outages or data integrity failures

| Pattern | Why for RAG |
|---------|-------------|
| [Chunking Strategies](../../patterns/data-pipeline/chunking-strategies/) | Sets the output quality ceiling. Wrong chunk boundaries = wrong embeddings = wrong retrieval. Everything downstream compounds this. |

### Required — the system runs without it, but it's not production-ready

| Pattern | Why for RAG |
|---------|-------------|
| [Structured Output Validation](../../patterns/safety/structured-output-validation/) | RAG outputs drive downstream logic. A parsed JSON response that fails silently breaks the integration, not the RAG system itself. |
| [PII Detection](../../patterns/safety/pii-detection/) | Retrieved context may contain PII that gets echoed into responses. The retrieval layer creates a new exposure surface you don't have in pure generation systems. |
| [Prompt Injection Defense](../../patterns/safety/prompt-injection-defense/) | Documents in a RAG corpus are untrusted input. Malicious content embedded in retrieved chunks can hijack the generation step. |
| [Structured Tracing](../../patterns/observability/structured-tracing/) | Debugging a bad answer requires knowing which documents were retrieved, what similarity scores they had, and how the prompt was assembled. Without traces, you're guessing. |
| [Token Budget Middleware](../../patterns/cost-control/token-budget-middleware/) | Context window costs scale with retrieved chunk count. Without token budgeting, a query matching many documents can balloon to many multiples of expected cost per request — the worst cases I've seen are queries that match the entire top of the index. |
| [Eval Harness](../../patterns/testing/eval-harness/) | RAG quality can't be verified by running unit tests on code. You need an evaluation framework that scores retrieval quality, answer relevance, and faithfulness to source. |
| [Graceful Degradation](../../patterns/resilience/graceful-degradation/) | When the vector store is slow or the LLM provider is down, the system needs a defined fallback — keyword search, cached responses, or a "service degraded" response. |
| [Output Quality Monitoring](../../patterns/observability/output-quality-monitoring/) | Retrieval quality and generation quality are two separate failure surfaces. I wouldn't want to get paged on a quality degradation without knowing which layer failed. |
| [Drift Detection](../../patterns/observability/drift-detection/) | Three things drift in RAG: the model (provider updates), the input distribution (query patterns shift), and the corpus (documents update). Without detection, all three are invisible. |
| [Prompt Version Registry](../../patterns/observability/prompt-version-registry/) | RAG prompts change frequently as you tune retrieval depth, formatting, and instructions. Without versioning, you can't correlate a quality change to the prompt update that caused it. |
| [Online Eval Monitoring](../../patterns/observability/online-eval-monitoring/) | CI evals cover curated test cases. Production traffic is messier. Online monitoring catches the long-tail failures that offline suites miss. |
| [Regression Testing](../../patterns/testing/regression-testing/) | Every chunking change, embedding model upgrade, or prompt update is a regression risk. RAG quality is fragile across prompt and data changes in ways that traditional software testing doesn't surface. |
| [Prompt Rollout Testing](../../patterns/testing/prompt-rollout-testing/) | Prompt changes in RAG systems interact with retrieval in non-obvious ways. Rolling out a new prompt to 5% of traffic first prevents quality surprises from reaching all users. |
| [Embedding Refresh](../../patterns/data-pipeline/embedding-refresh/) | Documents update. Embedding models improve. Without refresh infrastructure, the vector store drifts from reality — silently, since latency looks fine. |
| [Index Maintenance](../../patterns/data-pipeline/index-maintenance/) | Tombstones and fragmentation accumulate. After three months of document churn, index recall drops measurably. The degradation is invisible until you look for it. |
| [Latency Budget](../../patterns/performance/latency-budget/) | RAG adds at least two serial hops (embedding + vector search) before the LLM call. Without a latency budget, a slow retrieval step silently blows through your SLA. |
| [Concurrent Request Management](../../patterns/performance/concurrent-request-management/) | Every RAG query makes multiple API calls (embedding, optionally multiple retrieval calls, LLM). Without concurrency management, fan-out requests amplify load during traffic spikes. |

### High ROI — pays back quickly once the foundation is solid

| Pattern | Why for RAG |
|---------|-------------|
| [Semantic Caching](../../patterns/cost-control/semantic-caching/) | RAG systems field repetitive questions against the same knowledge base. Cache hits skip both retrieval and generation — the cost savings stack. |
| [Request Batching](../../patterns/performance/request-batching/) | If your RAG pipeline processes documents at ingestion (chunking → embedding in bulk), batching embedding calls cuts API costs and latency significantly. |

### Recommended — solid engineering practice when the foundation is in place

| Pattern | Why for RAG |
|---------|-------------|
| [Retry with Budget](../../patterns/resilience/retry-with-budget/) | Provider errors happen. Embedding API timeouts during ingestion and LLM rate limits during generation both benefit from budget-bounded retry. |
| [Multi-Provider Failover](../../patterns/resilience/multi-provider-failover/) | If retrieval and generation depend on the same provider, an outage takes both down simultaneously. Failover adds more complexity than it's worth early on. |
| [Circuit Breaker](../../patterns/resilience/circuit-breaker/) | Useful once you're at a scale where a degraded downstream service (vector DB, embedding provider) can cascade into widespread failures. |
| [Model Routing](../../patterns/cost-control/model-routing/) | Some RAG queries are simple factual lookups; others need complex reasoning. Routing simple queries to a cheaper model can halve generation costs without user-visible quality change. |
| [Prompt Diffing](../../patterns/observability/prompt-diffing/) | When a prompt change shifts retrieval behavior or output quality, diffing the active vs. previous version is the fastest way to localize the cause. Pairs naturally with Prompt Version Registry. |
| [Adversarial Inputs](../../patterns/testing/adversarial-inputs/) | RAG injection attacks (document poisoning, prompt-embedded instructions) are a real threat category. Worth building adversarial test cases once the production system is stable. |
| [Context Management](../../patterns/data-pipeline/context-management/) | As retrieved chunks approach the context window limit, assembly strategy matters. Relevant when chunk counts are high or documents are long. |
| [Cost Dashboard](../../patterns/cost-control/cost-dashboard/) | Once token budget middleware is in place, a dashboard makes per-query and per-day costs visible to stakeholders who care about spend. |
| [Snapshot Testing](../../patterns/testing/snapshot-testing/) | Catching unexpected output format changes. Useful when downstream consumers parse RAG outputs programmatically. |

### Optional — context-dependent

| Pattern | Why for RAG |
|---------|-------------|
| [Human-in-the-Loop](../../patterns/safety/human-in-the-loop/) | For high-stakes RAG deployments (medical, legal, financial), routing low-confidence responses to human review is worth the operational complexity. |

---

## System Architecture

```
   User Query
       │
       ▼
┌─────────────────────────────────────────────────────────────────────┐
│  A. Semantic Cache (High ROI)                                       │
│     cosine-match query → return cached answer if hit               │
└─────────────────────────────┬───────────────────────────────────────┘
                              │ cache miss
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  B. Query Processing                                                │
│     1. Prompt Injection Defense — scan query for embedded commands │
│     2. PII Detection — redact or flag PII in the query             │
│     3. Token Budget — establish context window budget for session   │
└─────────────────────────────┬───────────────────────────────────────┘
                              │ clean query
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  C. Retrieval (Data Pipeline Layer)                                 │
│     1. Embed query (Latency Budget: track embedding latency)        │
│     2. Vector Search → top-k chunks (Index Maintenance: healthy)   │
│     3. Context Assembly (Token Budget: fit chunks to window)        │
└─────────────────────────────┬───────────────────────────────────────┘
                              │ assembled context
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  D. Generation                                                      │
│     1. Prompt Version Registry — load versioned prompt template    │
│     2. LLM call (Graceful Degradation: fallback on failure)        │
│     3. Structured Output Validation — parse + repair + validate    │
│     4. PII Detection (output) — check for PII in generated answer  │
└─────────────────────────────┬───────────────────────────────────────┘
                              │ validated response
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  E. Observability (Side Channel)                                   │
│     Structured Tracing — full span: query → chunks → answer        │
│     Output Quality Monitoring — score answer against context        │
│     Drift Detection — observe input + output distributions          │
│     Token Budget — record actual spend vs. budget                  │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                         Answer + Metadata
```

```
   Document Ingestion Pipeline (offline / scheduled)

   Source Documents
       │
       ▼
┌─────────────────────────────────────────────────────┐
│  1. Chunking Strategies                             │
│     Format-aware parsing → strategy selection       │
│     → chunks with metadata                         │
└───────────────────┬─────────────────────────────────┘
                    │ chunks
                    ▼
┌─────────────────────────────────────────────────────┐
│  2. Embedding Refresh (versioned, change-detected)  │
│     Hash comparison → stale detection               │
│     → batch embedding API calls (Request Batching)  │
└───────────────────┬─────────────────────────────────┘
                    │ vectors + model_version metadata
                    ▼
┌─────────────────────────────────────────────────────┐
│  3. Vector Store Write                              │
└───────────────────┬─────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────┐
│  4. Index Maintenance (scheduled)                   │
│     Tombstone cleanup → segment compaction          │
│     → payload index optimization                   │
└─────────────────────────────────────────────────────┘
```

---

## Adoption Sequence

The way I'd sequence these: start with what determines correctness (data pipeline), then add what prevents breakage (safety + resilience), then layer in visibility (observability), then quality measurement (testing), then optimization (cost/performance).

Skipping ahead to optimization before observability is a common mistake. Tuning what you can't measure just produces confident wrong numbers.

### Phase 1 — Data Foundation (Week 1–2)

Get the retrieval layer right before anything else. Bad chunks can't be recovered by better prompts.

1. **[Chunking Strategies](../../patterns/data-pipeline/chunking-strategies/)** — Start with recursive chunking (the default), not fixed-size. Tune `maxTokens` and `overlapTokens` against a sample of your actual document corpus before ingesting at scale.
2. **[Structured Output Validation](../../patterns/safety/structured-output-validation/)** — Add output parsing and repair from day one. LLMs don't always produce valid JSON. Retrying with error context is cheaper than debugging mysterious downstream failures.

**What you have:** Documents ingest correctly, outputs parse correctly. The core pipeline functions.

### Phase 2 — Safety Baseline (Week 2–3)

RAG creates specific safety exposure: retrieved documents are untrusted input that reaches the generation step.

3. **[PII Detection](../../patterns/safety/pii-detection/)** — Add to both the retrieval path (detecting PII in retrieved context) and the output path (detecting PII in generated answers). The retrieval path is the new exposure surface.
4. **[Prompt Injection Defense](../../patterns/safety/prompt-injection-defense/)** — Scan retrieved chunks for embedded instructions before assembling the prompt. Document corpora are under your control but not always your authorship.

**What you have:** The pipeline is safe to run on real document corpora and serve real users.

### Phase 3 — Observability Foundation (Week 3–4)

Start measuring before you start optimizing. You'll need traces to debug the first production issue.

5. **[Structured Tracing](../../patterns/observability/structured-tracing/)** — Instrument the full request span: query embedding, retrieval scores, chunk selection, prompt assembly, generation, output validation. The debugging payoff on the first confusing production answer is immediate.
6. **[Token Budget Middleware](../../patterns/cost-control/token-budget-middleware/)** — Set budgets for context assembly (max chunks × avg chunk tokens) and generation (max output tokens). Unbounded RAG queries can run many multiples over expected cost on edge cases — a single high-recall query that pulls the whole top of the index is enough to wreck a daily budget.
7. **[Eval Harness](../../patterns/testing/eval-harness/)** — Build a curated test set: 50–100 query/expected-answer pairs covering your core use cases. This is the baseline you'll use to verify every subsequent change.

**What you have:** Visibility into what the system is doing and a baseline to measure against.

### Phase 4 — Production Resilience (Month 1)

The system will encounter provider failures, slow vector searches, and rate limits.

8. **[Graceful Degradation](../../patterns/resilience/graceful-degradation/)** — Define fallback behavior: keyword search if vector search is down, cached responses if the LLM is unavailable, explicit "service degraded" messaging rather than silent failures.
9. **[Latency Budget](../../patterns/performance/latency-budget/)** — RAG has at least three serial latency contributors: embedding, retrieval, and generation. Setting explicit budgets per phase lets you catch SLA violations before users notice.
10. **[Retry with Budget](../../patterns/resilience/retry-with-budget/)** — Add bounded retries on embedding API calls and LLM generation. A 10% rate-limit rate without retries shows up as a 10% error rate for users.

**What you have:** The system handles the expected failure modes gracefully. Ready for production traffic.

### Phase 5 — Quality Monitoring (Month 2)

Quality degrades quietly. These patterns catch it before it reaches users.

11. **[Output Quality Monitoring](../../patterns/observability/output-quality-monitoring/)** — Score production responses for answer relevance and faithfulness to retrieved context. Separates generation failures from retrieval failures.
12. **[Drift Detection](../../patterns/observability/drift-detection/)** — Track input distributions (are users asking different kinds of questions?), output distributions (are response lengths or formats shifting?), and model behavior (is the same query getting different answers?).
13. **[Embedding Refresh](../../patterns/data-pipeline/embedding-refresh/)** — Add staleness tracking to your ingestion pipeline. At minimum, track which model version produced each embedding and when documents were last re-embedded.
14. **[Index Maintenance](../../patterns/data-pipeline/index-maintenance/)** — Schedule a weekly maintenance run: tombstone cleanup, segment compaction. Takes minutes but prevents the month-three recall degradation.

**What you have:** Quality problems surface in monitoring, not user complaints. The data pipeline stays healthy over time.

### Phase 6 — Testing Coverage (Month 2–3)

Prevent regressions as the system evolves.

15. **[Prompt Version Registry](../../patterns/observability/prompt-version-registry/)** — Version every prompt template. Correlate quality changes to the prompt version that was active when they occurred.
16. **[Regression Testing](../../patterns/testing/regression-testing/)** — Run your eval harness on every prompt change, embedding model update, and chunking configuration change. RAG quality is non-monotonic — improvements in one area often degrade others.
17. **[Prompt Rollout Testing](../../patterns/testing/prompt-rollout-testing/)** — Route 5–10% of traffic to the new prompt version before full rollout. Prompt changes interact with retrieval in non-obvious ways.
18. **[Online Eval Monitoring](../../patterns/observability/online-eval-monitoring/)** — Extend your eval harness to score a sample of production traffic. The gap between CI eval performance and production performance is where the real reliability risks live.
19. **[Concurrent Request Management](../../patterns/performance/concurrent-request-management/)** — RAG queries fan out to multiple API calls. Under load, unmanaged concurrency causes cascading timeouts and rate-limit errors.

**What you have:** Changes can be made confidently. Quality is monitored in both offline and online contexts.

### Phase 7 — Optimization (Quarter 1+)

Once the foundation is solid, optimize for cost and performance.

20. **[Semantic Caching](../../patterns/cost-control/semantic-caching/)** — Check your query logs first. Cluster a sample with embeddings to measure actual duplication rate. If it's above 20%, the ROI is compelling — cache hits skip retrieval and generation entirely.
21. **[Request Batching](../../patterns/performance/request-batching/)** — If your ingestion pipeline runs frequently (hourly or daily), batch embedding calls. The API cost reduction is significant at any corpus size above a few thousand documents.
22. **[Model Routing](../../patterns/cost-control/model-routing/)** — Once you have quality monitoring and a curated eval set, route lower-complexity queries (factual lookups, simple classifications) to a cheaper model. The hard part is defining "complexity" in a way that's measurable.

---

## Wiring Guide

These snippets show how the patterns compose. They use the actual implementations from this repo — no framework wrappers.

### TypeScript: Core RAG Request Flow

```typescript
import { ChunkingPipeline } from '../../patterns/data-pipeline/chunking-strategies/src/ts/index.js';
import { SemanticCache } from '../../patterns/cost-control/semantic-caching/src/ts/index.js';
import { OutputValidator } from '../../patterns/safety/structured-output-validation/src/ts/index.js';
import { TokenBudgetMiddleware } from '../../patterns/cost-control/token-budget-middleware/src/ts/index.js';
import { Tracer } from '../../patterns/observability/structured-tracing/src/ts/index.js';

// Wire up the components once at startup
const cache = new SemanticCache(embeddingProvider, llmProvider, {
  similarityThreshold: 0.92,
  ttl: 3600,     // 1 hour — tune based on corpus update frequency
  maxEntries: 5000,
});

const tokenBudget = new TokenBudgetMiddleware({
  maxInputTokens: 8000,   // leaves room for system prompt + user query
  maxOutputTokens: 1500,
});

const tracer = new Tracer({ serviceName: 'rag-service' });
const validator = new OutputValidator({ maxRetries: 2 });

// Per-request handler
async function handleRagQuery(userQuery: string): Promise<RAGResponse> {
  const span = tracer.startSpan('rag.query', { query: userQuery });

  try {
    // 1. Check semantic cache first
    const cacheResult = await cache.query(userQuery);
    if (cacheResult.cacheHit) {
      span.setAttributes({ 'cache.hit': true, 'cache.similarity': cacheResult.similarityScore });
      span.end();
      return cacheResult.response;
    }

    // 2. Embed + retrieve
    const retrievalSpan = tracer.startSpan('rag.retrieval', {}, span);
    const queryEmbedding = await embeddingProvider.embed(userQuery);
    const chunks = await vectorStore.search(queryEmbedding, { topK: 10 });
    retrievalSpan.setAttributes({
      'retrieval.chunks_found': chunks.length,
      'retrieval.top_score': chunks[0]?.score ?? 0,
    });
    retrievalSpan.end();

    // 3. Fit chunks within token budget
    const budget = tokenBudget.allocate({ systemPrompt: SYSTEM_PROMPT, userQuery });
    const selectedChunks = budget.fitChunks(chunks);  // trims to fit window

    // 4. Generate with validation
    const prompt = assemblePrompt(SYSTEM_PROMPT, selectedChunks, userQuery);
    const rawResponse = await llmProvider.generate(prompt);
    const validated = await validator.validate(rawResponse, RAGResponseSchema);

    span.setAttributes({
      'generation.tokens_used': validated.tokenCount,
      'generation.validation_attempts': validated.attempts,
    });

    return validated.data;
  } catch (err) {
    span.recordError(err);
    throw err;
  } finally {
    span.end();
  }
}
```

### TypeScript: Ingestion Pipeline (Chunking + Refresh)

```typescript
import { ChunkingPipeline } from '../../patterns/data-pipeline/chunking-strategies/src/ts/index.js';
import { EmbeddingRefresher } from '../../patterns/data-pipeline/embedding-refresh/src/ts/index.js';
import { IndexMaintainer } from '../../patterns/data-pipeline/index-maintenance/src/ts/index.js';

const chunker = new ChunkingPipeline({
  maxTokens: 512,
  overlapTokens: 50,
  strategy: 'recursive',  // 'structure-aware' for mixed document types
});

const refresher = new EmbeddingRefresher(embeddingProvider, {
  modelVersion: 'text-embedding-3-large',
  batchSize: 100,          // embed 100 chunks per API call
  checksumField: 'sha256', // detect content changes
});

const maintainer = new IndexMaintainer(vectorStore, {
  tombstoneThreshold: 0.15,  // trigger vacuum at 15% deleted vectors
  maxSegments: 20,
  schedule: 'weekly',
});

// Ingest a new or updated document
async function ingestDocument(doc: Document): Promise<void> {
  // 1. Chunk with format detection
  const { chunks } = chunker.process(doc.content, {
    sourceId: doc.id,
    docType: 'auto',  // detect: prose, markdown, code, html
  });

  // 2. Check which chunks are new or changed
  const { stale, unchanged } = await refresher.detectChanges(chunks);

  if (stale.length === 0) return;  // nothing changed

  // 3. Batch-embed stale chunks
  const embedded = await refresher.embedBatch(stale);

  // 4. Upsert to vector store with model version metadata
  await vectorStore.upsert(embedded.map(e => ({
    id: e.chunkId,
    vector: e.embedding,
    payload: { ...e.metadata, modelVersion: refresher.modelVersion },
  })));
}

// Maintenance job (run weekly via cron)
async function runMaintenance(): Promise<void> {
  const report = await maintainer.runCycle();
  logger.info('Index maintenance complete', {
    tombstonesBefore: report.tombstoneRatioBefore,
    tombstonesAfter: report.tombstoneRatioAfter,
    segmentsBefore: report.segmentCountBefore,
    segmentsAfter: report.segmentCountAfter,
  });
}
```

### Python: Core RAG Request Flow

```python
from patterns.data_pipeline.chunking_strategies.src.py import ChunkingPipeline, ChunkingConfig
from patterns.cost_control.semantic_caching.src.py import SemanticCache, SemanticCacheConfig
from patterns.safety.structured_output_validation.src.py import OutputValidator
from patterns.observability.structured_tracing.src.py import Tracer

# Wire up at startup
cache = SemanticCache(
    embedding_provider=embedding_provider,
    llm_provider=llm_provider,
    config=SemanticCacheConfig(
        similarity_threshold=0.92,
        ttl=3600,        # 1 hour
        max_entries=5000,
    ),
)

tracer = Tracer(service_name="rag-service")
validator = OutputValidator(max_retries=2)

async def handle_rag_query(user_query: str) -> RAGResponse:
    with tracer.span("rag.query", query=user_query) as span:
        # 1. Semantic cache
        cache_result = await cache.query(user_query)
        if cache_result.cache_hit:
            span.set_attributes(cache_hit=True, similarity=cache_result.similarity_score)
            return cache_result.response

        # 2. Embed + retrieve
        with tracer.span("rag.retrieval", parent=span) as retrieval_span:
            query_embedding = await embedding_provider.embed(user_query)
            chunks = await vector_store.search(query_embedding, top_k=10)
            retrieval_span.set_attributes(
                chunks_found=len(chunks),
                top_score=chunks[0].score if chunks else 0,
            )

        # 3. Fit within token budget (simple greedy selection)
        selected_chunks = fit_chunks_to_budget(chunks, max_tokens=8000)

        # 4. Generate with validation
        prompt = assemble_prompt(SYSTEM_PROMPT, selected_chunks, user_query)
        raw_response = await llm_provider.generate(prompt)
        validated = await validator.validate(raw_response, RAGResponseSchema)

        span.set_attributes(
            tokens_used=validated.token_count,
            validation_attempts=validated.attempts,
        )

        return validated.data
```

### Python: Ingestion Pipeline

```python
from patterns.data_pipeline.chunking_strategies.src.py import ChunkingPipeline, ChunkingConfig, DocumentMetadata
from patterns.data_pipeline.embedding_refresh.src.py import EmbeddingRefresher, RefreshConfig
from patterns.data_pipeline.index_maintenance.src.py import IndexMaintainer, MaintenanceConfig

chunker = ChunkingPipeline(ChunkingConfig(
    max_tokens=512,
    overlap_tokens=50,
    strategy="recursive",
))

refresher = EmbeddingRefresher(
    embedding_provider=embedding_provider,
    config=RefreshConfig(
        model_version="text-embedding-3-large",
        batch_size=100,
    ),
)

maintainer = IndexMaintainer(
    vector_store=vector_store,
    config=MaintenanceConfig(
        tombstone_threshold=0.15,
        max_segments=20,
    ),
)

async def ingest_document(doc: Document) -> None:
    # 1. Chunk with auto-detected format
    result = chunker.process(
        doc.content,
        DocumentMetadata(source_id=doc.id),
    )

    # 2. Detect stale/new chunks
    stale, _ = await refresher.detect_changes(result.chunks)
    if not stale:
        return

    # 3. Batch-embed stale chunks
    embedded = await refresher.embed_batch(stale)

    # 4. Upsert to vector store
    await vector_store.upsert([
        {"id": e.chunk_id, "vector": e.embedding, "payload": e.metadata}
        for e in embedded
    ])

# Run weekly
async def run_maintenance() -> None:
    report = await maintainer.run_cycle()
    logger.info("Maintenance complete: tombstones %s→%s, segments %s→%s",
        report.tombstone_ratio_before, report.tombstone_ratio_after,
        report.segment_count_before, report.segment_count_after,
    )
```

---

## Tradeoffs

### What to skip early

**Semantic Caching** — the implementation is simple, but the operational overhead of managing cache invalidation when documents update isn't trivial. I'd wait until you have evidence of a meaningful duplication rate in your query logs before adding it.

**Model Routing** — routing decisions need quality signal to calibrate. Without output quality monitoring already running, you can't verify that simple queries are actually being handled well by the cheaper model. Add this after quality monitoring is in place.

**Multi-Provider Failover** — the added complexity (second provider contract, fallback response quality differences, routing logic) isn't worth it until you've experienced provider outages and know their actual frequency and duration.

**Adversarial Inputs testing** — building adversarial test cases requires understanding your actual threat model. Skip until the system is stable and you have a sense of which attack surfaces are actually exposed.

**Human-in-the-Loop** — adds significant operational complexity (routing infrastructure, review queue, response latency). Only worth it if you're in a domain (medical, legal, financial) where a wrong answer has serious consequences and you can justify the cost.

### What to add at scale

**Circuit Breaker** — at low request volumes, a slow downstream service is annoying but survivable. At 10K+ requests/day, a degraded vector store causes cascading timeouts that take down the whole system. Add this once your traffic justifies it.

**Request Batching for queries** — the `Request Batching` pattern is primarily valuable for ingestion (embedding large corpora). At query time, batching only makes sense if you're processing RAG queries in bulk (batch analytics, nightly report generation). For real-time query serving, per-request concurrency management matters more.

**Cost Dashboard** — becomes valuable once multiple stakeholders care about API spend. Early on, `Token Budget Middleware` metrics are sufficient. A full dashboard adds value when you need to track spend by tenant, feature, or query type.

### Where patterns create tension

**Semantic Caching vs. Embedding Refresh.** When documents update and you re-embed them, cached responses that referenced the old document content become stale. The cache TTL needs to be shorter than your embedding refresh cycle — or you need a cache invalidation hook tied to the document update pipeline. Without this coordination, the cache serves answers based on outdated context.

**Token Budget vs. Retrieval Quality.** Cutting retrieved chunks to fit the token budget improves cost but reduces context. A tight budget that truncates to 3 chunks when 8 are needed is worse than a slightly more generous budget. The right balance depends on your average query complexity — set the budget based on your eval harness results, not an arbitrary token count.

**Prompt Rollout Testing vs. Latency.** A/B routing adds a small overhead per request. At the 5–10% experimental traffic volumes typical of prompt rollouts, the impact is negligible. At high experimental traffic fractions (50%+), the routing logic becomes a non-trivial part of per-request latency.

**Online Eval Monitoring vs. Latency.** Scoring production responses with an LLM judge (the most reliable quality signal) adds latency. The solution is async scoring — sample requests are scored after the response is returned, not in the critical path. If you're doing inline scoring, it adds 200–500ms to sampled requests.

**Index Maintenance vs. Availability.** Vacuum and compaction operations briefly degrade query performance while running. Schedule them during off-peak hours and test maintenance behavior under load before enabling in production.

---

## Related Guides

- [Agent Systems Integration Guide](../agents/) — many production RAG deployments are also agentic. If your RAG system can call tools or take multi-step actions, check the Agents guide for the additional patterns that apply.
- [Batch Systems Integration Guide](../batch/) — if your RAG pipeline runs offline jobs (nightly document ingestion, bulk query processing), the Batch guide covers the additional patterns relevant there.

## Companion Content

- **[Mental Models for Production AI](https://prompt-deploy.beehiiv.com/archive?tags=Mental+Models+for+Production+AI)** — the broader series this guide draws from. Useful background on the reasoning behind why certain patterns get sequenced before others.
- **[Prompt Deploy](https://prompt-deploy.com)** — companion blog posts for each individual pattern referenced above.
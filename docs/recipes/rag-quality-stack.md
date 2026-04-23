# Recipe: RAG Quality Stack

> **Patterns combined:** [Chunking Strategies](../../patterns/data-pipeline/chunking-strategies/) + [Output Quality Monitoring](../../patterns/observability/output-quality-monitoring/) + [Regression Testing](../../patterns/testing/regression-testing/)

A RAG system has two independent failure surfaces: retrieval quality and generation quality. Both degrade silently. Chunking strategies set the ceiling on retrieval quality — wrong chunk boundaries mean wrong embeddings mean wrong context. Output quality monitoring catches generation drift in production. Regression testing is the CI gate that prevents prompt changes from silently degrading either surface. Together, these three cover the full quality lifecycle: ingestion, deployment, and continuous monitoring.

---

## When This Combination Makes Sense

The symptoms that point toward this stack:

- Users report answers that are "close but wrong" — the right topic retrieves but the wrong detail surfaces
- Retrieval recall looks fine (right documents found) but precision is low (wrong chunks within those documents)
- A prompt update improved one query category but silently degraded another
- Production quality is lower than offline eval suggests — the gap keeps widening
- The document corpus has grown or changed type (new PDFs, added code files) since chunking was initially configured

Each pattern addresses a different quality failure mode. Chunking fixes structural retrieval failures at the data layer. Regression testing prevents generation regressions at the CI layer. Output quality monitoring catches what both miss in the production layer.

---

## How the Three Patterns Compose

These patterns operate at different stages of the RAG lifecycle, not as a request-time composition stack:

| Stage | Pattern | When It Runs | What It Owns |
|---|---|---|---|
| Ingestion | Chunking Strategies | Document ingest pipeline | Retrieval quality ceiling |
| CI / Deploy | Regression Testing | Every prompt change | Generation quality gate |
| Production | Output Quality Monitoring | Continuous sampling | Quality drift over time |

### Architecture

```
Document Corpus
      │
      ▼
┌─────────────────────────────┐
│    Chunking Pipeline         │
│  detect format (MD/PDF/code)│
│  structure-aware split      │
│  validate chunk quality     │
│  embed + index              │
└─────────────────────────────┘
      │
      ▼
   Vector Index (quality ceiling set here)
      │
      │          ┌──────────────────────────┐
      │          │  Regression Test Suite   │  ← runs in CI on every prompt change
      │          │  (50+ RAG eval cases)    │
      │          │  score vs. baseline      │
      │          │  block merge on delta    │
      │          └──────────────────────────┘
      │
      ▼
User Query → Retrieve chunks → Generate response
                                      │
                                      ▼
                          ┌───────────────────────────┐
                          │  Output Quality Monitor   │  ← always running
                          │  sample 5–10% of traffic  │
                          │  score faithfulness,      │
                          │  relevance, completeness  │
                          │  alert on drift           │
                          └───────────────────────────┘
```

---

## Wiring Code

### TypeScript

```typescript
import { ChunkingPipeline } from '../patterns/data-pipeline/chunking-strategies/src/ts/index.js';
import { RegressionTestRunner } from '../patterns/testing/regression-testing/src/ts/index.js';
import { OutputQualityMonitor } from '../patterns/observability/output-quality-monitoring/src/ts/index.js';

// ── Ingestion: Structure-Aware Chunking ───────────────────────────────

const chunker = new ChunkingPipeline({
  strategies: {
    markdown: { maxChunkSize: 1200, preserveHeadings: true },
    code: { maxChunkSize: 800, language: 'auto' },
    pdf: { maxChunkSize: 1000, preserveTables: true },
    plaintext: { maxChunkSize: 600, sentenceBoundary: true },
  },
  overlap: 120,     // character overlap between chunks for context continuity
  onChunkCreated: (chunk) => {
    // Validate chunk quality before indexing.
    if (chunk.text.length < 50) {
      console.warn(`Suspiciously short chunk: ${chunk.id} (${chunk.text.length} chars)`);
    }
  },
});

async function ingestDocument(document: RawDocument): Promise<void> {
  const chunks = await chunker.chunk(document);
  const embeddings = await batchEmbed(chunks.map((c) => c.text));
  await vectorStore.upsert(
    chunks.map((chunk, i) => ({
      id: chunk.id,
      vector: embeddings[i],
      metadata: { source: document.id, format: chunk.format },
    }))
  );
}

// ── CI Gate: Regression Testing ───────────────────────────────────────

const regressionRunner = new RegressionTestRunner({
  testSuite: loadRAGEvalSuite('evals/rag-cases.jsonl'),
  // RAG-specific judge: scores faithfulness (does answer match retrieved context?)
  // and relevance (does it address the question?).
  judge: async (input, output, context) => {
    const faithfulness = await scoreFaithfulness(output, context.retrievedChunks);
    const relevance = await scoreRelevance(input.query, output);
    return (faithfulness + relevance) / 2;
  },
  regressionThreshold: 0.04,    // 4 percentage point drop triggers failure
  categories: ['factual', 'procedural', 'comparative', 'edge-case'],
});

// Called from CI on every prompt or retrieval config change.
export async function runRegressionGate(
  promptVersion: string,
  baselineVersion: string
): Promise<RegressionReport> {
  const report = await regressionRunner.compare({
    baseline: baselineVersion,
    candidate: promptVersion,
  });

  if (report.hasRegression) {
    const failing = report.categories
      .filter((c) => c.delta < -0.04)
      .map((c) => `${c.name}: ${(c.delta * 100).toFixed(1)}%`)
      .join(', ');
    throw new Error(`RAG regression: ${failing}`);
  }

  return report;
}

// ── Production: Output Quality Monitoring ─────────────────────────────

const qualityMonitor = new OutputQualityMonitor({
  sampleRate: 0.08,
  metrics: [
    { name: 'faithfulness', weight: 0.5 },    // answer grounded in retrieved context
    { name: 'relevance', weight: 0.3 },        // answer addresses the question
    { name: 'completeness', weight: 0.2 },     // answer covers key aspects
  ],
  alertThreshold: 0.10,
  onAlert: (alert) => {
    sendAlert({
      title: `RAG quality degradation: ${alert.metric}`,
      current: alert.currentScore,
      baseline: alert.baselineScore,
    });
  },
});

// Main RAG handler with monitoring.
export async function ragQuery(
  query: string
): Promise<{ answer: string; sources: string[] }> {
  // Retrieve and generate.
  const chunks = await vectorStore.search(query, { topK: 5 });
  const answer = await generateAnswer(query, chunks);

  // Sample for quality monitoring — async, doesn't block the response.
  qualityMonitor
    .sampleAndScore(
      { query },
      { answer, retrievedChunks: chunks }
    )
    .catch(console.error);

  return { answer, sources: chunks.map((c) => c.metadata.source) };
}
```

### Python

```python
from patterns.data_pipeline.chunking_strategies.src.py import ChunkingPipeline, ChunkingConfig
from patterns.testing.regression_testing.src.py import RegressionTestRunner, RegressionConfig
from patterns.observability.output_quality_monitoring.src.py import OutputQualityMonitor, MonitorConfig

# ── Ingestion: Structure-Aware Chunking ───────────────────────────────

chunker = ChunkingPipeline(
    config=ChunkingConfig(
        strategies={
            "markdown": {"max_chunk_size": 1200, "preserve_headings": True},
            "code": {"max_chunk_size": 800, "language": "auto"},
            "pdf": {"max_chunk_size": 1000, "preserve_tables": True},
            "plaintext": {"max_chunk_size": 600, "sentence_boundary": True},
        },
        overlap=120,
    )
)

async def ingest_document(document: dict) -> None:
    chunks = await chunker.chunk(document)
    embeddings = await batch_embed([c["text"] for c in chunks])
    await vector_store.upsert([
        {"id": c["id"], "vector": e, "metadata": {"source": document["id"]}}
        for c, e in zip(chunks, embeddings)
    ])

# ── CI Gate: Regression Testing ───────────────────────────────────────

regression_runner = RegressionTestRunner(
    config=RegressionConfig(
        test_suite=load_rag_eval_suite("evals/rag-cases.jsonl"),
        judge=lambda inp, out, ctx: score_rag_output(inp, out, ctx),
        regression_threshold=0.04,
        categories=["factual", "procedural", "comparative", "edge-case"],
    )
)

async def run_regression_gate(
    prompt_version: str, baseline_version: str
) -> dict:
    report = await regression_runner.compare(
        baseline=baseline_version,
        candidate=prompt_version,
    )
    if report.has_regression:
        failing = [
            f"{c.name}: {c.delta * 100:.1f}%"
            for c in report.categories
            if c.delta < -0.04
        ]
        raise RuntimeError(f"RAG regression: {', '.join(failing)}")
    return report

# ── Production: Output Quality Monitoring ─────────────────────────────

quality_monitor = OutputQualityMonitor(
    config=MonitorConfig(
        sample_rate=0.08,
        metrics=[
            {"name": "faithfulness", "weight": 0.5},
            {"name": "relevance", "weight": 0.3},
            {"name": "completeness", "weight": 0.2},
        ],
        alert_threshold=0.10,
        on_alert=lambda a: send_alert(
            f"RAG quality: {a.metric} at {a.current_score:.2f} "
            f"(baseline: {a.baseline_score:.2f})"
        ),
    )
)

async def rag_query(query: str) -> dict:
    chunks = await vector_store.search(query, top_k=5)
    answer = await generate_answer(query, chunks)
    # Non-blocking quality sample.
    asyncio.create_task(
        quality_monitor.sample_and_score(
            {"query": query},
            {"answer": answer, "retrieved_chunks": chunks},
        )
    )
    return {"answer": answer, "sources": [c["metadata"]["source"] for c in chunks]}
```

---

## What to Watch

### Metrics to Track

| Metric | What It Signals | Alert If |
|---|---|---|
| `chunk.avg_length` by doc type | Chunking effectiveness | < 200 chars (over-fragmented) or > 1500 (under-split) |
| `chunk.split_inside_code_block` | Parser correctness | > 0% (code fence not detected) |
| `regression.category_delta` | Per-category quality change | Any category drops > 4% |
| `regression.absolute_score` trend | Long-term quality trajectory | 90-day trend declining > 10% |
| `quality.faithfulness` p50 | Answer grounding | < 0.80 (answers not grounded in retrieved context) |
| `quality.relevance` p50 | Retrieval effectiveness | < 0.75 (retrieved context doesn't match the question) |
| `quality.score` by query_type | Per-category production quality | Any category drops > 8% from baseline |

### Combined Failure Modes

**Chunk boundary regression after corpus expansion.** A new document type is ingested — say, CSV exports added alongside existing Markdown. The chunker uses the plaintext strategy on CSVs, splitting on sentence boundaries that don't exist. Retrieval precision for CSV-sourced answers drops. This doesn't show up in regression tests (the eval set predates the new document type) and online monitoring shows a quality drop only after enough queries hit the affected documents. Add document-type coverage to the regression eval suite every time a new format is ingested.

**Stale regression baseline after major prompt revision.** A significant prompt rewrite improves quality across the board. The team updates the prompt and saves the new scores as the baseline. Three months later, a small edit causes a 5% regression, but the absolute score is still higher than the original baseline. The CI gate passes (delta is fine) but the absolute score trend in online monitoring shows week-over-week decline. Track absolute score trends in the monitoring system separately from regression deltas.

**Faithfulness drift from index staleness.** The vector index contains embeddings generated months ago. Source documents have been updated (product pricing changed, policy revised). Retrieved chunks are stale, so answers cite outdated facts with full confidence. Faithfulness score (answer matches retrieved context) stays high because the answer faithfully reflects the stale chunks — but accuracy against ground truth is falling. Track index age alongside faithfulness. Consider [Embedding Refresh](../../patterns/data-pipeline/embedding-refresh/) and [Index Maintenance](../../patterns/data-pipeline/index-maintenance/) for the full RAG data lifecycle.

**Silent quality erosion in low-volume query categories.** Online monitoring samples 8% of traffic. A category that represents 3% of queries produces only 0.24% of quality samples — too few for statistical significance. A regression in that category runs undetected for weeks. Track per-category sample counts in the monitor and escalate sampling rate for low-volume but high-stakes categories.

### Runbook: Quality Alert

1. Check `quality.faithfulness` first — if faithfulness is low, the problem is in retrieval (chunks or embeddings), not generation.
2. If faithfulness is fine but `quality.relevance` is low, the retrieval is returning context that doesn't match the query — check `chunk.avg_length` and split strategy for the relevant document type.
3. If both are fine but overall quality is low, the problem is in generation — run the regression gate against the current prompt and check for a recent change.
4. Pull a sample of low-scoring queries from the monitor and review the retrieved chunks manually — often faster than debugging metrics.

---

## Tension Between Patterns

**Chunk size vs. retrieval precision.** Larger chunks capture more context per embedding, which helps with long-form questions. Smaller chunks are more precise for targeted lookups. There's no universal answer — I'd start with 800–1200 characters for prose, run retrieval precision evals across your query distribution, and adjust per document type. The regression test suite should include precision-sensitive cases before you lock in any configuration.

**Regression threshold vs. model variance.** LLM judge scores have natural variance (±2–3%) across runs on the same inputs. A 4% regression threshold means borderline cases can flip between pass and fail based on judge sampling noise. Running the eval suite 3× and averaging reduces this, at the cost of 3× CI runtime. I'd start with single-run evals and tighten the threshold once the CI failure rate from false positives is measured.

**Sampling rate and coverage.** 8% of 10K queries/day is 800 quality samples — statistically robust for aggregate trends. But if queries span 20 distinct task types, some categories see only 40 samples/day. Stratified sampling (ensure minimum coverage per category) is more valuable than pure random sampling once the system handles diverse query types.

---

## Related Recipes

- [Safe Prompt Iteration](./safe-prompt-iteration.md) — the prompt deployment pipeline that complements the CI regression gate here
- [Cost Control Stack](./cost-control-stack.md) — semantic caching can be layered on top of the RAG query path
- [Resilience Stack](./resilience-stack.md) — provider outage handling for the generation step

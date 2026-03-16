# Chunking Strategies

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

Poor chunking silently destroys retrieval quality — and most teams don't notice until users are already complaining. A fixed-size chunker set to 500 characters splits code blocks mid-statement, cuts sentences in half, and severs table cells from their headers. Each fragment produces an embedding that represents a grammatical accident, not a semantic unit. The retrieval layer dutifully finds these fragments; the LLM gets them as context and either hallucinates a coherent answer or returns something technically accurate but contextually wrong.

The failure is quiet. Recall metrics may look adequate — the right document is retrieved — but precision collapses because the wrong chunk within that document surfaces. A [clinical RAG benchmark](https://pmc.ncbi.nlm.nih.gov/articles/PMC12649634/) (PMC12649634) illustrates the stakes: fixed-size chunking produced 13% task accuracy while adaptive topic-aware chunking reached 87% (p = 0.001, Cohen's d = 1.03). That's not a tuning difference — that's a system that doesn't work versus one that does.

More broadly, industry analyses estimate that up to 70% of RAG failures originate before the LLM is ever called — in retrieval and context assembly, not generation. Chunking sits at the root of that 70%.

The other failure mode is context rot. Retrieving many small fragments to compensate for poor chunking fills the context window with noise. Even before hitting the token limit, model performance degrades — earlier context gets ignored, hallucination rates climb, and answers grow vague. Bigger context windows don't fix this; better chunks are the only fix.

## What I Would Not Do

The first instinct is to reach for fixed-size character splitting — split every document into N-character chunks with some overlap. It's the default in most libraries, it requires no configuration decisions, and it works fine in demos. The problem is that real documents aren't uniform prose.

A 500-character fixed split on a Markdown document containing a code block, a table, and a paragraph will shred all three. The code block becomes two fragments — neither of which is valid. The table header gets separated from its rows. The paragraph starts mid-sentence. Each resulting embedding represents a structural accident. The retrieval model was never trained on this kind of fragment, so the vector similarity scores become unreliable: semantically distant content gets high similarity because the embedding is confused, and semantically relevant content scores low because the fragment lacks context.

The specific production condition that exposes the flaw is heterogeneous document types at scale. In demos, you're usually chunking a single clean document. In production, you have PDFs (with headers, footers, and tables), Markdown files, HTML pages, code files, and CSV exports — all being chunked by the same naive splitter. [NVIDIA's 2024 benchmark](https://developer.nvidia.com/blog/finding-the-best-chunking-strategy-for-accurate-ai-responses/) found that even the common vendor default of 800 tokens with 400 overlap "yielded particularly weak efficiency scores despite adequate recall," meaning you're paying token costs for chunks that don't actually help. I'd also avoid treating chunking as a one-time setup decision — chunk quality drifts as your document corpus evolves, and a strategy tuned for technical documentation degrades when product marketing copy gets ingested with the same splitter.

## When You Need This

- Your system retrieves context from a document corpus before generating — any RAG pattern at all
- Users report answers that are "close but wrong" — the right topic surfaces but the wrong detail
- Your document corpus mixes types: prose, code, tables, PDFs with headers, Markdown with nested structure
- Retrieval precision (not just recall) is below target — relevant documents found but wrong chunks surfacing
- You're about to ingest a new document type that differs structurally from your existing corpus
- Your chunk settings were decided once at project start and have never been revisited

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **RAG → Critical.** The entire system's output ceiling is set by chunk quality. Wrong boundaries mean wrong embeddings mean wrong retrieval — no amount of prompt engineering recovers from fundamentally misrepresented chunks. I wouldn't ship a RAG system without deliberate chunking strategy.
- **Batch → Optional.** Batch pipelines ingesting documents for downstream indexing benefit from structure-aware chunking, but they tolerate reprocessing if quality proves inadequate. Not a blocker — I'd notice the gap within the first month of batch quality reviews.
- **Agents → Recommended.** Relevant when the agent has a document retrieval component, which most production agents do. Pure tool-using agents with no RAG lookup don't chunk documents at all, but agents that retrieve context benefit significantly from coherent chunks.
- **Streaming → N/A.** Streaming is about token delivery, not document ingestion. Doesn't apply.

## The Pattern

### Architecture

```
Documents (PDF, MD, HTML, code, plain text)
        │
        ▼
┌── 1. Document Parser ─────────────┐
│   (format-aware extraction)       │ → text + structure elements
│   headings, fences, tables        │   per detected doc type
└───────────────┬───────────────────┘
                │ structured elements
                ▼
┌── 2. Strategy Selector ───────────┐
│  ┌──────────┐  ┌───────────────┐  │ picks algorithm based on
│  │FixedSize │  │  Recursive    │  │ detected doc type
│  └──────────┘  └───────────────┘  │
│  ┌──────────┐  ┌───────────────┐  │
│  │Sentence  │  │StructureAware │  │
│  └──────────┘  └───────────────┘  │
└───────────────┬───────────────────┘
                │ (strategy, elements)
                ▼
┌── 3. Chunker ─────────────────────┐
│   chunk() → Chunk[]               │ enforces maxTokens,
│                                   │ overlap, minChunkTokens
└───────────────┬───────────────────┘
                │ raw chunks
                ▼
┌── 4. Metadata Enricher ───────────┐
│   sourceId, position, headings,   │ attaches provenance per
│   totalChunks, pageNumber         │ chunk for retrieval + citation
└───────────────┬───────────────────┘
                │ enriched chunks
                ▼
            Chunk[]
  { text, tokens, metadata }
        │
        ├── Embedding API
        └── Vector Store
```

_Token estimates (maxTokens, overlapTokens) are illustrative defaults — actual values depend on your embedding model's optimal input size and retrieval precision requirements._

### Core Abstraction

```typescript
interface ChunkingStrategy {
  chunk(text: string, metadata: DocumentMetadata): Chunk[];
}

interface Chunk {
  text: string;
  tokens: number;
  metadata: ChunkMetadata;
}

interface ChunkMetadata {
  sourceId: string; // Document identifier
  position: number; // Chunk index within document
  totalChunks: number; // Total chunks for this document
  headings: string[]; // Heading hierarchy at this position
  pageNumber?: number; // For paginated sources
  overlap: {
    // Overlap context
    prevChars: number;
    nextChars: number;
  };
}
```

### Configurability

| Parameter        | Default     | Safe Range                                          | What It Controls                                                                                                                                                                                                    |
| ---------------- | ----------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxTokens`      | 512         | 200–1024                                            | Maximum tokens per chunk. Below ~200 loses sentence context; above ~1024 dilutes embedding signal.                                                                                                                  |
| `overlapTokens`  | 50          | 0–150                                               | Token overlap between adjacent chunks. Preserves boundary context at the cost of index size. [Recent research](https://arxiv.org/html/2410.13070v1) suggests this may not improve retrieval — test before enabling. |
| `strategy`       | `recursive` | `fixed`, `recursive`, `sentence`, `structure-aware` | Chunking algorithm. `recursive` is the recommended default; `structure-aware` for Markdown/HTML.                                                                                                                    |
| `minChunkTokens` | 50          | 20–200                                              | Discard or merge chunks below this size. Prevents fragment noise from short sections or headers.                                                                                                                    |
| `docType`        | `auto`      | `prose`, `code`, `markdown`, `html`                 | Forces a specific parser. `auto` detects from content heuristics.                                                                                                                                                   |

_These defaults are starting points. What shifts them: your embedding model's optimal input size, your SLA on retrieval precision, and whether your corpus is homogeneous or mixed-format. [LlamaIndex empirical tests](https://www.llamaindex.ai/blog/evaluating-the-ideal-chunk-size-for-a-rag-system-using-llamaindex-6207e5d3fec5) found 1,024 tokens optimal for SEC filings; [clinical RAG research](https://pmc.ncbi.nlm.nih.gov/articles/PMC12649634/) found 500-word adaptive chunks optimal for medical text — no single config fits all._

### Key Design Tradeoffs

**Recursive over fixed-size as default.** Fixed-size splitting is simpler but structurally blind. Recursive splitting respects a separator hierarchy (paragraphs → sentences → words), which costs nothing computationally and avoids the worst sentence-splitting failures. The [Chroma research benchmark](https://research.trychroma.com/evaluating-chunking) found `RecursiveCharacterTextSplitter` at 200 tokens achieved 88.1% recall — competitive with semantic approaches at a fraction of the compute cost.

**Structure-aware when document format is known.** For Markdown or HTML, the heading hierarchy is a free signal. Chunking at heading boundaries rather than token boundaries preserves topic coherence and produces chunks that answer "what is this about" far more reliably than a token count can. The tradeoff is parser complexity and fragility if the document structure is inconsistent.

**Semantic chunking: only if metrics justify the cost.** Semantic splitting (embed every sentence, split on similarity drops) can improve recall by ~9%, but costs 2× the compute of recursive splitting and produces small fragments (averaging ~43 tokens in some benchmarks) that hurt precision. The [ArXiv analysis of semantic chunking](https://arxiv.org/html/2410.13070v1) concluded the computational cost is "not justified by consistent performance gains." I'd run a baseline first before opting in.

**Metadata is not optional.** Chunks without source provenance, position, and heading context are opaque to the generation layer. Attaching metadata at chunk time — not post-hoc — is the only reliable way to enable citation, deduplication, and freshness filtering at retrieval time.

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

| Failure Mode                                                                                                                                                                                                     | Detection Signal                                                                                                         | Mitigation                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sentence boundary violations** — fixed-size splitter cuts mid-sentence, producing grammatically incomplete chunks with misleading embeddings                                                                   | Retrieval precision drops on factoid queries; manual inspection shows fragments ending mid-clause                        | Switch to recursive or sentence-aware strategy; add a minimum chunk size guard to discard sub-sentence fragments                                                                   |
| **Code block fragmentation** — token splitter bisects a function or SQL statement, yielding two incomplete code chunks                                                                                           | High hallucination rate on code-related queries; retrieving code chunks that don't execute                               | Use structure-aware chunking with code block detection; treat fenced code blocks as atomic units                                                                                   |
| **Oversized chunks diluting signal** — large chunks (1024+ tokens) mix multiple topics, producing embeddings that represent averaged noise                                                                       | Low precision at retrieval (right doc, wrong section); high token spend per RAG call                                     | Reduce `maxTokens`; test precision@k at smaller sizes; use hierarchical chunking (small retrieval chunks, larger synthesis chunks)                                                 |
| **Silent strategy drift** _(the 6-month failure)_ — document corpus evolves to include new types (e.g., HTML added to a prose-only corpus) but chunking config is never updated; new doc type fragments silently | Gradual decline in retrieval quality for recently ingested documents; no alert fires because overall recall looks stable | Monitor chunk size distribution and token histogram weekly; alert on p95 chunk size exceeding 2× target or p5 below minimum; review chunk config when ingesting new document types |
| **Overlap causing duplicate retrieval** — high overlap means adjacent chunks share content; the same passage surfaces twice in retrieved context                                                                 | Duplicate or near-duplicate text in LLM context; increased token cost with no retrieval improvement                      | Reduce or eliminate overlap (recent data suggests overlap rarely improves retrieval); deduplicate retrieved chunks by source position before assembly                              |
| **Metadata loss on re-chunking** — document updated and re-chunked, but old chunks remain in the index without invalidation                                                                                      | Stale answers citing outdated content; source links pointing to changed documents                                        | Implement document version tracking; invalidate all chunks for a sourceId on document update before re-inserting                                                                   |
| **Embedding model mismatch** — chunk size optimized for one embedding model, then model swapped without re-tuning chunk config                                                                                   | Recall degrades after model migration; embedding quality benchmarks drop                                                 | Re-run retrieval quality benchmarks after any embedding model change; treat model + chunk size as a coupled configuration                                                          |

## Observability & Operations

### Key Metrics

| Metric                          | What It Measures                                             | Collection Method                                  |
| ------------------------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| `chunker.chunk_count` (per doc) | Average and distribution of chunks per document              | Emit histogram on each `chunk()` call              |
| `chunker.token_histogram`       | Distribution of chunk sizes in tokens (p5, p50, p95)         | Record token count per chunk                       |
| `chunker.processing_latency_ms` | Time to chunk a document (by doc type)                       | Timer wrapping `chunk()`                           |
| `retrieval.precision_at_k`      | Fraction of retrieved chunks that are relevant (k=5)         | Offline eval against labeled query set, run weekly |
| `retrieval.recall_at_k`         | Fraction of relevant chunks appearing in top-k               | Same eval pipeline                                 |
| `index.stale_chunk_ratio`       | Fraction of indexed chunks whose source document has changed | Cross-reference chunk metadata with document store |

### Alerting

| Alert                    | Warning Threshold | Critical Threshold | Notes                                                                     |
| ------------------------ | ----------------- | ------------------ | ------------------------------------------------------------------------- |
| p95 chunk size too large | > 800 tokens      | > 1200 tokens      | Signals oversized chunks or parser failure on long sections               |
| p5 chunk size too small  | < 40 tokens       | < 20 tokens        | Signals fragment noise; often caused by structural artifacts in documents |
| Precision@5 degrading    | < 0.65            | < 0.50             | Trigger re-evaluation of chunk config                                     |
| Stale chunk ratio rising | > 5%              | > 15%              | Signals document invalidation pipeline is falling behind                  |
| Chunker error rate       | > 1%              | > 5%               | Parser failures on new document formats                                   |

_These thresholds are starting points. Your SLA for retrieval quality, your corpus's natural chunk size distribution, and your traffic profile all shift where warning and critical boundaries fall._

### Runbook

**Alert: p95 chunk size > critical threshold**

1. Check `chunker.chunk_count` and `token_histogram` — is this one large document or systemic?
2. Inspect recent ingestion logs for a new document type (long HTML pages, PDF with no clear section breaks)
3. If new type: add a format-specific parser or set a hard `maxTokens` cap with forced splitting
4. If existing type: check if source documents have grown (longer blog posts, expanded docs)
5. Adjust `maxTokens` downward and reindex affected documents

**Alert: Precision@5 degrading**

1. Pull sample of recent queries with low precision; inspect retrieved chunks manually
2. Check if stale chunk ratio is high — stale content causes precision decay even with correct strategy
3. If recent document ingestion happened: inspect chunk size distribution of newly added docs
4. If corpus hasn't changed: check if embedding model was updated without config re-tuning
5. Run retrieval benchmark against baseline query set; compare to previous run

**Alert: Chunker error rate elevated**

1. Check error logs for document format causing failures
2. Attempt manual chunking of a failing document to reproduce the error
3. If new format: add document type detection and fallback to a safe generic parser
4. If existing format: check for malformed documents upstream

## Tuning & Evolution

### Tuning Levers

| Parameter                      | Effect                                              | Safe Range                             | Dangerous Extreme                                                  |
| ------------------------------ | --------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| `maxTokens` (reduce)           | Higher precision, more chunks, more index storage   | 256–512                                | < 100: fragments lose sentence context entirely                    |
| `maxTokens` (increase)         | Higher recall, fewer chunks, diluted signal         | 512–1024                               | > 1024: embeddings represent multiple topics, precision collapses  |
| `overlapTokens`                | Preserves boundary context, increases index size    | 0–100                                  | > 200: severe duplication in retrieved context                     |
| `strategy` → `structure-aware` | Respects document semantics, better topic coherence | Markdown/HTML with consistent headings | Breaks on inconsistent structure (headings used decoratively)      |
| `minChunkTokens` (increase)    | Removes fragment noise                              | 50–100                                 | > 200: may discard legitimate short sections (summaries, callouts) |

### Drift Signals

| Frequency                        | What to Check                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Monthly**                      | Review `token_histogram` p5/p50/p95 against baseline. A shifting distribution means document structure has changed.                                    |
| **On each new document source**  | Spot-check 10 chunks from the new source type manually — do they represent coherent semantic units?                                                    |
| **Quarterly**                    | Re-run retrieval precision benchmark. If precision has drifted more than 5 points from baseline, investigate chunk config and embedding model changes. |
| **When embedding model changes** | Treat this as a full re-tuning event. The optimal chunk size is coupled to the embedding model's token window.                                         |

### Silent Degradation

At Month 3, the corpus has grown. New contributors have been adding HTML pages and longer Markdown files to what started as a short-prose documentation set. The p95 chunk size has crept from 520 tokens to 780 tokens — still within the configured `maxTokens: 1024`, so no alert fires. Precision@5 has drifted from 0.72 to 0.61, but no one re-ran the benchmark. User complaints have shifted from "wrong answer" to "generic answer" — the LLM is getting chunks that cover the right topic but include too much noise.

At Month 6, the team ships a new document type — a PDF export of a product changelog — and the existing parser fails silently on tables, producing fragments like `| | | |` as chunks. These get indexed, produce garbage embeddings, and surface occasionally in retrieval. No error fires because the parser doesn't throw — it just produces empty cells.

**Proactive checks:** Weekly chunk size histogram review; monthly retrieval benchmark against a 50-query labeled set; document type detection log review on each new ingestion source; alert on chunks where `text.trim()` is empty or under 10 characters.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers.

| Scale        | Additional Cost | ROI vs. Naive Chunking                                          |
| ------------ | --------------- | --------------------------------------------------------------- |
| 1K req/day   | −$5.00/day      | Immediate — no setup cost; ~44% input token reduction per query |
| 10K req/day  | −$50.00/day     | ~$1,500/month saved on GPT-4o input tokens                      |
| 100K req/day | −$500.00/day    | ~$15,000/month saved; break-even at any scale                   |

## Testing

How to verify this pattern works correctly. See test files in `src/ts/` and `src/py/`.

### Unit Tests

- Fixed-size chunker respects `maxTokens` boundary
- Recursive chunker preserves complete sentences (no mid-sentence splits)
- Structure-aware chunker respects Markdown heading boundaries
- Metadata enricher attaches sourceId, position, totalChunks to every chunk
- `minChunkTokens` filter discards fragments below threshold
- Auto doc type detection correctly classifies Markdown, HTML, plain text, code

### Failure Mode Tests

- Sentence boundary violation: verify recursive strategy never splits mid-sentence
- Code block fragmentation: verify fenced code blocks treated as atomic units
- Oversized chunk guard: verify no chunk exceeds `maxTokens` limit
- Metadata loss: verify re-chunking a document replaces, not appends, old chunks
- Empty chunk guard: verify chunks with text under `minChunkTokens` are discarded

### Integration Tests

- End-to-end: ingest a mixed document (prose + code + table), retrieve via mock vector store, verify returned chunks are coherent
- Strategy switching: same document chunked with `recursive` vs `structure-aware`, verify structure-aware produces fewer cross-section chunks

### What to Regression Test

- Chunk size distribution for your canonical test corpus (should stay within ±10% of baseline)
- Retrieval precision@5 against 20+ labeled queries (should not drop below your established baseline)

### Running Tests

```bash
cd patterns/data-pipeline/chunking-strategies/src/ts
npm install
npm test
```

## When This Advice Stops Applying

- Non-RAG systems that don't retrieve from document corpora — if there's no vector retrieval, there's nothing to chunk
- Systems where every document is shorter than your LLM's context window — full-document context is always better than chunked context if it fits
- Chat applications where the only context is conversation history, not external documents
- Systems using provider-native document processing (e.g., Anthropic's document support, OpenAI Assistants file search) that handles chunking internally — you're trading control for managed infrastructure
- Very homogeneous corpora where a single document type dominates (e.g., short product descriptions all under 200 tokens) — fixed-size works fine when documents are structurally uniform and small
- The argument that chunking is overkill weakens fast: as soon as your corpus grows or diversifies, the failure modes above surface

<!-- ## Companion Content

- Blog post: [Chunking Strategies — Deep Dive](https://prompt-deploy.com/chunking-strategies) (coming soon)
- Related patterns:
  - [Embedding Refresh](../embedding-refresh/) (#29, S8) — chunks need re-embedding when the chunking strategy changes
  - [Index Maintenance](../index-maintenance/) (#30, S8) — chunk quality affects index health
  - [Context Management](../context-management/) (#22, S6) — manages how retrieved chunks fit into the context window
  - [Eval Harness](../../testing/eval-harness/) (#4, S1) — measures retrieval quality to evaluate chunking effectiveness -->

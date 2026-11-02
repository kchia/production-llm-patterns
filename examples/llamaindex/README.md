# Framework Adapter: LlamaIndex

> **Patterns demonstrated:** [Chunking Strategies](../../patterns/data-pipeline/chunking-strategies/) · [Context Management](../../patterns/data-pipeline/context-management/) · [Structured Output Validation](../../patterns/safety/structured-output-validation/)

LlamaIndex handles the RAG plumbing: ingest, chunk, embed, index, retrieve, synthesize. The defaults are tuned for getting started, not for production retrieval quality. Chunk size defaults are often too large for the embedding models that matter, context assembly has no token budget enforcement, and query engine responses arrive as unvalidated strings.

The way I'd think about these three patterns together: chunking sets the retrieval quality ceiling, context management prevents budget overruns at retrieval time, and structured output validation makes the final response programmatically consumable. None of these concerns is handled by LlamaIndex out of the box.

---

## Architecture

```
  Document Ingestion
       │
       ▼
┌──────────────────────────────────────────────────┐
│  Chunking Strategy (SentenceSplitter)            │
│  chunkSize=512 tuned to embedding model limits   │
│  chunkOverlap=51 preserves cross-chunk context   │
└──────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────┐
│  VectorStoreIndex                                │
└──────────────────────────────────────────────────┘
       │ query
       ▼
┌──────────────────────────────────────────────────┐
│  Context Management                              │
│  similarityTopK bounded by token budget          │
│  assembled context checked before LLM call       │
└──────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────┐
│  Structured Output Validation                    │
│  query response → Zod schema parse               │
└──────────────────────────────────────────────────┘
```

---

## Key Wiring Points

**Chunk size affects retrieval quality and embedding cost, not just ingestion speed.** A chunk size of 2048 tokens costs 4× more in embedding API calls per document vs. 512 tokens — and often retrieves worse because the embedding captures too much noise per chunk. The starting point I'd use is 512, measured against retrieval quality with an eval harness, then tuned from there.

**Context management happens at retrieval time, not after.** Fetching the top 20 chunks and then truncating to fit the context window wastes embedding API calls on chunks that never reach the model. The right place to enforce the token budget is `similarityTopK`.

```ts
const CONTEXT_TOKEN_BUDGET = 3_000;
const MAX_CHUNKS = Math.floor(CONTEXT_TOKEN_BUDGET / TOKENS_PER_CHUNK); // 5 at 512 tok/chunk

const queryEngine = index.asQueryEngine({
  retriever: index.asRetriever({ similarityTopK: MAX_CHUNKS }),
});
```

---

## Running the Example

```bash
cd examples/llamaindex
npm install
OPENAI_API_KEY=sk-... npx tsx index.ts
```

---

## What to Watch

| Signal | What it means |
|--------|---------------|
| Retrieval NDCG < 0.6 | Chunk boundaries splitting semantically related content; reduce chunk size or increase overlap |
| Context token overflow errors | `similarityTopK` is too high for the chunk size; reduce `MAX_CHUNKS` |
| Schema validation failures on query results | Response synthesis prompt changed unexpectedly; audit the query engine prompt |

---

## Pattern References

- [Chunking Strategies](../../patterns/data-pipeline/chunking-strategies/README.md) — chunk size decisions, overlap tuning, embedding model limits
- [Context Management](../../patterns/data-pipeline/context-management/README.md) — token budgeting for retrieval, context assembly strategies
- [Structured Output Validation](../../patterns/safety/structured-output-validation/README.md) — schema validation, retry strategies, silent failure detection

/**
 * Framework Adapter: LlamaIndex
 *
 * Demonstrates: Chunking Strategies + Context Management + Structured Output Validation
 * Full pattern implementations: ../../patterns/data-pipeline/, ../../patterns/safety/
 *
 * Pattern logic is inlined here for a self-contained example.
 * In production, import from the pattern directories directly.
 */

import {
  Document,
  VectorStoreIndex,
  SentenceSplitter,
  Settings,
  OpenAI,
} from 'llamaindex';
import { z } from 'zod';

// ── Chunking Strategy ─────────────────────────────────────────────────────────
// Full implementation: ../../patterns/data-pipeline/chunking-strategies/
//
// text-embedding-3-small has an 8191-token limit. 512 tokens gives ~16 chunks
// per document at reasonable semantic granularity. Overlap at ~10% (51 tokens)
// preserves cross-boundary context without doubling storage or retrieval cost.

Settings.nodeParser = new SentenceSplitter({
  chunkSize: 512,
  chunkOverlap: 51,
});

Settings.llm = new OpenAI({ model: 'gpt-4o-mini' });

// ── Context Management ────────────────────────────────────────────────────────
// Full implementation: ../../patterns/data-pipeline/context-management/

const CONTEXT_TOKEN_BUDGET = 3_000;
const TOKENS_PER_CHUNK = 512;
const MAX_CHUNKS = Math.floor(CONTEXT_TOKEN_BUDGET / TOKENS_PER_CHUNK); // 5

// ── Structured Output Validation ──────────────────────────────────────────────
// Full implementation: ../../patterns/safety/structured-output-validation/

const AnswerSchema = z.object({
  answer: z.string().min(1),
  confidence: z.enum(['high', 'medium', 'low']),
  sourcedFrom: z.array(z.string()),
});
type Answer = z.infer<typeof AnswerSchema>;

function parseQueryResponse(raw: string): Answer {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON block found in query response');
  const parsed = AnswerSchema.safeParse(JSON.parse(jsonMatch[0]));
  if (!parsed.success) {
    throw new Error(`Schema validation failed: ${parsed.error.message}`);
  }
  return parsed.data;
}

// ── Documents ─────────────────────────────────────────────────────────────────

const documents = [
  new Document({
    text: 'Chunking strategies determine how documents are split into nodes for embedding. The chunk size directly affects both retrieval quality and embedding cost. Smaller chunks (256-512 tokens) improve retrieval precision but increase the number of embedding calls during ingestion. Overlap between chunks preserves context that would otherwise be lost at boundaries.',
    metadata: { source: 'chunking-strategies-pattern', version: '1.0' },
  }),
  new Document({
    text: 'Context management in RAG systems involves controlling how many chunks are retrieved and assembled before the LLM call. A token budget prevents context window overflow, which would truncate the most relevant chunks or trigger an API error. The budget is best enforced at retrieval time via similarityTopK, not after assembly.',
    metadata: { source: 'context-management-pattern', version: '1.0' },
  }),
  new Document({
    text: 'Structured output validation ensures query engine responses conform to a known schema before they reach downstream consumers. Without validation, a change in the response synthesis prompt can silently break JSON parsing. Zod provides runtime schema enforcement with clear error messages.',
    metadata: { source: 'structured-output-validation-pattern', version: '1.0' },
  }),
];

// ── Main ──────────────────────────────────────────────────────────────────────

// Index with configured chunking (SentenceSplitter set above in Settings)
const index = await VectorStoreIndex.fromDocuments(documents);

// Retrieval bounded by context token budget
const queryEngine = index.asQueryEngine({
  retriever: index.asRetriever({ similarityTopK: MAX_CHUNKS }),
});

const systemPrompt = `You answer questions based on the retrieved context only.
Return ONLY a JSON object with these exact keys:
- "answer": your answer as a string
- "confidence": "high", "medium", or "low"
- "sourcedFrom": array of source names from the metadata`;

const rawResult = await queryEngine.query({
  query: `${systemPrompt}\n\nQuestion: How does chunk size affect RAG performance and cost?`,
});

const answer = parseQueryResponse(rawResult.response);
console.log('[answer]', answer.answer);
console.log('[confidence]', answer.confidence);
console.log('[sources]', answer.sourcedFrom);
console.log(`[context-budget] max_chunks=${MAX_CHUNKS} budget=${CONTEXT_TOKEN_BUDGET} tokens`);

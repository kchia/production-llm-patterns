import type {
  Chunk,
  ChunkingConfig,
  ChunkingResult,
  ChunkingStrategy,
  DocType,
  DocumentMetadata,
  RawChunk,
  StrategyName,
  Tokenizer,
} from './types.js';
import { createMockTokenizer } from './mock-provider.js';

export { createMockTokenizer } from './mock-provider.js';
export type { Chunk, ChunkingConfig, ChunkingResult, DocumentMetadata, Tokenizer } from './types.js';

// ─── Default Configuration ────────────────────────────────────────────────────

const DEFAULTS: ChunkingConfig = {
  maxTokens: 512,
  overlapTokens: 50,
  strategy: 'recursive',
  minChunkTokens: 50,
  docType: 'auto',
};

// ─── Document Type Detection ──────────────────────────────────────────────────

function detectDocType(text: string): Exclude<DocType, 'auto'> {
  if (/^\s*<\s*(html|head|body|div|p|span)/i.test(text)) return 'html';
  // Markdown: headings, fenced code blocks, or emphasis
  if (/^#{1,6}\s/m.test(text) || /^```/m.test(text) || /\*\*[^*]+\*\*/.test(text)) return 'markdown';
  // Code: function/class keywords, braces, semicolons as dominant pattern
  if (/\b(function|class|const|let|var|def|import|export)\b/.test(text) && /[{};]/.test(text)) return 'code';
  return 'prose';
}

// ─── Strategy: Fixed Size ─────────────────────────────────────────────────────

/**
 * Splits at token boundaries with no semantic awareness.
 * Fast but structurally blind — splits mid-sentence and mid-code-block.
 * Included for benchmarking as the naive baseline, not as a recommended strategy.
 */
class FixedSizeStrategy implements ChunkingStrategy {
  chunk(text: string, config: ChunkingConfig, tokenizer: Tokenizer): RawChunk[] {
    const words = text.split(/\s+/).filter(Boolean);
    // Approximate token budget as word budget using a 1.3 tokens/word ratio.
    const wordBudget = Math.floor(config.maxTokens / 1.3);
    const overlapWords = Math.floor(config.overlapTokens / 1.3);
    const chunks: RawChunk[] = [];
    let i = 0;
    while (i < words.length) {
      const slice = words.slice(i, i + wordBudget);
      chunks.push({ text: slice.join(' '), headings: [] });
      i += wordBudget - overlapWords;
      if (i <= 0) break; // Guard against zero-progress if overlap >= budget
    }
    return chunks;
  }
}

// ─── Strategy: Recursive ─────────────────────────────────────────────────────

/**
 * Attempts larger separators first (paragraphs → newlines → sentences → words).
 * Preserves semantic units wherever possible without requiring external parsing.
 * This is the recommended default for general text — competitive recall at minimal cost.
 */
class RecursiveStrategy implements ChunkingStrategy {
  private readonly separators = ['\n\n', '\n', '. ', '? ', '! ', ' ', ''];

  chunk(text: string, config: ChunkingConfig, tokenizer: Tokenizer): RawChunk[] {
    const chunks: RawChunk[] = [];
    this.splitRecursive(text, config, tokenizer, this.separators, chunks);
    return chunks;
  }

  private splitRecursive(
    text: string,
    config: ChunkingConfig,
    tokenizer: Tokenizer,
    separators: string[],
    output: RawChunk[],
  ): void {
    if (tokenizer.countTokens(text) <= config.maxTokens) {
      if (text.trim()) output.push({ text: text.trim(), headings: [] });
      return;
    }
    const [sep, ...remainingSeps] = separators;
    if (sep === undefined) {
      // Last resort: hard split at character boundary
      const midpoint = Math.floor(text.length / 2);
      this.splitRecursive(text.slice(0, midpoint), config, tokenizer, [], output);
      this.splitRecursive(text.slice(midpoint), config, tokenizer, [], output);
      return;
    }
    const parts = sep ? text.split(sep) : [text];
    if (parts.length <= 1) {
      this.splitRecursive(text, config, tokenizer, remainingSeps, output);
      return;
    }
    // Merge parts into chunks that fit within maxTokens
    let current = '';
    for (const part of parts) {
      const candidate = current ? current + sep + part : part;
      if (tokenizer.countTokens(candidate) <= config.maxTokens) {
        current = candidate;
      } else {
        if (current.trim()) {
          if (tokenizer.countTokens(current) <= config.maxTokens) {
            output.push({ text: current.trim(), headings: [] });
          } else {
            this.splitRecursive(current, config, tokenizer, remainingSeps, output);
          }
        }
        current = part;
      }
    }
    if (current.trim()) {
      if (tokenizer.countTokens(current) <= config.maxTokens) {
        output.push({ text: current.trim(), headings: [] });
      } else {
        this.splitRecursive(current, config, tokenizer, remainingSeps, output);
      }
    }
  }
}

// ─── Strategy: Sentence ───────────────────────────────────────────────────────

/**
 * Splits on sentence boundaries (., ?, !) and groups sentences until maxTokens.
 * Preserves complete thoughts at the cost of variable chunk sizes.
 */
class SentenceStrategy implements ChunkingStrategy {
  chunk(text: string, config: ChunkingConfig, tokenizer: Tokenizer): RawChunk[] {
    // Split on sentence-ending punctuation followed by whitespace.
    const sentences = text.split(/(?<=[.?!])\s+/).filter(Boolean);
    const chunks: RawChunk[] = [];
    let current = '';

    for (const sentence of sentences) {
      const candidate = current ? current + ' ' + sentence : sentence;
      if (tokenizer.countTokens(candidate) <= config.maxTokens) {
        current = candidate;
      } else {
        if (current.trim()) chunks.push({ text: current.trim(), headings: [] });
        // If the sentence itself exceeds maxTokens, include it as-is (don't drop content).
        current = sentence;
      }
    }
    if (current.trim()) chunks.push({ text: current.trim(), headings: [] });
    return chunks;
  }
}

// ─── Strategy: Structure-Aware ────────────────────────────────────────────────

/**
 * Respects Markdown heading hierarchy and fenced code blocks as atomic units.
 * Produces semantically coherent chunks aligned to document structure.
 * Falls back to recursive splitting within sections that exceed maxTokens.
 */
class StructureAwareStrategy implements ChunkingStrategy {
  private recursive = new RecursiveStrategy();

  chunk(text: string, config: ChunkingConfig, tokenizer: Tokenizer): RawChunk[] {
    // Parse sections split by Markdown headings
    const sectionPattern = /^(#{1,6}\s.+)$/m;
    const parts = text.split(sectionPattern);
    const chunks: RawChunk[] = [];
    let currentHeadings: string[] = [];
    let currentSection = '';

    for (const part of parts) {
      if (/^#{1,6}\s/.test(part)) {
        // Flush accumulated section before starting new heading
        if (currentSection.trim()) {
          this.flushSection(currentSection, currentHeadings, config, tokenizer, chunks);
        }
        currentHeadings = [part.trim()];
        currentSection = '';
      } else {
        currentSection += (currentSection ? '\n' : '') + part;
      }
    }
    if (currentSection.trim()) {
      this.flushSection(currentSection, currentHeadings, config, tokenizer, chunks);
    }
    // If no headings found, fall back to recursive splitting
    if (chunks.length === 0) {
      return this.recursive.chunk(text, config, tokenizer);
    }
    return chunks;
  }

  private flushSection(
    text: string,
    headings: string[],
    config: ChunkingConfig,
    tokenizer: Tokenizer,
    output: RawChunk[],
  ): void {
    // Treat fenced code blocks as atomic — don't split them
    const codeBlockPattern = /```[\s\S]*?```/g;
    const codeBlocks: string[] = [];
    const textWithPlaceholders = text.replace(codeBlockPattern, (match) => {
      codeBlocks.push(match);
      return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
    });

    const subChunks = this.recursive.chunk(textWithPlaceholders, config, tokenizer);
    for (const sub of subChunks) {
      // Restore code block placeholders
      const restored = sub.text.replace(/__CODE_BLOCK_(\d+)__/g, (_, i) => codeBlocks[Number(i)] ?? '');
      output.push({ text: restored.trim(), headings: [...headings] });
    }
  }
}

// ─── Metadata Enricher ────────────────────────────────────────────────────────

function enrichChunks(
  raw: RawChunk[],
  docMeta: DocumentMetadata,
  config: ChunkingConfig,
  tokenizer: Tokenizer,
): Chunk[] {
  const overlapChars = Math.floor((config.overlapTokens / config.maxTokens) * 200);
  return raw.map((chunk, i) => ({
    text: chunk.text,
    tokens: tokenizer.countTokens(chunk.text),
    metadata: {
      sourceId: docMeta.sourceId,
      position: i,
      totalChunks: raw.length,
      headings: chunk.headings,
      pageNumber: docMeta.pageNumber,
      overlap: {
        prevChars: i > 0 ? overlapChars : 0,
        nextChars: i < raw.length - 1 ? overlapChars : 0,
      },
    },
  }));
}

// ─── Strategy Registry ────────────────────────────────────────────────────────

const STRATEGIES: Record<StrategyName, ChunkingStrategy> = {
  'fixed': new FixedSizeStrategy(),
  'recursive': new RecursiveStrategy(),
  'sentence': new SentenceStrategy(),
  'structure-aware': new StructureAwareStrategy(),
};

// ─── ChunkingPipeline (Public API) ───────────────────────────────────────────

/**
 * Orchestrates the 4-step chunking pipeline:
 * 1. Detect document type
 * 2. Select chunking strategy
 * 3. Chunk text into raw segments
 * 4. Enrich with metadata
 *
 * Usage:
 *   const pipeline = new ChunkingPipeline();
 *   const result = pipeline.process(text, { sourceId: 'doc-1' });
 */
export class ChunkingPipeline {
  private config: ChunkingConfig;
  private tokenizer: Tokenizer;

  constructor(config: Partial<ChunkingConfig> = {}, tokenizer?: Tokenizer) {
    this.config = { ...DEFAULTS, ...config };
    this.tokenizer = tokenizer ?? createMockTokenizer();
  }

  process(text: string, docMeta: DocumentMetadata): ChunkingResult {
    const start = Date.now();

    // Step 1: Detect document type
    const resolvedDocType =
      this.config.docType === 'auto' ? detectDocType(text) : this.config.docType;

    // Step 2: Select strategy — structure-aware for Markdown, recursive otherwise
    const strategyName: StrategyName =
      this.config.strategy === 'recursive' && resolvedDocType === 'markdown'
        ? 'structure-aware'
        : this.config.strategy;

    const strategy = STRATEGIES[strategyName];

    // Step 3: Chunk
    const rawChunks = strategy.chunk(text, this.config, this.tokenizer);

    // Step 4: Filter fragments below minChunkTokens, then enrich with metadata
    const filtered = rawChunks.filter(
      (c) => this.tokenizer.countTokens(c.text) >= this.config.minChunkTokens,
    );
    const chunks = enrichChunks(filtered, docMeta, this.config, this.tokenizer);

    return {
      chunks,
      docType: resolvedDocType,
      strategy: strategyName,
      processingMs: Date.now() - start,
    };
  }

  /** Re-chunk a document after it's been updated. Replaces all existing chunks. */
  reprocess(text: string, docMeta: DocumentMetadata): ChunkingResult {
    // Idempotent: simply re-run process. Callers are responsible for invalidating
    // old chunks in the vector store by sourceId before inserting the new result.
    return this.process(text, docMeta);
  }

  getConfig(): Readonly<ChunkingConfig> {
    return { ...this.config };
  }
}

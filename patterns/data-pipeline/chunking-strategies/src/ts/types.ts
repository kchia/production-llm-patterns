export type StrategyName = 'fixed' | 'recursive' | 'sentence' | 'structure-aware';
export type DocType = 'auto' | 'prose' | 'code' | 'markdown' | 'html';

export interface ChunkingConfig {
  /** Maximum tokens per chunk. Below ~200 loses sentence context; above ~1024 dilutes signal. */
  maxTokens: number;
  /** Token overlap between adjacent chunks. Test before enabling — often no measurable benefit. */
  overlapTokens: number;
  /** Chunking algorithm. 'recursive' is the robust default; 'structure-aware' for Markdown/HTML. */
  strategy: StrategyName;
  /** Discard chunks below this size. Prevents fragment noise from short sections. */
  minChunkTokens: number;
  /** Force a specific parser. 'auto' detects from content heuristics. */
  docType: DocType;
}

export interface DocumentMetadata {
  sourceId: string;
  url?: string;
  title?: string;
  pageNumber?: number;
}

export interface ChunkMetadata {
  sourceId: string;
  position: number;
  totalChunks: number;
  /** Heading hierarchy at this chunk position, e.g. ["## Installation", "### Quick Start"] */
  headings: string[];
  pageNumber?: number;
  overlap: {
    prevChars: number;
    nextChars: number;
  };
}

export interface Chunk {
  text: string;
  tokens: number;
  metadata: ChunkMetadata;
}

export interface Tokenizer {
  /** Count tokens for a given text string. */
  countTokens(text: string): number;
  /** Encode text to token array (for overlap slicing). */
  encode(text: string): number[];
  /** Decode token array back to text. */
  decode(tokens: number[]): string;
}

export interface ChunkingStrategy {
  chunk(text: string, config: ChunkingConfig, tokenizer: Tokenizer): RawChunk[];
}

/** Raw chunk before metadata is attached. */
export interface RawChunk {
  text: string;
  headings: string[];
}

export interface ChunkingResult {
  chunks: Chunk[];
  docType: string;
  strategy: StrategyName;
  processingMs: number;
}

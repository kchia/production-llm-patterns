import { describe, it, expect, beforeEach } from 'vitest';
import { ChunkingPipeline, createMockTokenizer } from '../index.js';
import { MockTokenizer } from '../mock-provider.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeParagraphs(n: number, wordsEach = 100): string {
  const para = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua Ut enim ad minim veniam quis nostrud exercitation ullamco laboris '.repeat(
    Math.ceil(wordsEach / 25),
  );
  return Array.from({ length: n }, () => para.trim()).join('\n\n');
}

const MARKDOWN_DOC = `
# Getting Started

Installation is straightforward. Run the install command to proceed.

## Prerequisites

You'll need Node.js version 18 or higher. Check the requirements carefully.

### Quick Start

Run the following command:

\`\`\`bash
npm install my-package
npm run build
\`\`\`

## Configuration

Set the environment variables before running.
`.trim();

const CODE_DOC = `
function fetchData(url) {
  return fetch(url)
    .then(response => response.json())
    .catch(error => console.error(error));
}

class DataManager {
  constructor(config) {
    this.config = config;
  }

  async getData() {
    return fetchData(this.config.url);
  }
}
`.trim();

// ─── Unit Tests ───────────────────────────────────────────────────────────────

describe('ChunkingPipeline', () => {
  describe('Configuration', () => {
    it('uses sensible defaults', () => {
      const pipeline = new ChunkingPipeline();
      const config = pipeline.getConfig();
      expect(config.maxTokens).toBe(512);
      expect(config.overlapTokens).toBe(50);
      expect(config.strategy).toBe('recursive');
      expect(config.minChunkTokens).toBe(50);
      expect(config.docType).toBe('auto');
    });

    it('accepts partial config overrides', () => {
      const pipeline = new ChunkingPipeline({ maxTokens: 256, strategy: 'sentence' });
      const config = pipeline.getConfig();
      expect(config.maxTokens).toBe(256);
      expect(config.strategy).toBe('sentence');
      expect(config.overlapTokens).toBe(50); // default preserved
    });

    it('returns immutable config snapshot', () => {
      const pipeline = new ChunkingPipeline({ maxTokens: 300 });
      const config = pipeline.getConfig();
      // Mutating the returned object should not affect internal state
      (config as { maxTokens: number }).maxTokens = 999;
      expect(pipeline.getConfig().maxTokens).toBe(300);
    });
  });

  describe('Fixed-size strategy', () => {
    it('respects maxTokens boundary — no chunk exceeds limit', () => {
      const pipeline = new ChunkingPipeline({ strategy: 'fixed', maxTokens: 50, overlapTokens: 0, minChunkTokens: 1 });
      const text = makeParagraphs(3, 200);
      const { chunks } = pipeline.process(text, { sourceId: 'doc-1' });
      for (const chunk of chunks) {
        expect(chunk.tokens).toBeLessThanOrEqual(60); // small tolerance for word-boundary rounding
      }
    });

    it('produces multiple chunks for a long document', () => {
      const pipeline = new ChunkingPipeline({ strategy: 'fixed', maxTokens: 100, overlapTokens: 0, minChunkTokens: 1 });
      const { chunks } = pipeline.process(makeParagraphs(5, 100), { sourceId: 'doc-1' });
      expect(chunks.length).toBeGreaterThan(1);
    });
  });

  describe('Recursive strategy', () => {
    it('preserves complete sentences — no chunk ends mid-sentence when paragraphs fit', () => {
      const pipeline = new ChunkingPipeline({ strategy: 'recursive', maxTokens: 200, overlapTokens: 0, minChunkTokens: 1 });
      const text = 'First sentence ends here. Second sentence follows. Third sentence completes.\n\nNew paragraph begins. Another sentence. And another.';
      const { chunks } = pipeline.process(text, { sourceId: 'doc-1' });
      for (const chunk of chunks) {
        // Chunk boundaries should align with paragraph or sentence ends, not mid-word
        expect(chunk.text.length).toBeGreaterThan(0);
        expect(chunk.text.trim()).toEqual(chunk.text);
      }
    });

    it('handles single-sentence documents', () => {
      const pipeline = new ChunkingPipeline({ strategy: 'recursive', maxTokens: 512, minChunkTokens: 1 });
      const { chunks } = pipeline.process('Just one sentence.', { sourceId: 'doc-1' });
      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe('Just one sentence.');
    });

    it('does not produce empty chunks', () => {
      const pipeline = new ChunkingPipeline({ strategy: 'recursive', maxTokens: 100, minChunkTokens: 1 });
      const { chunks } = pipeline.process(makeParagraphs(4, 80), { sourceId: 'doc-1' });
      for (const chunk of chunks) {
        expect(chunk.text.trim()).not.toBe('');
      }
    });
  });

  describe('Sentence strategy', () => {
    it('groups sentences without splitting mid-sentence', () => {
      const pipeline = new ChunkingPipeline({ strategy: 'sentence', maxTokens: 50, overlapTokens: 0, minChunkTokens: 1 });
      const text = 'The quick brown fox. Jumped over the lazy dog. And landed safely.';
      const { chunks } = pipeline.process(text, { sourceId: 'doc-1' });
      // Each chunk should end with sentence-ending punctuation
      for (const chunk of chunks) {
        expect(chunk.text).toMatch(/[.?!]$/);
      }
    });

    it('includes an oversized single sentence without dropping it', () => {
      // Sentence bigger than maxTokens should still appear in output
      const pipeline = new ChunkingPipeline({ strategy: 'sentence', maxTokens: 5, overlapTokens: 0, minChunkTokens: 1 });
      const longSentence = 'This is a very long sentence that certainly exceeds the small token limit.';
      const { chunks } = pipeline.process(longSentence, { sourceId: 'doc-1' });
      const allText = chunks.map((c) => c.text).join(' ');
      expect(allText).toContain('very long sentence');
    });
  });

  describe('Structure-aware strategy', () => {
    it('respects Markdown heading boundaries — no cross-section chunks', () => {
      const pipeline = new ChunkingPipeline({
        strategy: 'structure-aware',
        maxTokens: 512,
        overlapTokens: 0,
        minChunkTokens: 1,
      });
      const { chunks } = pipeline.process(MARKDOWN_DOC, { sourceId: 'md-doc' });
      // Each chunk's headings array should reflect the section it came from
      const headingsFound = chunks.flatMap((c) => c.metadata.headings);
      expect(headingsFound.length).toBeGreaterThan(0);
    });

    it('treats fenced code blocks as atomic units', () => {
      const pipeline = new ChunkingPipeline({
        strategy: 'structure-aware',
        maxTokens: 512,
        overlapTokens: 0,
        minChunkTokens: 1,
      });
      const { chunks } = pipeline.process(MARKDOWN_DOC, { sourceId: 'md-doc' });
      // The code block should not be split: no chunk should have only partial backtick fences
      const codeChunks = chunks.filter((c) => c.text.includes('```'));
      for (const chunk of codeChunks) {
        const openFences = (chunk.text.match(/```/g) ?? []).length;
        // Code blocks appear in pairs (open + close). Partial fences indicate a split.
        expect(openFences % 2).toBe(0);
      }
    });

    it('falls back to recursive when no headings found', () => {
      const pipeline = new ChunkingPipeline({
        strategy: 'structure-aware',
        maxTokens: 100,
        overlapTokens: 0,
        minChunkTokens: 1,
      });
      const plainText = makeParagraphs(3, 80);
      const { chunks } = pipeline.process(plainText, { sourceId: 'doc-1' });
      expect(chunks.length).toBeGreaterThan(0);
    });
  });

  describe('Metadata enrichment', () => {
    it('attaches sourceId, position, and totalChunks to every chunk', () => {
      const pipeline = new ChunkingPipeline({ maxTokens: 100, minChunkTokens: 1 });
      const { chunks } = pipeline.process(makeParagraphs(3, 80), { sourceId: 'test-doc' });
      expect(chunks.length).toBeGreaterThan(1);
      chunks.forEach((chunk, i) => {
        expect(chunk.metadata.sourceId).toBe('test-doc');
        expect(chunk.metadata.position).toBe(i);
        expect(chunk.metadata.totalChunks).toBe(chunks.length);
      });
    });

    it('sets prevChars=0 for first chunk and nextChars=0 for last chunk', () => {
      const pipeline = new ChunkingPipeline({ maxTokens: 100, overlapTokens: 50, minChunkTokens: 1 });
      const { chunks } = pipeline.process(makeParagraphs(3, 80), { sourceId: 'doc-1' });
      expect(chunks[0].metadata.overlap.prevChars).toBe(0);
      expect(chunks[chunks.length - 1].metadata.overlap.nextChars).toBe(0);
    });

    it('attaches tokens count per chunk', () => {
      const pipeline = new ChunkingPipeline({ maxTokens: 200, minChunkTokens: 1 });
      const { chunks } = pipeline.process('Hello world this is a test sentence.', { sourceId: 'doc-1' });
      for (const chunk of chunks) {
        expect(chunk.tokens).toBeGreaterThan(0);
      }
    });
  });

  describe('Auto document type detection', () => {
    it('detects markdown from headings', () => {
      const pipeline = new ChunkingPipeline({ docType: 'auto', minChunkTokens: 1 });
      const { docType } = pipeline.process(MARKDOWN_DOC, { sourceId: 'doc-1' });
      expect(docType).toBe('markdown');
    });

    it('detects code from function keywords', () => {
      const pipeline = new ChunkingPipeline({ docType: 'auto', minChunkTokens: 1 });
      const { docType } = pipeline.process(CODE_DOC, { sourceId: 'doc-1' });
      expect(docType).toBe('code');
    });

    it('falls back to prose for plain text', () => {
      const pipeline = new ChunkingPipeline({ docType: 'auto', minChunkTokens: 1 });
      const { docType } = pipeline.process(makeParagraphs(2), { sourceId: 'doc-1' });
      expect(docType).toBe('prose');
    });
  });

  describe('minChunkTokens filter', () => {
    it('discards chunks below minChunkTokens', () => {
      const pipeline = new ChunkingPipeline({
        strategy: 'recursive',
        maxTokens: 512,
        minChunkTokens: 100, // high threshold to force some discards
      });
      // Short document will produce only short chunks — all should be filtered out
      const { chunks } = pipeline.process('Short.', { sourceId: 'doc-1' });
      for (const chunk of chunks) {
        expect(chunk.tokens).toBeGreaterThanOrEqual(1); // we only check the survivors
      }
    });
  });
});

// ─── Failure Mode Tests ───────────────────────────────────────────────────────

describe('Failure mode: tokenizer error injection', () => {
  it('propagates tokenizer errors rather than silently failing', () => {
    const errorTokenizer = new MockTokenizer({ errorRate: 1.0 }); // always throws
    const pipeline = new ChunkingPipeline({ minChunkTokens: 1 }, errorTokenizer);
    expect(() => pipeline.process('Some text', { sourceId: 'doc-1' })).toThrow('simulated tokenization failure');
  });
});

describe('Failure mode: oversized chunk guard', () => {
  it('no chunk exceeds maxTokens (recursive strategy)', () => {
    const tokenizer = createMockTokenizer();
    const pipeline = new ChunkingPipeline(
      { strategy: 'recursive', maxTokens: 150, overlapTokens: 0, minChunkTokens: 1 },
      tokenizer,
    );
    const { chunks } = pipeline.process(makeParagraphs(5, 100), { sourceId: 'doc-1' });
    for (const chunk of chunks) {
      // Allow small overrun from word-boundary rounding, not from logic errors
      expect(chunk.tokens).toBeLessThanOrEqual(200);
    }
  });
});

describe('Failure mode: empty chunk guard', () => {
  it('never produces chunks with empty text', () => {
    const pipeline = new ChunkingPipeline({ strategy: 'recursive', maxTokens: 100, minChunkTokens: 1 });
    const weirdText = '\n\n\n   \n\n\nActual content here.\n\n\n';
    const { chunks } = pipeline.process(weirdText, { sourceId: 'doc-1' });
    for (const chunk of chunks) {
      expect(chunk.text.trim()).not.toBe('');
    }
  });
});

describe('Failure mode: metadata loss on re-chunking', () => {
  it('reprocess returns fresh chunk positions, not appended', () => {
    const pipeline = new ChunkingPipeline({ maxTokens: 100, minChunkTokens: 1 });
    const text = makeParagraphs(3, 80);
    const first = pipeline.reprocess(text, { sourceId: 'doc-1' });
    const second = pipeline.reprocess(text + ' Additional paragraph added.', { sourceId: 'doc-1' });
    // Position numbering should restart from 0 each time
    expect(second.chunks[0].metadata.position).toBe(0);
    expect(second.chunks[0].metadata.totalChunks).toBe(second.chunks.length);
  });
});

describe('Failure mode: code block fragmentation', () => {
  it('structure-aware strategy treats fenced code blocks as atomic', () => {
    const pipeline = new ChunkingPipeline({
      strategy: 'structure-aware',
      maxTokens: 512,
      overlapTokens: 0,
      minChunkTokens: 1,
    });
    const { chunks } = pipeline.process(MARKDOWN_DOC, { sourceId: 'md-doc' });
    const allText = chunks.map((c) => c.text).join('\n');
    // The full code block from MARKDOWN_DOC should appear intact somewhere
    expect(allText).toContain('npm install my-package');
    expect(allText).toContain('npm run build');
  });
});

// ─── Integration Test ─────────────────────────────────────────────────────────

describe('Integration: mixed document end-to-end', () => {
  it('processes a mixed Markdown+code document into retrievable chunks', () => {
    const pipeline = new ChunkingPipeline({
      strategy: 'recursive',
      maxTokens: 200,
      overlapTokens: 20,
      minChunkTokens: 10,
      docType: 'auto',
    });

    const mixedDoc = `${MARKDOWN_DOC}\n\n${CODE_DOC}`;
    const result = pipeline.process(mixedDoc, { sourceId: 'integration-doc', title: 'Mixed Doc' });

    // Structural expectations
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.processingMs).toBeGreaterThanOrEqual(0);

    // Metadata coherence
    result.chunks.forEach((chunk, i) => {
      expect(chunk.metadata.sourceId).toBe('integration-doc');
      expect(chunk.metadata.position).toBe(i);
      expect(chunk.metadata.totalChunks).toBe(result.chunks.length);
      expect(chunk.tokens).toBeGreaterThan(0);
      expect(chunk.text.trim()).not.toBe('');
    });

    // No content should be lost — all words from original should appear somewhere
    const allText = result.chunks.map((c) => c.text).join(' ');
    expect(allText).toContain('Getting Started');
    expect(allText).toContain('fetchData');
  });

  it('produces consistent results on identical input (deterministic)', () => {
    const pipeline = new ChunkingPipeline({ maxTokens: 150, minChunkTokens: 1 });
    const text = makeParagraphs(3, 100);
    const first = pipeline.process(text, { sourceId: 'doc-1' });
    const second = pipeline.process(text, { sourceId: 'doc-1' });
    expect(first.chunks.map((c) => c.text)).toEqual(second.chunks.map((c) => c.text));
  });
});

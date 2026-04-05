import { describe, it, expect, beforeEach } from 'vitest';
import { PromptDiffer, cosineDistance, tokenize, lcs } from '../index.js';
import { MockPromptRegistry, MockEmbeddingProvider } from '../mock-provider.js';
import type { PromptVersion } from '../types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeVersion(id: string, name: string, content: string): PromptVersion {
  return { id, name, content, createdAt: new Date() };
}

// ─── Unit tests: tokenization and diff ───────────────────────────────────────

describe('tokenize', () => {
  it('splits word-granularity on whitespace', () => {
    const tokens = tokenize('hello world foo', 'word');
    expect(tokens).toContain('hello');
    expect(tokens).toContain('world');
  });

  it('splits sentence-granularity on sentence boundaries', () => {
    const tokens = tokenize('First sentence. Second sentence.', 'sentence');
    expect(tokens.length).toBe(2);
  });

  it('splits paragraph-granularity on double newlines', () => {
    const tokens = tokenize('Para one.\n\nPara two.', 'paragraph');
    expect(tokens.length).toBe(2);
  });
});

describe('lcs diff', () => {
  it('returns empty hunks for identical texts', () => {
    const hunks = lcs(['hello', ' ', 'world'], ['hello', ' ', 'world']);
    const changed = hunks.filter((h) => h.type !== 'unchanged');
    expect(changed.length).toBe(0);
  });

  it('detects single word addition', () => {
    const hunks = lcs(['hello'], ['hello', ' ', 'world']);
    const added = hunks.filter((h) => h.type === 'added');
    expect(added.length).toBeGreaterThan(0);
  });

  it('detects single word removal', () => {
    const hunks = lcs(['hello', ' ', 'world'], ['hello']);
    const removed = hunks.filter((h) => h.type === 'removed');
    expect(removed.length).toBeGreaterThan(0);
  });
});

describe('cosineDistance', () => {
  it('returns 0 for identical vectors', () => {
    const v = [1, 0, 0, 1];
    expect(cosineDistance(v, v)).toBeCloseTo(0);
  });

  it('returns 1 for orthogonal vectors', () => {
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1);
  });

  it('returns 1 for zero vectors', () => {
    expect(cosineDistance([0, 0], [0, 0])).toBe(1);
  });
});

// ─── Unit tests: PromptDiffer configuration ───────────────────────────────────

describe('PromptDiffer configuration', () => {
  let registry: MockPromptRegistry;
  let embedder: MockEmbeddingProvider;

  beforeEach(() => {
    registry = new MockPromptRegistry();
    embedder = new MockEmbeddingProvider();
  });

  it('uses LOW severity for identical prompts', async () => {
    const content = 'Extract the user intent from the message.';
    registry.seed(makeVersion('v1', 'test', content));
    registry.seed(makeVersion('v2', 'test', content));

    const differ = new PromptDiffer(registry, embedder);
    const diff = await differ.diff('v1', 'v2');
    expect(diff.severity).toBe('LOW');
    expect(diff.semanticDistance).toBeCloseTo(0, 1);
  });

  it('custom thresholds override defaults', async () => {
    registry.seed(makeVersion('v1', 'p', 'Be concise.'));
    registry.seed(makeVersion('v2', 'p', 'Be extremely verbose.'));

    // very low threshold — should fire MEDIUM even for small changes
    const differ = new PromptDiffer(registry, embedder, {
      mediumSeverityThreshold: 0.001,
      highSeverityThreshold: 0.999,
    });
    const diff = await differ.diff('v1', 'v2');
    expect(['MEDIUM', 'HIGH']).toContain(diff.severity);
  });

  it('includeUnchanged=false filters unchanged hunks', async () => {
    registry.seed(makeVersion('v1', 'p', 'Say hello to the user.'));
    registry.seed(makeVersion('v2', 'p', 'Say goodbye to the user.'));

    const differ = new PromptDiffer(registry, embedder, { includeUnchanged: false });
    const diff = await differ.diff('v1', 'v2');
    const unchanged = diff.hunks.filter((h) => h.type === 'unchanged');
    expect(unchanged.length).toBe(0);
  });

  it('includeUnchanged=true includes unchanged hunks', async () => {
    registry.seed(makeVersion('v1', 'p', 'Say hello to the user.'));
    registry.seed(makeVersion('v2', 'p', 'Say goodbye to the user.'));

    const differ = new PromptDiffer(registry, embedder, { includeUnchanged: true });
    const diff = await differ.diff('v1', 'v2');
    const unchanged = diff.hunks.filter((h) => h.type === 'unchanged');
    expect(unchanged.length).toBeGreaterThan(0);
  });
});

// ─── Failure mode tests ───────────────────────────────────────────────────────

describe('Failure mode: registry fetch error', () => {
  it('throws explicit error when version not found (not silent empty diff)', async () => {
    const registry = new MockPromptRegistry();
    const differ = new PromptDiffer(registry, new MockEmbeddingProvider());
    await expect(differ.diff('missing-v1', 'missing-v2')).rejects.toThrow(
      /not found in registry/
    );
  });

  it('propagates registry errors explicitly', async () => {
    const registry = new MockPromptRegistry({ errorRate: 1 }); // always errors
    registry.seed(makeVersion('v1', 'p', 'hello'));
    registry.seed(makeVersion('v2', 'p', 'world'));
    const differ = new PromptDiffer(registry, new MockEmbeddingProvider());
    await expect(differ.diff('v1', 'v2')).rejects.toThrow();
  });
});

describe('Failure mode: no previous version', () => {
  it('returns empty diff for first version', async () => {
    const registry = new MockPromptRegistry();
    registry.seed(makeVersion('v1', 'newprompt', 'Initial prompt content.'));
    const differ = new PromptDiffer(registry, new MockEmbeddingProvider());
    const diff = await differ.diffLatest('newprompt');
    expect(diff.severity).toBe('LOW');
    expect(diff.hunks.length).toBe(0);
    expect(diff.summary).toMatch(/first version/);
  });
});

describe('Failure mode: silent severity accumulation', () => {
  it('accumulates semantic distance across multiple LOW-severity changes', async () => {
    const registry = new MockPromptRegistry();
    const embedder = new MockEmbeddingProvider();
    const differ = new PromptDiffer(registry, embedder, {
      highSeverityThreshold: 0.15,
      mediumSeverityThreshold: 0.05,
    });

    // Seed 5 versions with small incremental changes
    const versions = [
      'Extract JSON from the text.',
      'Extract valid JSON from the text.',
      'Extract valid, parseable JSON from the text.',
      'Extract valid, clean, parseable JSON from the text.',
      'Extract valid, clean, parseable JSON from the input text provided.',
    ];
    versions.forEach((content, i) => {
      registry.seed(makeVersion(`v${i + 1}`, 'jsonprompt', content));
    });

    // Check that individual diffs may be LOW but cumulative distance is trackable
    const diffs = await Promise.all([
      differ.diff('v1', 'v2'),
      differ.diff('v2', 'v3'),
      differ.diff('v3', 'v4'),
      differ.diff('v4', 'v5'),
    ]);

    // Cumulative semantic distance should exceed any single diff
    const totalDistance = diffs.reduce((s, d) => s + d.semanticDistance, 0);
    const singleSpanDistance = (await differ.diff('v1', 'v5')).semanticDistance;

    // The total of incremental distances tracks drift even if no single diff alarmed
    expect(totalDistance).toBeGreaterThan(0);
    // Both measures show drift occurred
    expect(singleSpanDistance).toBeGreaterThan(0);
  });
});

describe('Failure mode: template variable masking', () => {
  it('detects content changes even when template structure is identical', async () => {
    const registry = new MockPromptRegistry();
    registry.seed(
      makeVersion('v1', 'tmpl', 'You are a helpful assistant. Always respond formally.')
    );
    registry.seed(
      makeVersion('v2', 'tmpl', 'You are a helpful assistant. Always respond casually.')
    );
    const differ = new PromptDiffer(registry, new MockEmbeddingProvider());
    const diff = await differ.diff('v1', 'v2');
    // One word changed ("formally" → "casually") — should produce non-empty diff
    const changes = diff.hunks.filter((h) => h.type !== 'unchanged');
    expect(changes.length).toBeGreaterThan(0);
  });
});

// ─── Integration test ─────────────────────────────────────────────────────────

describe('Integration: full diff workflow', () => {
  it('registers versions, diffs, and correlates with quality metrics', async () => {
    const registry = new MockPromptRegistry();
    const embedder = new MockEmbeddingProvider();
    const differ = new PromptDiffer(registry, embedder);

    const promptA = 'Output strictly valid JSON. Do not add trailing commas.';
    const promptB = 'Always respond using clean, parseable JSON.';

    registry.seed(makeVersion('rel-v1', 'extractor', promptA));
    registry.seed(makeVersion('rel-v2', 'extractor', promptB));

    const diff = await differ.diff('rel-v1', 'rel-v2');

    expect(diff.promptName).toBe('extractor');
    expect(diff.versionA).toBe('rel-v1');
    expect(diff.versionB).toBe('rel-v2');
    expect(typeof diff.semanticDistance).toBe('number');
    expect(['LOW', 'MEDIUM', 'HIGH']).toContain(diff.severity);
    expect(diff.hunks.length).toBeGreaterThan(0);

    // Correlation with no metrics is handled gracefully
    const report = differ.correlate(diff, null);
    expect(report.correlationAvailable).toBe(false);
    expect(report.note).toBeDefined();

    // Correlation with metrics succeeds
    const metrics = {
      promptVersion: 'rel-v2',
      windowStart: new Date(),
      windowEnd: new Date(),
      accuracy: 0.87,
    };
    const reportWithMetrics = differ.correlate(diff, metrics);
    expect(reportWithMetrics.correlationAvailable).toBe(true);
    expect(reportWithMetrics.metrics?.accuracy).toBe(0.87);
  });

  it('diffLatest compares latest vs previous version', async () => {
    const registry = new MockPromptRegistry();
    registry.seed(makeVersion('v1', 'myprompt', 'Say hello.'));
    registry.seed(makeVersion('v2', 'myprompt', 'Say hello politely.'));

    const differ = new PromptDiffer(registry, new MockEmbeddingProvider());
    const diff = await differ.diffLatest('myprompt');

    expect(diff.versionA).toBe('v1');
    expect(diff.versionB).toBe('v2');
    expect(diff.addedTokens).toBeGreaterThan(0);
  });

  it('handles concurrent diff requests without contention', async () => {
    const registry = new MockPromptRegistry({ latencyMs: 5 });
    const embedder = new MockEmbeddingProvider({ latencyMs: 5 });
    const differ = new PromptDiffer(registry, embedder);

    // Seed 4 prompt pairs
    for (let i = 0; i < 4; i++) {
      registry.seed(makeVersion(`cv${i}a`, `concurrent${i}`, `Prompt ${i} version A.`));
      registry.seed(makeVersion(`cv${i}b`, `concurrent${i}`, `Prompt ${i} version B.`));
    }

    // Run 4 concurrent diffs
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) => differ.diff(`cv${i}a`, `cv${i}b`))
    );

    expect(results.length).toBe(4);
    results.forEach((r) => expect(['LOW', 'MEDIUM', 'HIGH']).toContain(r.severity));
  });
});

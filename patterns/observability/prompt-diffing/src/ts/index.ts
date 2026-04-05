import {
  PromptDiff,
  PromptDifferConfig,
  PromptRegistry,
  PromptVersion,
  DiffHunk,
  HunkType,
  Severity,
  QualityMetrics,
  CorrelationReport,
} from './types.js';

const DEFAULTS: PromptDifferConfig = {
  diffGranularity: 'word',
  highSeverityThreshold: 0.15,
  mediumSeverityThreshold: 0.05,
  includeUnchanged: false,
  maxHunkContext: 3,
  correlationWindowMs: 4 * 60 * 60 * 1000, // 4 hours
};

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

export class PromptDiffer {
  private config: PromptDifferConfig;
  private registry: PromptRegistry;
  private embedder: EmbeddingProvider;

  constructor(
    registry: PromptRegistry,
    embedder: EmbeddingProvider,
    config: Partial<PromptDifferConfig> = {}
  ) {
    this.registry = registry;
    this.embedder = embedder;
    this.config = { ...DEFAULTS, ...config };
  }

  /**
   * Diff two specific versions by ID.
   * Throws if either version doesn't exist (explicit error > silent wrong diff).
   */
  async diff(versionAId: string, versionBId: string): Promise<PromptDiff> {
    const [vA, vB] = await Promise.all([
      this.fetchOrThrow(versionAId),
      this.fetchOrThrow(versionBId),
    ]);

    return this.computeDiff(vA, vB);
  }

  /**
   * Diff the latest version of a prompt against its predecessor.
   * Useful for post-commit hooks — call after every prompt save.
   */
  async diffLatest(promptName: string): Promise<PromptDiff> {
    const latest = await this.registry.getLatest(promptName);
    if (!latest) {
      throw new Error(`No versions found for prompt "${promptName}"`);
    }
    const previous = await this.registry.getPrevious(latest.id);
    if (!previous) {
      // First version — no previous to compare against
      return emptyDiff(latest.name, latest.id, latest.id);
    }
    return this.computeDiff(previous, latest);
  }

  /**
   * Join a diff result with quality metrics for the affected version window.
   * Correlation is async and best-effort; callers should not block on it.
   */
  correlate(diff: PromptDiff, metrics: QualityMetrics | null): CorrelationReport {
    if (!metrics) {
      return {
        diff,
        metrics: null,
        correlationAvailable: false,
        note: 'No quality metrics provided — ensure metric pipeline attaches prompt_version to each LLM span',
      };
    }
    return {
      diff,
      metrics,
      correlationAvailable: true,
    };
  }

  private async computeDiff(vA: PromptVersion, vB: PromptVersion): Promise<PromptDiff> {
    const [hunks, [embA, embB]] = await Promise.all([
      Promise.resolve(tokenizeDiff(vA.content, vB.content, this.config)),
      Promise.all([this.embedder.embed(vA.content), this.embedder.embed(vB.content)]),
    ]);

    const semanticDistance = cosineDistance(embA, embB);
    const severity = this.classifySeverity(semanticDistance);

    const addedTokens = hunks.filter((h) => h.type === 'added').reduce((s, h) => s + wordCount(h.value), 0);
    const removedTokens = hunks.filter((h) => h.type === 'removed').reduce((s, h) => s + wordCount(h.value), 0);

    const filteredHunks = this.config.includeUnchanged
      ? hunks
      : hunks.filter((h) => h.type !== 'unchanged');

    return {
      versionA: vA.id,
      versionB: vB.id,
      promptName: vA.name,
      hunks: filteredHunks,
      severity,
      semanticDistance,
      addedTokens,
      removedTokens,
      summary: buildSummary(severity, semanticDistance, addedTokens, removedTokens),
      timestamp: new Date(),
    };
  }

  private classifySeverity(distance: number): Severity {
    if (distance >= this.config.highSeverityThreshold) return 'HIGH';
    if (distance >= this.config.mediumSeverityThreshold) return 'MEDIUM';
    return 'LOW';
  }

  private async fetchOrThrow(versionId: string): Promise<PromptVersion> {
    const version = await this.registry.get(versionId);
    if (!version) {
      throw new Error(`Prompt version "${versionId}" not found in registry`);
    }
    return version;
  }
}

// ─── Diff algorithm ───────────────────────────────────────────────────────────

/**
 * Word-level diff using Myers' LCS algorithm.
 * Treats punctuation as separate tokens so "word." and "word," produce a diff.
 */
function tokenizeDiff(
  textA: string,
  textB: string,
  config: PromptDifferConfig
): DiffHunk[] {
  const tokensA = tokenize(textA, config.diffGranularity);
  const tokensB = tokenize(textB, config.diffGranularity);
  const ops = lcs(tokensA, tokensB);
  return ops;
}

function tokenize(text: string, granularity: PromptDifferConfig['diffGranularity']): string[] {
  switch (granularity) {
    case 'word':
      // Split on whitespace but preserve it as part of the token for reconstruction
      return text.split(/(\s+)/).filter(Boolean);
    case 'sentence':
      return text.split(/(?<=[.!?])\s+/).filter(Boolean);
    case 'paragraph':
      return text.split(/\n\n+/).filter(Boolean);
  }
}

/**
 * Longest Common Subsequence — produces add/remove/unchanged hunks.
 * O(n*m) time; adequate for prompts (typically <5K tokens).
 */
function lcs(a: string[], b: string[]): DiffHunk[] {
  const m = a.length;
  const n = b.length;

  // dp[i][j] = length of LCS of a[0..i-1] and b[0..j-1]
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to reconstruct hunks
  const result: DiffHunk[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.unshift({ type: 'unchanged', value: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: 'added', value: b[j - 1] });
      j--;
    } else {
      result.unshift({ type: 'removed', value: a[i - 1] });
      i--;
    }
  }

  return mergeConsecutive(result);
}

/** Merge consecutive hunks of the same type for cleaner output */
function mergeConsecutive(hunks: DiffHunk[]): DiffHunk[] {
  if (hunks.length === 0) return hunks;
  const merged: DiffHunk[] = [{ ...hunks[0] }];
  for (let i = 1; i < hunks.length; i++) {
    const last = merged[merged.length - 1];
    if (last.type === hunks[i].type) {
      last.value += hunks[i].value;
    } else {
      merged.push({ ...hunks[i] });
    }
  }
  return merged;
}

// ─── Embedding utilities ──────────────────────────────────────────────────────

function cosineDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('Embedding dimension mismatch');
  const dot = a.reduce((s, v, i) => s + v * b[i], 0);
  const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
  if (magA === 0 || magB === 0) return 1; // treat zero vectors as maximally distant
  return 1 - dot / (magA * magB);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function buildSummary(
  severity: Severity,
  distance: number,
  added: number,
  removed: number
): string {
  const parts: string[] = [`[${severity}]`];
  if (added > 0) parts.push(`+${added} words`);
  if (removed > 0) parts.push(`-${removed} words`);
  parts.push(`semantic distance: ${distance.toFixed(3)}`);
  return parts.join(' — ');
}

function emptyDiff(promptName: string, versionId: string, prevId: string): PromptDiff {
  return {
    versionA: prevId,
    versionB: versionId,
    promptName,
    hunks: [],
    severity: 'LOW',
    semanticDistance: 0,
    addedTokens: 0,
    removedTokens: 0,
    summary: '[LOW] — first version, no previous to compare',
    timestamp: new Date(),
  };
}

export { cosineDistance, tokenize, lcs, mergeConsecutive };
export type { PromptDifferConfig };

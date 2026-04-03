/**
 * Snapshot Testing pattern implementation.
 *
 * Core flow:
 *  1. Run the prompt with test inputs to get a live output
 *  2. Extract characteristics (embedding, structure, key phrases, length)
 *  3. Compare against stored baseline characteristics
 *  4. Pass if similarity >= threshold AND structural/phrase constraints hold
 *  5. Fail with a structured delta showing exactly what changed
 *
 * On first run (no stored baseline), the live characteristics are stored
 * as the baseline and the test is marked as "baseline created" rather
 * than pass/fail. This prevents silently accepting a degraded first run.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type {
  SnapshotTestCase,
  SnapshotCharacteristics,
  SnapshotDelta,
  SnapshotResult,
  SnapshotRunnerConfig,
  LLMProvider,
  StructuralFingerprint,
} from "./types.js";

export { MockProvider } from "./mock-provider.js";
export type {
  SnapshotTestCase,
  SnapshotCharacteristics,
  SnapshotDelta,
  SnapshotResult,
  SnapshotRunnerConfig,
  LLMProvider,
  StructuralFingerprint,
} from "./types.js";

const DEFAULT_CONFIG: SnapshotRunnerConfig = {
  snapshotDir: ".snapshots",
  similarityThreshold: 0.85,
  structuralMatchRequired: true,
  keyPhrasesRequired: false,
  updateMode: false,
};

// ─── Characteristic Extraction ───────────────────────────────────────────────

function interpolateTemplate(
  template: string,
  inputs: Record<string, unknown>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    String(inputs[key] ?? `{{${key}}}`)
  );
}

function extractStructuralFingerprint(
  text: string
): StructuralFingerprint | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    const topLevelKeys = Object.keys(obj).sort();
    const keyTypes: Record<string, string> = {};
    for (const key of topLevelKeys) {
      const val = obj[key];
      if (val === null) {
        keyTypes[key] = "null";
      } else if (Array.isArray(val)) {
        keyTypes[key] = "array";
      } else {
        keyTypes[key] = typeof val;
      }
    }
    return { topLevelKeys, keyTypes };
  } catch {
    return null;
  }
}

async function extractCharacteristics(
  text: string,
  provider: LLMProvider
): Promise<SnapshotCharacteristics> {
  const embeddingVector = await provider.embed(text);
  return {
    embeddingVector,
    charCount: text.length,
    structuralFingerprint: extractStructuralFingerprint(text),
    // Key phrases extracted as lowercase words >= 4 chars appearing >= 2 times.
    // In production, replace with domain-specific extraction or manual curation.
    keyPhrases: extractKeyPhrases(text),
    capturedAt: new Date().toISOString(),
  };
}

function extractKeyPhrases(text: string): string[] {
  const lower = text.toLowerCase();
  const words = lower.match(/\b[a-z]{4,}\b/g) ?? [];
  const freq: Record<string, number> = {};
  for (const word of words) {
    freq[word] = (freq[word] ?? 0) + 1;
  }
  return Object.entries(freq)
    .filter(([, count]) => count >= 2)
    .map(([word]) => word)
    .slice(0, 20); // cap to avoid noise
}

// ─── Similarity Computation ───────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Delta Computation ───────────────────────────────────────────────────────

function computeDelta(
  baseline: SnapshotCharacteristics,
  live: SnapshotCharacteristics
): SnapshotDelta {
  const semanticSimilarity = cosineSimilarity(
    baseline.embeddingVector,
    live.embeddingVector
  );

  const lengthRatioChange =
    baseline.charCount > 0
      ? live.charCount / baseline.charCount - 1
      : 0;

  const missingKeyPhrases = baseline.keyPhrases.filter(
    (phrase) => !live.keyPhrases.includes(phrase)
  );

  const structuralChanges: string[] = [];
  if (baseline.structuralFingerprint && live.structuralFingerprint) {
    const bKeys = new Set(baseline.structuralFingerprint.topLevelKeys);
    const lKeys = new Set(live.structuralFingerprint.topLevelKeys);
    for (const k of bKeys) {
      if (!lKeys.has(k)) structuralChanges.push(`removed key: ${k}`);
    }
    for (const k of lKeys) {
      if (!bKeys.has(k)) structuralChanges.push(`added key: ${k}`);
    }
    for (const k of [...bKeys].filter((k) => lKeys.has(k))) {
      const bType = baseline.structuralFingerprint.keyTypes[k];
      const lType = live.structuralFingerprint.keyTypes[k];
      if (bType !== lType) {
        structuralChanges.push(`type change for "${k}": ${bType} → ${lType}`);
      }
    }
  } else if (baseline.structuralFingerprint && !live.structuralFingerprint) {
    structuralChanges.push("output is no longer valid JSON");
  } else if (!baseline.structuralFingerprint && live.structuralFingerprint) {
    structuralChanges.push("output is now valid JSON (was plain text)");
  }

  return { semanticSimilarity, lengthRatioChange, missingKeyPhrases, structuralChanges };
}

// ─── Snapshot Store ───────────────────────────────────────────────────────────

export class SnapshotStore {
  private readonly dir: string;

  constructor(snapshotDir: string) {
    this.dir = snapshotDir;
  }

  private filePath(id: string): string {
    // Sanitise ID to prevent path traversal
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.dir, `${safe}.json`);
  }

  load(id: string): SnapshotCharacteristics | null {
    const path = this.filePath(id);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as SnapshotCharacteristics;
    } catch {
      return null;
    }
  }

  save(id: string, characteristics: SnapshotCharacteristics): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
    writeFileSync(
      this.filePath(id),
      JSON.stringify(characteristics, null, 2),
      "utf8"
    );
  }

  exists(id: string): boolean {
    return existsSync(this.filePath(id));
  }
}

// ─── Snapshot Runner ─────────────────────────────────────────────────────────

export class SnapshotRunner {
  private config: SnapshotRunnerConfig;
  private provider: LLMProvider;
  private store: SnapshotStore;

  constructor(provider: LLMProvider, config: Partial<SnapshotRunnerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.provider = provider;
    this.store = new SnapshotStore(this.config.snapshotDir);
  }

  /**
   * Run a single test case.
   *
   * Returns null when a new baseline is created (first run) rather than
   * a pass/fail result — callers should treat null as "needs review"
   * rather than a test failure.
   */
  async run(testCase: SnapshotTestCase): Promise<SnapshotResult | null> {
    const prompt = interpolateTemplate(testCase.promptTemplate, testCase.inputs);
    const output = await this.provider.complete(prompt);
    const live = await extractCharacteristics(output, this.provider);

    // Update mode: overwrite baseline and return null (no pass/fail)
    if (this.config.updateMode) {
      this.store.save(testCase.id, live);
      return null;
    }

    const stored = this.store.load(testCase.id);

    // First run: store baseline, return null to signal "needs review"
    if (!stored) {
      this.store.save(testCase.id, live);
      return null;
    }

    // Use inline override if provided, otherwise use stored baseline
    const baseline: SnapshotCharacteristics = testCase.expectedCharacteristics
      ? { ...stored, ...testCase.expectedCharacteristics }
      : stored;

    return this.compare(testCase.id, baseline, live);
  }

  /**
   * Run multiple test cases and collect results.
   * Null results (new baselines) are excluded from the returned array.
   */
  async runAll(
    testCases: SnapshotTestCase[]
  ): Promise<{ results: SnapshotResult[]; newBaselines: string[] }> {
    const results: SnapshotResult[] = [];
    const newBaselines: string[] = [];

    for (const tc of testCases) {
      const result = await this.run(tc);
      if (result === null) {
        newBaselines.push(tc.id);
      } else {
        results.push(result);
      }
    }

    return { results, newBaselines };
  }

  private compare(
    testCaseId: string,
    baseline: SnapshotCharacteristics,
    live: SnapshotCharacteristics
  ): SnapshotResult {
    const delta = computeDelta(baseline, live);
    const passed = this.evaluate(delta);
    return { testCaseId, passed, similarity: delta.semanticSimilarity, delta, baseline, live };
  }

  private evaluate(delta: SnapshotDelta): boolean {
    if (delta.semanticSimilarity < this.config.similarityThreshold) {
      return false;
    }
    if (
      this.config.structuralMatchRequired &&
      delta.structuralChanges.length > 0
    ) {
      return false;
    }
    if (
      this.config.keyPhrasesRequired &&
      delta.missingKeyPhrases.length > 0
    ) {
      return false;
    }
    return true;
  }
}

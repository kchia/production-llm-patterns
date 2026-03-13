/**
 * Output Quality Monitoring — Core Implementation
 *
 * Async scoring pipeline that samples production LLM interactions,
 * runs registered scorers, aggregates results per dimension, and
 * alerts on quality degradation. Designed to run off the critical
 * path — scoring happens after the response is sent.
 */

import {
  LLMInteraction,
  Scorer,
  ScoreResult,
  StoredScore,
  QualitySnapshot,
  BaselineEntry,
  QualityAlert,
  HealthStatus,
  TimeWindow,
  QualityMonitorConfig,
  DEFAULT_CONFIG,
  ScorerTimeoutError,
} from './types.js';

// --- Built-in Scorers ---

/**
 * Scores output length relative to a configurable expected range.
 * Outputs too short or too long score lower.
 */
export class LengthScorer implements Scorer {
  name = 'length';
  private minLength: number;
  private maxLength: number;

  constructor(minLength = 20, maxLength = 5000) {
    this.minLength = minLength;
    this.maxLength = maxLength;
  }

  async score(interaction: LLMInteraction): Promise<ScoreResult> {
    const start = performance.now();
    const len = interaction.output.length;

    let value: number;
    if (len < this.minLength) {
      value = len / this.minLength;
    } else if (len > this.maxLength) {
      value = Math.max(0, 1 - (len - this.maxLength) / this.maxLength);
    } else {
      value = 1.0;
    }

    return {
      scorerName: this.name,
      value: Math.max(0, Math.min(1, value)),
      details: { length: len, minLength: this.minLength, maxLength: this.maxLength },
      durationMs: performance.now() - start,
    };
  }
}

/**
 * Checks whether the output contains expected format markers.
 * Useful for structured outputs (JSON, markdown, etc.).
 */
export class FormatScorer implements Scorer {
  name = 'format';
  private patterns: RegExp[];

  constructor(patterns: RegExp[] = []) {
    this.patterns = patterns;
  }

  async score(interaction: LLMInteraction): Promise<ScoreResult> {
    const start = performance.now();

    if (this.patterns.length === 0) {
      return { scorerName: this.name, value: 1.0, durationMs: performance.now() - start };
    }

    const matches = this.patterns.filter(p => p.test(interaction.output)).length;
    const value = matches / this.patterns.length;

    return {
      scorerName: this.name,
      value,
      details: { matchedPatterns: matches, totalPatterns: this.patterns.length },
      durationMs: performance.now() - start,
    };
  }
}

/**
 * Scores based on keyword/phrase presence in the output.
 * Useful for checking that outputs contain domain-specific terms
 * or required content elements.
 */
export class KeywordScorer implements Scorer {
  name = 'keyword';
  private keywords: string[];
  private minMatchRatio: number;

  constructor(keywords: string[], minMatchRatio = 0.3) {
    this.keywords = keywords.map(k => k.toLowerCase());
    this.minMatchRatio = minMatchRatio;
  }

  async score(interaction: LLMInteraction): Promise<ScoreResult> {
    const start = performance.now();
    const outputLower = interaction.output.toLowerCase();
    const matches = this.keywords.filter(k => outputLower.includes(k)).length;
    const ratio = this.keywords.length > 0 ? matches / this.keywords.length : 1;

    // Score ramps from 0 to 1 as ratio goes from 0 to minMatchRatio
    const value = Math.min(1, ratio / this.minMatchRatio);

    return {
      scorerName: this.name,
      value,
      details: { matchedKeywords: matches, totalKeywords: this.keywords.length, ratio },
      durationMs: performance.now() - start,
    };
  }
}

// --- Sampler ---

export class Sampler {
  private rate: number;
  private overrides: Map<string, number> = new Map();

  constructor(rate: number) {
    this.rate = Math.max(0, Math.min(1, rate));
  }

  /** Override sample rate for a specific dimension value */
  setOverride(dimensionValue: string, rate: number): void {
    this.overrides.set(dimensionValue, Math.max(0, Math.min(1, rate)));
  }

  shouldSample(interaction: LLMInteraction): boolean {
    // Check dimension-specific overrides
    for (const [key, overrideRate] of this.overrides) {
      if (
        interaction.promptTemplate === key ||
        interaction.model === key ||
        interaction.metadata[key] !== undefined
      ) {
        return Math.random() < overrideRate;
      }
    }
    return Math.random() < this.rate;
  }

  getRate(): number {
    return this.rate;
  }

  setRate(rate: number): void {
    this.rate = Math.max(0, Math.min(1, rate));
  }
}

// --- Score Store ---

export class ScoreStore {
  private scores: StoredScore[] = [];
  private maxSize: number;

  constructor(maxSize = 100_000) {
    this.maxSize = maxSize;
  }

  add(score: StoredScore): void {
    this.scores.push(score);
    // Evict oldest entries when store is full
    if (this.scores.length > this.maxSize) {
      this.scores = this.scores.slice(this.scores.length - this.maxSize);
    }
  }

  query(window: TimeWindow, dimensionFilter?: Record<string, string>): StoredScore[] {
    return this.scores.filter(s => {
      if (s.timestamp < window.startMs || s.timestamp > window.endMs) return false;
      if (dimensionFilter) {
        for (const [key, val] of Object.entries(dimensionFilter)) {
          if (s.dimensions[key] !== val) return false;
        }
      }
      return true;
    });
  }

  size(): number {
    return this.scores.length;
  }

  clear(): void {
    this.scores = [];
  }
}

// --- Aggregator ---

function computePercentile(sorted: number[], percentile: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export class Aggregator {
  private store: ScoreStore;
  private config: QualityMonitorConfig;

  constructor(store: ScoreStore, config: QualityMonitorConfig) {
    this.store = store;
    this.config = config;
  }

  getSnapshot(dimension: string, dimensionValue: string, window?: TimeWindow): QualitySnapshot {
    const now = Date.now();
    const tw: TimeWindow = window ?? {
      startMs: now - this.config.windowSizeMs,
      endMs: now,
    };

    const entries = this.store.query(tw, { [dimension]: dimensionValue });

    const scoresByScorer: Record<string, number[]> = {};
    for (const entry of entries) {
      for (const score of entry.scores) {
        if (!scoresByScorer[score.scorerName]) {
          scoresByScorer[score.scorerName] = [];
        }
        scoresByScorer[score.scorerName].push(score.value);
      }
    }

    const scores: QualitySnapshot['scores'] = {};
    for (const [scorerName, values] of Object.entries(scoresByScorer)) {
      const sorted = [...values].sort((a, b) => a - b);
      const sum = sorted.reduce((a, b) => a + b, 0);
      scores[scorerName] = {
        mean: sorted.length > 0 ? sum / sorted.length : 0,
        p50: computePercentile(sorted, 50),
        p95: computePercentile(sorted, 95),
        min: sorted[0] ?? 0,
        max: sorted[sorted.length - 1] ?? 0,
      };
    }

    return {
      dimension: `${dimension}:${dimensionValue}`,
      window: tw,
      sampleCount: entries.length,
      scores,
    };
  }
}

// --- Baseline Tracker ---

export class BaselineTracker {
  private baselines: Map<string, BaselineEntry> = new Map();
  private decay: number;

  constructor(decay: number) {
    this.decay = decay;
  }

  private key(dimension: string, scorerName: string): string {
    return `${dimension}::${scorerName}`;
  }

  update(dimension: string, scorerName: string, value: number): void {
    const k = this.key(dimension, scorerName);
    const existing = this.baselines.get(k);

    if (!existing) {
      this.baselines.set(k, {
        dimension,
        scorerName,
        value,
        sampleCount: 1,
        lastUpdated: Date.now(),
      });
      return;
    }

    // Exponential moving average: baseline slowly tracks toward current value
    existing.value = this.decay * existing.value + (1 - this.decay) * value;
    existing.sampleCount++;
    existing.lastUpdated = Date.now();
  }

  get(dimension: string, scorerName: string): BaselineEntry | undefined {
    return this.baselines.get(this.key(dimension, scorerName));
  }

  getAll(): BaselineEntry[] {
    return [...this.baselines.values()];
  }

  clear(): void {
    this.baselines.clear();
  }
}

// --- Quality Monitor (main orchestrator) ---

export class QualityMonitor {
  private config: QualityMonitorConfig;
  private scorers: Scorer[] = [];
  private sampler: Sampler;
  private store: ScoreStore;
  private aggregator: Aggregator;
  private baselineTracker: BaselineTracker;

  // Metrics for observability
  private metrics = {
    recorded: 0,
    sampled: 0,
    scored: 0,
    scorerTimeouts: 0,
    alertsFired: 0,
    queueDropped: 0,
  };

  private processingQueue = 0;

  constructor(config: Partial<QualityMonitorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sampler = new Sampler(this.config.sampleRate);
    this.store = new ScoreStore();
    this.aggregator = new Aggregator(this.store, this.config);
    this.baselineTracker = new BaselineTracker(this.config.baselineDecay);
  }

  /** Register a scorer for the pipeline */
  registerScorer(scorer: Scorer): void {
    this.scorers.push(scorer);
  }

  /** Record a completed LLM interaction for potential scoring */
  async record(interaction: LLMInteraction): Promise<void> {
    this.metrics.recorded++;

    if (!this.sampler.shouldSample(interaction)) {
      return;
    }

    // Backpressure: drop if queue is full rather than silently growing
    if (this.processingQueue >= this.config.maxQueueDepth) {
      this.metrics.queueDropped++;
      return;
    }

    this.metrics.sampled++;
    this.processingQueue++;

    try {
      await this.scoreAndStore(interaction);
    } finally {
      this.processingQueue--;
    }
  }

  private async scoreAndStore(interaction: LLMInteraction): Promise<void> {
    const results: ScoreResult[] = [];

    for (const scorer of this.scorers) {
      try {
        const result = await withTimeout(
          scorer.score(interaction),
          this.config.scorerTimeoutMs,
          scorer.name
        );
        results.push(result);
      } catch (err) {
        if (err instanceof ScorerTimeoutError) {
          this.metrics.scorerTimeouts++;
        }
        // Scorer failures don't block the pipeline — skip this scorer
      }
    }

    if (results.length === 0) return;

    this.metrics.scored++;

    // Extract dimensions from the interaction
    const dimensions: Record<string, string> = {};
    for (const dim of this.config.dimensions) {
      if (dim === 'promptTemplate' && interaction.promptTemplate) {
        dimensions[dim] = interaction.promptTemplate;
      } else if (dim === 'model') {
        dimensions[dim] = interaction.model;
      } else if (interaction.metadata[dim]) {
        dimensions[dim] = interaction.metadata[dim];
      }
    }

    const storedScore: StoredScore = {
      interactionId: interaction.id,
      timestamp: interaction.timestamp,
      dimensions,
      scores: results,
    };

    this.store.add(storedScore);

    // Update baselines and check alerts for each dimension
    for (const [dimKey, dimValue] of Object.entries(dimensions)) {
      const dimLabel = `${dimKey}:${dimValue}`;
      for (const result of results) {
        this.baselineTracker.update(dimLabel, result.scorerName, result.value);
        this.checkAlerts(dimLabel, result);
      }
    }
  }

  private checkAlerts(dimension: string, result: ScoreResult): void {
    // Check absolute threshold
    if (result.value < this.config.absoluteThreshold) {
      this.fireAlert({
        severity: result.value < this.config.absoluteThreshold * 0.5 ? 'critical' : 'warning',
        dimension,
        scorerName: result.scorerName,
        currentValue: result.value,
        threshold: this.config.absoluteThreshold,
        message: `Quality score ${result.value.toFixed(3)} below absolute threshold ${this.config.absoluteThreshold}`,
        timestamp: Date.now(),
      });
    }

    // Check relative threshold (drop from baseline)
    const baseline = this.baselineTracker.get(dimension, result.scorerName);
    if (baseline && baseline.sampleCount >= this.config.minSamplesForAlert) {
      const drop = baseline.value - result.value;
      if (drop > this.config.relativeThreshold) {
        this.fireAlert({
          severity: drop > this.config.relativeThreshold * 2 ? 'critical' : 'warning',
          dimension,
          scorerName: result.scorerName,
          currentValue: result.value,
          threshold: this.config.relativeThreshold,
          baselineValue: baseline.value,
          message: `Quality score dropped ${drop.toFixed(3)} from baseline ${baseline.value.toFixed(3)}`,
          timestamp: Date.now(),
        });
      }
    }
  }

  private fireAlert(alert: QualityAlert): void {
    this.metrics.alertsFired++;
    this.config.onAlert?.(alert);
  }

  /** Get quality snapshot for a specific dimension */
  getScores(dimension: string, dimensionValue: string, window?: TimeWindow): QualitySnapshot {
    return this.aggregator.getSnapshot(dimension, dimensionValue, window);
  }

  /** Check overall health */
  checkHealth(dimension?: string): HealthStatus {
    const baselines = this.baselineTracker.getAll();
    const status: HealthStatus = { healthy: true, dimensions: {} };

    const relevantBaselines = dimension
      ? baselines.filter(b => b.dimension === dimension)
      : baselines;

    for (const baseline of relevantBaselines) {
      if (!status.dimensions[baseline.dimension]) {
        status.dimensions[baseline.dimension] = {
          healthy: true,
          scores: {},
          alerts: [],
        };
      }

      const dimStatus = status.dimensions[baseline.dimension];
      dimStatus.scores[baseline.scorerName] = baseline.value;

      if (baseline.value < this.config.absoluteThreshold) {
        dimStatus.healthy = false;
        status.healthy = false;
        dimStatus.alerts.push({
          severity: 'warning',
          dimension: baseline.dimension,
          scorerName: baseline.scorerName,
          currentValue: baseline.value,
          threshold: this.config.absoluteThreshold,
          message: `Baseline ${baseline.value.toFixed(3)} below threshold`,
          timestamp: Date.now(),
        });
      }
    }

    return status;
  }

  /** Get the sampler for configuration adjustments */
  getSampler(): Sampler {
    return this.sampler;
  }

  /** Get the baseline tracker for inspection */
  getBaselineTracker(): BaselineTracker {
    return this.baselineTracker;
  }

  /** Get the score store for direct queries */
  getScoreStore(): ScoreStore {
    return this.store;
  }

  /** Get internal metrics for monitoring the monitor */
  getMetrics(): Readonly<typeof this.metrics> {
    return { ...this.metrics };
  }

  /** Reset all state */
  reset(): void {
    this.store.clear();
    this.baselineTracker.clear();
    this.metrics = {
      recorded: 0,
      sampled: 0,
      scored: 0,
      scorerTimeouts: 0,
      alertsFired: 0,
      queueDropped: 0,
    };
    this.processingQueue = 0;
  }
}

// --- Utility ---

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ScorerTimeoutError(label, timeoutMs)),
      timeoutMs
    );

    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

// --- Exports ---

export {
  LLMInteraction,
  Scorer,
  ScoreResult,
  StoredScore,
  QualitySnapshot,
  BaselineEntry,
  QualityAlert,
  AlertSeverity,
  AlertHandler,
  HealthStatus,
  TimeWindow,
  QualityMonitorConfig,
  DEFAULT_CONFIG,
  ScorerTimeoutError,
  QueueOverflowError,
} from './types.js';

export { MockProvider, MockProviderConfig, ProviderError } from './mock-provider.js';

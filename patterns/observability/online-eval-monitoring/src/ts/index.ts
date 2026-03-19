import { randomUUID } from 'crypto';
import {
  AlertCallback,
  AlertEvent,
  AlertLevel,
  EvalContext,
  OnlineEvalConfig,
  ScoreCallback,
  ScoreResult,
  Scorer,
  TimeWindow,
  Trace,
} from './types.js';

const DEFAULTS: Required<OnlineEvalConfig> = {
  queueSize: 1000,
  asyncTimeoutMs: 30_000,
  alertThreshold: 0.7,
  criticalThreshold: 0.5,
  windowSize: 100,
};

interface QueuedJob {
  trace: Trace;
  scorer: Scorer;
}

/**
 * OnlineEvalMonitor wraps application handlers to sample production traces
 * and run eval scorers asynchronously — zero impact on request latency.
 *
 * Design: the queue is a fixed-size ring buffer. When full, the oldest job
 * is dropped rather than blocking the caller. This keeps memory bounded and
 * ensures the queue never becomes a backpressure source on the application.
 */
export class OnlineEvalMonitor {
  private readonly scorers: Scorer[] = [];
  private readonly scoreCallbacks: ScoreCallback[] = [];
  private readonly alertCallbacks: AlertCallback[] = [];

  // Rolling score window per scorer: scorerName → circular array of recent scores
  private readonly scoreWindows: Map<string, number[]> = new Map();
  private readonly scoreWindowIndex: Map<string, number> = new Map();
  private readonly scoreWindowFull: Map<string, boolean> = new Map();

  // Append-only score log for time-windowed queries
  private readonly scoreLog: ScoreResult[] = [];

  // Async eval queue
  private readonly queue: QueuedJob[] = [];
  private isProcessing = false;

  private readonly config: Required<OnlineEvalConfig>;

  // Metrics
  private droppedJobs = 0;
  private totalScored = 0;
  private totalErrors = 0;

  constructor(config: OnlineEvalConfig = {}) {
    this.config = { ...DEFAULTS, ...config };
  }

  addScorer(scorer: Scorer): void {
    this.scorers.push(scorer);
    // Pre-allocate rolling window buffer for this scorer
    this.scoreWindows.set(scorer.name, new Array(this.config.windowSize).fill(0));
    this.scoreWindowIndex.set(scorer.name, 0);
    this.scoreWindowFull.set(scorer.name, false);
  }

  onScore(callback: ScoreCallback): void {
    this.scoreCallbacks.push(callback);
  }

  onAlert(callback: AlertCallback): void {
    this.alertCallbacks.push(callback);
  }

  /**
   * Wrap an async handler. The handler runs immediately and its result is
   * returned to the caller. Sampling and eval happen asynchronously after.
   */
  async wrap<T>(handler: () => Promise<T>, context: EvalContext): Promise<T> {
    const result = await handler();

    // Capture output as string for eval. If result is not a string, serialize it.
    const output = typeof result === 'string' ? result : JSON.stringify(result);
    const trace: Trace = {
      id: randomUUID(),
      timestamp: Date.now(),
      context: { ...context, output },
    };

    // Schedule eval jobs for each scorer that passes its sampling gate
    for (const scorer of this.scorers) {
      if (Math.random() < scorer.samplingRate) {
        this.enqueue({ trace, scorer });
      }
    }

    // Kick off queue processing without awaiting — fire and forget
    void this.processQueue();

    return result;
  }

  getScores(scorerName: string, window: TimeWindow): ScoreResult[] {
    return this.scoreLog.filter(
      (r) =>
        r.scorerName === scorerName &&
        r.timestamp >= window.startMs &&
        r.timestamp <= window.endMs
    );
  }

  getRollingMean(scorerName: string): number | null {
    const window = this.scoreWindows.get(scorerName);
    const isFull = this.scoreWindowFull.get(scorerName);
    const index = this.scoreWindowIndex.get(scorerName);
    if (!window || index === undefined) return null;

    const count = isFull ? window.length : index;
    if (count === 0) return null;

    let sum = 0;
    for (let i = 0; i < count; i++) sum += window[i];
    return sum / count;
  }

  getMetrics() {
    return {
      queueDepth: this.queue.length,
      droppedJobs: this.droppedJobs,
      totalScored: this.totalScored,
      totalErrors: this.totalErrors,
    };
  }

  // --- Private ---

  private enqueue(job: QueuedJob): void {
    if (this.queue.length >= this.config.queueSize) {
      // Drop the oldest job to keep memory bounded
      this.queue.shift();
      this.droppedJobs++;
    }
    this.queue.push(job);
  }

  private async processQueue(): Promise<void> {
    // Guard against concurrent processing — only one consumer loop at a time
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        await this.runJob(job);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async runJob(job: QueuedJob): Promise<void> {
    const { trace, scorer } = job;
    const start = Date.now();

    try {
      // Race the scorer against the configured timeout
      const score = await Promise.race([
        scorer.score(trace),
        timeout(this.config.asyncTimeoutMs),
      ]);

      const result: ScoreResult = {
        traceId: trace.id,
        scorerName: scorer.name,
        score,
        timestamp: Date.now(),
        durationMs: Date.now() - start,
      };

      this.recordScore(result);
      this.totalScored++;
    } catch {
      // Log errors but don't let them surface — eval failures are non-fatal
      this.totalErrors++;
    }
  }

  private recordScore(result: ScoreResult): void {
    this.scoreLog.push(result);

    // Update rolling window (circular buffer)
    const window = this.scoreWindows.get(result.scorerName)!;
    const index = this.scoreWindowIndex.get(result.scorerName)!;
    window[index] = result.score;
    const nextIndex = (index + 1) % window.length;
    this.scoreWindowIndex.set(result.scorerName, nextIndex);
    if (nextIndex === 0) {
      this.scoreWindowFull.set(result.scorerName, true);
    }

    // Notify score listeners
    for (const cb of this.scoreCallbacks) cb(result);

    // Check alert thresholds against rolling mean
    const mean = this.getRollingMean(result.scorerName);
    if (mean !== null) {
      let level: AlertLevel | null = null;
      if (mean < this.config.criticalThreshold) level = 'critical';
      else if (mean < this.config.alertThreshold) level = 'warning';

      if (level) {
        const event: AlertEvent = {
          level,
          scorerName: result.scorerName,
          score: result.score,
          rollingMean: mean,
          traceId: result.traceId,
        };
        for (const cb of this.alertCallbacks) cb(event);
      }
    }
  }
}

/** Rejects after ms — used to enforce asyncTimeoutMs per scorer */
function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Scorer timed out after ${ms}ms`)), ms)
  );
}

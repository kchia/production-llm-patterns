/**
 * Output Quality Monitoring — Type definitions
 *
 * Core types for the quality monitoring pipeline: interactions,
 * scorers, aggregation windows, and alerting.
 */

// --- LLM Interaction Types ---

export interface LLMInteraction {
  id: string;
  input: string;
  output: string;
  model: string;
  promptTemplate?: string;
  metadata: Record<string, string>;
  timestamp: number;
  latencyMs: number;
  tokenCount?: { input: number; output: number };
}

// --- Scorer Types ---

export interface ScoreResult {
  scorerName: string;
  value: number; // 0.0 - 1.0
  details?: Record<string, unknown>;
  durationMs: number;
}

export interface Scorer {
  name: string;
  score(interaction: LLMInteraction): Promise<ScoreResult>;
}

// --- Aggregation Types ---

export interface TimeWindow {
  startMs: number;
  endMs: number;
}

export interface QualitySnapshot {
  dimension: string;
  window: TimeWindow;
  sampleCount: number;
  scores: {
    [scorerName: string]: {
      mean: number;
      p50: number;
      p95: number;
      min: number;
      max: number;
    };
  };
}

export interface StoredScore {
  interactionId: string;
  timestamp: number;
  dimensions: Record<string, string>;
  scores: ScoreResult[];
}

// --- Baseline Types ---

export interface BaselineEntry {
  dimension: string;
  scorerName: string;
  value: number;
  sampleCount: number;
  lastUpdated: number;
}

// --- Alerting Types ---

export type AlertSeverity = 'warning' | 'critical';

export interface QualityAlert {
  severity: AlertSeverity;
  dimension: string;
  scorerName: string;
  currentValue: number;
  threshold: number;
  baselineValue?: number;
  message: string;
  timestamp: number;
}

export type AlertHandler = (alert: QualityAlert) => void;

// --- Health Types ---

export interface HealthStatus {
  healthy: boolean;
  dimensions: {
    [dimension: string]: {
      healthy: boolean;
      scores: { [scorerName: string]: number };
      alerts: QualityAlert[];
    };
  };
}

// --- Configuration ---

export interface QualityMonitorConfig {
  sampleRate: number;
  windowSizeMs: number;
  baselineDecay: number;
  absoluteThreshold: number;
  relativeThreshold: number;
  minSamplesForAlert: number;
  dimensions: string[];
  scorerTimeoutMs: number;
  maxQueueDepth: number;
  onAlert?: AlertHandler;
}

export const DEFAULT_CONFIG: QualityMonitorConfig = {
  sampleRate: 0.1,
  windowSizeMs: 60 * 60 * 1000, // 1 hour
  baselineDecay: 0.95,
  absoluteThreshold: 0.7,
  relativeThreshold: 0.1,
  minSamplesForAlert: 30,
  dimensions: ['promptTemplate', 'model'],
  scorerTimeoutMs: 5000,
  maxQueueDepth: 10000,
};

// --- Error Types ---

export class ScorerTimeoutError extends Error {
  public readonly scorerName: string;
  public readonly timeoutMs: number;

  constructor(scorerName: string, timeoutMs: number) {
    super(`Scorer "${scorerName}" timed out after ${timeoutMs}ms`);
    this.name = 'ScorerTimeoutError';
    this.scorerName = scorerName;
    this.timeoutMs = timeoutMs;
  }
}

export class QueueOverflowError extends Error {
  public readonly queueDepth: number;
  public readonly maxDepth: number;

  constructor(queueDepth: number, maxDepth: number) {
    super(`Scoring queue overflow: ${queueDepth}/${maxDepth}`);
    this.name = 'QueueOverflowError';
    this.queueDepth = queueDepth;
    this.maxDepth = maxDepth;
  }
}

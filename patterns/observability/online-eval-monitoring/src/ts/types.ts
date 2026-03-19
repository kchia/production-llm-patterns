export interface EvalContext {
  input: string;
  output: string;
  metadata?: Record<string, unknown>;
}

export interface Trace {
  id: string;
  timestamp: number;
  context: EvalContext;
}

export interface ScoreResult {
  traceId: string;
  scorerName: string;
  score: number; // 0.0 - 1.0
  timestamp: number;
  durationMs: number;
}

export interface ScoreCallback {
  (result: ScoreResult): void;
}

export interface Scorer {
  name: string;
  /** Fraction of traces to sample, 0.0–1.0 */
  samplingRate: number;
  score(trace: Trace): Promise<number>;
}

export interface TimeWindow {
  startMs: number;
  endMs: number;
}

export interface OnlineEvalConfig {
  /** Max pending eval jobs before oldest are dropped. Default: 1000 */
  queueSize?: number;
  /** Max ms to wait for a scorer before dropping the job. Default: 30_000 */
  asyncTimeoutMs?: number;
  /** Score below this emits a 'warning' alert event. Default: 0.7 */
  alertThreshold?: number;
  /** Score below this emits a 'critical' alert event. Default: 0.5 */
  criticalThreshold?: number;
  /** Number of recent scores to hold per scorer for rolling stats. Default: 100 */
  windowSize?: number;
}

export type AlertLevel = 'warning' | 'critical';

export interface AlertEvent {
  level: AlertLevel;
  scorerName: string;
  score: number;
  rollingMean: number;
  traceId: string;
}

export interface AlertCallback {
  (event: AlertEvent): void;
}

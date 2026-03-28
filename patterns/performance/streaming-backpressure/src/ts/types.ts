export interface BackpressureOptions {
  /**
   * Max tokens to buffer before pausing the producer.
   * Default 16 matches Node.js object-mode highWaterMark.
   * Tune upward for clients with predictably higher latency.
   */
  highWaterMark?: number;

  /**
   * Max ms to wait for drain before aborting the stream.
   * Prevents zombie streams from holding resources indefinitely.
   */
  drainTimeout?: number;

  /**
   * AbortSignal to propagate upstream cancellation.
   * Wire to the LLM client so inference stops when the client disconnects.
   */
  signal?: AbortSignal;

  /** Called each time the producer is paused due to backpressure. */
  onBackpressure?: () => void;

  /** Called each time the producer resumes after a drain. */
  onDrain?: () => void;
}

export interface StreamResult {
  tokensDelivered: number;
  /** How many times the producer was paused due to full buffer. */
  backpressureEvents: number;
  /** How many drain events allowed the producer to resume. */
  drainEvents: number;
  /** True if the stream ended because the client disconnected. */
  clientDisconnected: boolean;
  /** True if the stream ended because drainTimeout expired. */
  drainTimeoutExpired: boolean;
  durationMs: number;
}

export interface BackpressureControllerConfig {
  highWaterMark: number;
  drainTimeout: number;
}

export const DEFAULT_CONFIG: BackpressureControllerConfig = {
  highWaterMark: 16,
  drainTimeout: 5000,
};

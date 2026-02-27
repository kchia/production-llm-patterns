/**
 * Circuit Breaker types for LLM provider protection.
 */

// --- LLM Request/Response types ---

export interface LLMRequest {
  prompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LLMResponse {
  content: string;
  tokenUsage: {
    input: number;
    output: number;
    total: number;
  };
  latencyMs: number;
  model: string;
}

// --- Circuit Breaker states ---

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

// --- Configuration ---

export interface CircuitBreakerConfig {
  /** Failure rate percentage (0-100) that trips the circuit. Default: 50 */
  failureThreshold?: number;
  /** How long the circuit stays open before probing (ms). Default: 30000 */
  resetTimeoutMs?: number;
  /** Number of successful probes required to close the circuit. Default: 3 */
  halfOpenMaxAttempts?: number;
  /** Minimum requests in window before evaluating failure rate. Default: 10 */
  minimumRequests?: number;
  /** Sliding window size (number of requests tracked). Default: 100 */
  windowSize?: number;
  /** Time-based window duration — requests older than this are evicted (ms). Default: 60000 */
  windowDurationMs?: number;
  /** Custom function to classify which responses/errors count as failures. */
  isFailure?: (error: unknown) => boolean;
  /** Callback fired on every state transition. */
  onStateChange?: (event: StateChangeEvent) => void;
  /** Callback fired when a request succeeds. */
  onSuccess?: (event: RequestEvent) => void;
  /** Callback fired when a request fails. */
  onFailure?: (event: RequestEvent) => void;
}

// --- Events ---

export interface StateChangeEvent {
  from: CircuitState;
  to: CircuitState;
  failureRate: number;
  timestamp: number;
}

export interface RequestEvent {
  state: CircuitState;
  latencyMs: number;
  timestamp: number;
  error?: unknown;
}

// --- Sliding Window ---

export interface WindowEntry {
  success: boolean;
  timestamp: number;
}

export interface WindowStats {
  total: number;
  failures: number;
  successes: number;
  failureRate: number;
}

// --- Errors ---

export class CircuitOpenError extends Error {
  readonly state: CircuitState;
  readonly resetTimeoutMs: number;
  readonly failureRate: number;
  readonly remainingMs: number;

  constructor(opts: {
    resetTimeoutMs: number;
    failureRate: number;
    remainingMs: number;
  }) {
    super(
      `Circuit is OPEN (failure rate: ${opts.failureRate.toFixed(1)}%, ` +
        `resets in ${opts.remainingMs}ms)`
    );
    this.name = 'CircuitOpenError';
    this.state = CircuitState.OPEN;
    this.resetTimeoutMs = opts.resetTimeoutMs;
    this.failureRate = opts.failureRate;
    this.remainingMs = opts.remainingMs;
  }
}

export class ProviderError extends Error {
  readonly statusCode: number;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    statusCode: number,
    retryAfterMs?: number
  ) {
    super(message);
    this.name = 'ProviderError';
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
  }
}

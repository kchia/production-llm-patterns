/**
 * test-fixtures — Type Definitions
 *
 * Canonical request/response types and error class used across all 35 pattern
 * mock providers. Import from here instead of defining per-pattern.
 *
 * Framework-agnostic. No external dependencies.
 */

// ─── Core LLM Types ───────────────────────────────────────────────────────────

/** A request to an LLM provider. */
export interface LLMRequest {
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  /** Arbitrary pass-through metadata — useful for tracing and attribution. */
  metadata?: Record<string, unknown>;
}

/**
 * A response from an LLM provider.
 *
 * `tokensUsed` is the total token count (input + output).
 * Patterns that need the split should use the mock's per-response token config
 * and estimate input tokens from prompt length.
 */
export interface LLMResponse {
  content: string;
  /** Total tokens consumed (input + output). Omitted when not available. */
  tokensUsed?: number;
  model?: string;
  /** Provider finish reason: 'stop', 'length', 'cache_hit', 'static_fallback', etc. */
  finishReason?: string;
  /** End-to-end latency measured by the mock, in milliseconds. */
  latencyMs?: number;
}

// ─── Provider Error ───────────────────────────────────────────────────────────

/**
 * Error thrown by MockProvider on simulated failures.
 *
 * Carries an HTTP status code so patterns can distinguish retryable (429, 503)
 * from non-retryable (400, 401) errors — same as real providers send.
 */
export class ProviderError extends Error {
  /** HTTP-like status code (e.g., 429, 500, 503). */
  readonly statusCode: number;
  /** Retry-After delay in milliseconds, if the status is 429. */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    statusCode: number,
    options?: { retryAfterMs?: number },
  ) {
    super(message);
    this.name = 'ProviderError';
    this.statusCode = statusCode;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

// ─── Mock Provider Config ─────────────────────────────────────────────────────

export interface MockProviderConfig {
  /** Simulated response latency in milliseconds. Default: 50. */
  latencyMs?: number;

  /** Probability of failure (0.0 – 1.0). Default: 0.0. */
  failureRate?: number;

  /** HTTP status code to throw on probabilistic failures. Default: 503. */
  failureStatusCode?: number;

  /** Error message on failure. Default: "Provider unavailable". */
  errorMessage?: string;

  /**
   * Retry-After delay in ms. Attached to errors when failureStatusCode is 429.
   * Useful for testing retry-with-budget and circuit-breaker rate-limit paths.
   */
  retryAfterMs?: number;

  /** Simulated output tokens per response. Default: 100. */
  tokensPerResponse?: number;

  /** Model name returned in responses. Default: "mock-model". */
  model?: string;

  /** Static response content. Default: generated from prompt. */
  responseContent?: string;

  /**
   * Deterministic error sequence. Each entry is 'success' or an HTTP status
   * code. Consumed in order; falls back to failureRate after exhaustion.
   *
   * Example: ['success', 503, 'success'] → ok, error, ok, then probabilistic.
   */
  errorSequence?: Array<'success' | number>;
}

// ─── Streaming Types ──────────────────────────────────────────────────────────

export interface MockStreamOptions {
  /** Number of tokens to emit. Default: 100. */
  tokenCount?: number;
  /** Delay between tokens in ms. Default: 10 (≈100 tokens/sec). */
  tokenDelayMs?: number;
  /** If set, throw an error after emitting this many tokens. */
  errorAfterTokens?: number;
  /** Content of each emitted token chunk. Default: 'token '. */
  tokenContent?: string;
}

/**
 * trace-logger — Type definitions
 *
 * Core types for the shared tracer: spans, exporters, configuration,
 * and LLM-specific attribute keys aligned with OTel GenAI conventions.
 */

// --- Span attribute types ---

export type SpanAttributeValue = string | number | boolean | string[] | number[] | boolean[];

export type SpanStatus = 'ok' | 'error' | 'unset';

export interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

export interface SpanData {
  name: string;
  context: SpanContext;
  status: SpanStatus;
  attributes: Record<string, SpanAttributeValue>;
  startTime: number;
  endTime?: number;
  error?: Error;
  children: SpanData[];
}

// --- Exporter interface ---

export interface SpanExporter {
  export(spans: SpanData[]): Promise<void>;
  shutdown(): Promise<void>;
}

// --- Configuration ---

export interface TracerConfig {
  /** Where traces go — console, HTTP endpoint, or custom backend. Default: ConsoleExporter */
  exporter?: SpanExporter;

  /** Whether to record prompt/completion text (privacy-sensitive). Default: false */
  captureContent?: boolean;

  /** Fraction of traces to record (1.0 = all, 0.1 = 10%). Default: 1.0 */
  samplingRate?: number;

  /** Cap on attributes per span to prevent memory bloat. Default: 64 */
  maxSpanAttributes?: number;

  /** How often to batch-export spans (ms). 0 disables the timer. Default: 5000 */
  flushIntervalMs?: number;

  /** Max spans queued before dropping (backpressure). Default: 2048 */
  maxQueueSize?: number;

  /** Service name attached to all root spans. Default: 'llm-service' */
  serviceName?: string;
}

export const DEFAULT_TRACER_CONFIG = {
  captureContent: false,
  samplingRate: 1.0,
  maxSpanAttributes: 64,
  flushIntervalMs: 5000,
  maxQueueSize: 2048,
  serviceName: 'llm-service',
} as const;

// --- LLM-specific attribute keys (aligned with OTel GenAI semantic conventions) ---

export const LLM_ATTRIBUTES = {
  // Request attributes
  MODEL: 'gen_ai.request.model',
  PROVIDER: 'gen_ai.system',
  TEMPERATURE: 'gen_ai.request.temperature',
  MAX_TOKENS: 'gen_ai.request.max_tokens',
  TOP_P: 'gen_ai.request.top_p',

  // Response attributes
  INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  FINISH_REASON: 'gen_ai.response.finish_reason',

  // Content (opt-in)
  PROMPT: 'gen_ai.prompt',
  COMPLETION: 'gen_ai.completion',

  // Pipeline stage attributes
  STAGE: 'pipeline.stage',
  STAGE_TYPE: 'pipeline.stage.type',

  // Retrieval-specific
  RETRIEVAL_QUERY: 'retrieval.query',
  RETRIEVAL_DOC_COUNT: 'retrieval.document_count',
  RETRIEVAL_TOP_SCORE: 'retrieval.top_score',

  // Cost tracking
  ESTIMATED_COST: 'gen_ai.usage.estimated_cost',
} as const;

// --- LLM Request/Response types (for traceLLMCall convenience method) ---

export interface LLMRequest {
  prompt: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  latencyMs: number;
}

// --- Metrics ---

export interface TracerMetrics {
  spansCreated: number;
  spansDropped: number;
  queueSize: number;
  tracesCreated: number;
  tracesSampled: number;
}

// --- Errors ---

export class TracingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'TracingError';
  }
}

export class ExportError extends TracingError {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message, 'EXPORT_FAILED');
    this.name = 'ExportError';
  }
}

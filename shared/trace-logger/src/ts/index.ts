/**
 * trace-logger — Shared tracer for LLM pipelines
 *
 * Lightweight, framework-agnostic tracer extracted from the structured-tracing
 * pattern. Uses AsyncLocalStorage for automatic span nesting, keeping the API
 * clean while preserving parent-child relationships across async boundaries.
 *
 * Consuming patterns import from here instead of duplicating the span data
 * model, exporter interface, and LLM attribute key constants.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_TRACER_CONFIG,
  ExportError,
  LLM_ATTRIBUTES,
  LLMRequest,
  LLMResponse,
  SpanAttributeValue,
  SpanContext,
  SpanData,
  SpanExporter,
  SpanStatus,
  TracerConfig,
  TracerMetrics,
} from './types.js';

// --- ID generation ---

function generateId(bytes: number = 8): string {
  return randomBytes(bytes).toString('hex');
}

function generateTraceId(): string {
  return generateId(16); // 32-char hex — matches OTel trace ID length
}

function generateSpanId(): string {
  return generateId(8); // 16-char hex — matches OTel span ID length
}

// --- Span ---

export class Span {
  private readonly data: SpanData;
  private ended = false;
  private readonly maxAttributes: number;

  constructor(name: string, context: SpanContext, maxAttributes: number) {
    this.maxAttributes = maxAttributes;
    this.data = {
      name,
      context,
      status: 'unset',
      attributes: {},
      startTime: performance.now(),
      children: [],
    };
  }

  setAttribute(key: string, value: SpanAttributeValue): this {
    if (this.ended) return this;
    if (Object.keys(this.data.attributes).length >= this.maxAttributes) return this;
    this.data.attributes[key] = value;
    return this;
  }

  setAttributes(attrs: Record<string, SpanAttributeValue>): this {
    for (const [key, value] of Object.entries(attrs)) {
      this.setAttribute(key, value);
    }
    return this;
  }

  setStatus(status: SpanStatus): this {
    if (!this.ended) this.data.status = status;
    return this;
  }

  recordError(error: Error): this {
    if (this.ended) return this;
    this.data.error = error;
    this.data.status = 'error';
    this.setAttribute('error.type', error.name);
    this.setAttribute('error.message', error.message);
    return this;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.data.endTime = performance.now();
    if (this.data.status === 'unset') this.data.status = 'ok';
  }

  addChild(child: SpanData): void {
    this.data.children.push(child);
  }

  getData(): SpanData {
    return this.data;
  }

  isEnded(): boolean {
    return this.ended;
  }

  getContext(): SpanContext {
    return this.data.context;
  }

  getDurationMs(): number | undefined {
    if (this.data.endTime === undefined) return undefined;
    return this.data.endTime - this.data.startTime;
  }
}

// --- Built-in exporters ---

export class ConsoleExporter implements SpanExporter {
  async export(spans: SpanData[]): Promise<void> {
    for (const span of spans) {
      console.log(JSON.stringify(this.formatSpan(span), null, 2));
    }
  }

  async shutdown(): Promise<void> {}

  private formatSpan(span: SpanData): Record<string, unknown> {
    return {
      name: span.name,
      traceId: span.context.traceId,
      spanId: span.context.spanId,
      parentSpanId: span.context.parentSpanId,
      status: span.status,
      durationMs: span.endTime !== undefined ? span.endTime - span.startTime : undefined,
      attributes: span.attributes,
      error: span.error ? { name: span.error.name, message: span.error.message } : undefined,
      children: span.children.map((c) => this.formatSpan(c)),
    };
  }
}

/** Stores spans in memory. Use in tests to assert on span attributes. */
export class InMemoryExporter implements SpanExporter {
  private traces: SpanData[] = [];

  async export(spans: SpanData[]): Promise<void> {
    this.traces.push(...spans);
  }

  async shutdown(): Promise<void> {}

  getTraces(): SpanData[] {
    return [...this.traces];
  }

  getSpansByName(name: string): SpanData[] {
    const results: SpanData[] = [];
    const search = (span: SpanData) => {
      if (span.name === name) results.push(span);
      span.children.forEach(search);
    };
    this.traces.forEach(search);
    return results;
  }

  getAllSpans(): SpanData[] {
    const results: SpanData[] = [];
    const collect = (span: SpanData) => {
      results.push(span);
      span.children.forEach(collect);
    };
    this.traces.forEach(collect);
    return results;
  }

  clear(): void {
    this.traces = [];
  }
}

// --- Tracer ---

interface SpanStackEntry {
  span: Span;
  traceId: string;
}

export class Tracer {
  private readonly config: Required<TracerConfig>;
  private readonly contextStorage = new AsyncLocalStorage<SpanStackEntry>();
  private readonly exportQueue: SpanData[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private spansDropped = 0;
  private spansCreated = 0;
  private tracesCreated = 0;
  private tracesSampled = 0;

  constructor(config: TracerConfig = {}) {
    this.config = {
      exporter: config.exporter ?? new ConsoleExporter(),
      captureContent: config.captureContent ?? DEFAULT_TRACER_CONFIG.captureContent,
      samplingRate: config.samplingRate ?? DEFAULT_TRACER_CONFIG.samplingRate,
      maxSpanAttributes: config.maxSpanAttributes ?? DEFAULT_TRACER_CONFIG.maxSpanAttributes,
      maxQueueSize: config.maxQueueSize ?? DEFAULT_TRACER_CONFIG.maxQueueSize,
      flushIntervalMs: config.flushIntervalMs ?? DEFAULT_TRACER_CONFIG.flushIntervalMs,
      serviceName: config.serviceName ?? DEFAULT_TRACER_CONFIG.serviceName,
    };

    if (this.config.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        this.flush().catch(() => {});
      }, this.config.flushIntervalMs);
      this.flushTimer.unref(); // Don't keep the process alive just for flushing
    }
  }

  /**
   * Start a root trace. The callback runs within this trace's context —
   * all spans created inside are automatically nested as children.
   */
  async trace<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    attributes?: Record<string, SpanAttributeValue>,
  ): Promise<T> {
    this.tracesCreated++;

    if (this.config.samplingRate < 1.0 && Math.random() >= this.config.samplingRate) {
      const noopSpan = new Span(name, { traceId: '', spanId: '' }, 0);
      return fn(noopSpan);
    }

    this.tracesSampled++;
    const traceId = generateTraceId();
    const spanId = generateSpanId();
    const span = new Span(name, { traceId, spanId }, this.config.maxSpanAttributes);
    this.spansCreated++;

    if (attributes) span.setAttributes(attributes);
    span.setAttribute('service.name', this.config.serviceName);

    const entry: SpanStackEntry = { span, traceId };

    try {
      const result = await this.contextStorage.run(entry, () => fn(span));
      span.setStatus('ok');
      return result;
    } catch (error) {
      span.recordError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      span.end();
      this.enqueueSpan(span.getData());
    }
  }

  /**
   * Create a child span within the current trace context.
   * Automatically nests under the active span via AsyncLocalStorage.
   * If called outside a trace, runs without tracing.
   */
  async span<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    attributes?: Record<string, SpanAttributeValue>,
  ): Promise<T> {
    const parent = this.contextStorage.getStore();

    if (!parent) {
      const noopSpan = new Span(name, { traceId: '', spanId: '' }, 0);
      return fn(noopSpan);
    }

    const spanId = generateSpanId();
    const span = new Span(
      name,
      { traceId: parent.traceId, spanId, parentSpanId: parent.span.getContext().spanId },
      this.config.maxSpanAttributes,
    );
    this.spansCreated++;

    if (attributes) span.setAttributes(attributes);

    const entry: SpanStackEntry = { span, traceId: parent.traceId };

    try {
      const result = await this.contextStorage.run(entry, () => fn(span));
      span.setStatus('ok');
      return result;
    } catch (error) {
      span.recordError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      span.end();
      parent.span.addChild(span.getData());
    }
  }

  /**
   * Convenience: trace an LLM call with standard OTel GenAI attributes.
   * Records model, token counts, and optionally prompt/completion.
   */
  async traceLLMCall<T extends LLMResponse>(
    name: string,
    request: LLMRequest,
    callFn: () => Promise<T>,
  ): Promise<T> {
    return this.span(name, async (span) => {
      span.setAttribute(LLM_ATTRIBUTES.MODEL, request.model ?? 'unknown');
      if (request.temperature !== undefined)
        span.setAttribute(LLM_ATTRIBUTES.TEMPERATURE, request.temperature);
      if (request.maxTokens !== undefined)
        span.setAttribute(LLM_ATTRIBUTES.MAX_TOKENS, request.maxTokens);
      if (this.config.captureContent) span.setAttribute(LLM_ATTRIBUTES.PROMPT, request.prompt);

      const response = await callFn();

      span.setAttribute(LLM_ATTRIBUTES.INPUT_TOKENS, response.usage.inputTokens);
      span.setAttribute(LLM_ATTRIBUTES.OUTPUT_TOKENS, response.usage.outputTokens);
      if (this.config.captureContent)
        span.setAttribute(LLM_ATTRIBUTES.COMPLETION, response.content);

      return response;
    });
  }

  /**
   * Convenience: trace a retrieval step with standard attributes.
   */
  async traceRetrieval<T extends { documentCount: number; topScore?: number }>(
    name: string,
    query: string,
    retrieveFn: () => Promise<T>,
  ): Promise<T> {
    return this.span(name, async (span) => {
      span.setAttribute(LLM_ATTRIBUTES.STAGE_TYPE, 'retrieval');
      if (this.config.captureContent) span.setAttribute(LLM_ATTRIBUTES.RETRIEVAL_QUERY, query);

      const result = await retrieveFn();

      span.setAttribute(LLM_ATTRIBUTES.RETRIEVAL_DOC_COUNT, result.documentCount);
      if (result.topScore !== undefined)
        span.setAttribute(LLM_ATTRIBUTES.RETRIEVAL_TOP_SCORE, result.topScore);

      return result;
    });
  }

  getActiveSpan(): Span | undefined {
    return this.contextStorage.getStore()?.span;
  }

  async flush(): Promise<void> {
    if (this.exportQueue.length === 0) return;

    const batch = this.exportQueue.splice(0, this.exportQueue.length);
    try {
      await this.config.exporter.export(batch);
    } catch (error) {
      const room = this.config.maxQueueSize - this.exportQueue.length;
      if (room > 0) this.exportQueue.unshift(...batch.slice(0, room));
      this.spansDropped += batch.length - Math.max(0, room);
      throw new ExportError(
        `Failed to export ${batch.length} spans`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    await this.config.exporter.shutdown();
  }

  getMetrics(): TracerMetrics {
    return {
      spansCreated: this.spansCreated,
      spansDropped: this.spansDropped,
      queueSize: this.exportQueue.length,
      tracesCreated: this.tracesCreated,
      tracesSampled: this.tracesSampled,
    };
  }

  private enqueueSpan(span: SpanData): void {
    if (this.exportQueue.length >= this.config.maxQueueSize) {
      this.spansDropped++;
      return;
    }
    this.exportQueue.push(span);
  }
}

// Re-export all types so consumers only need one import path
export {
  LLM_ATTRIBUTES,
  SpanAttributeValue,
  SpanContext,
  SpanData,
  SpanExporter,
  SpanStatus,
  TracerConfig,
  TracerMetrics,
  LLMRequest,
  LLMResponse,
  TracingError,
  ExportError,
} from './types.js';

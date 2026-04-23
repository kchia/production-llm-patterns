import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Tracer,
  Span,
  InMemoryExporter,
  ConsoleExporter,
  LLM_ATTRIBUTES,
  ExportError,
} from '../index.js';
import type { TracerConfig, SpanData } from '../types.js';

// --- Helper ---

function makeTracer(config?: TracerConfig): { tracer: Tracer; exporter: InMemoryExporter } {
  const exporter = new InMemoryExporter();
  const tracer = new Tracer({ exporter, flushIntervalMs: 0, ...config });
  return { tracer, exporter };
}

// --- Unit: Span ---

describe('Span', () => {
  it('records attributes before end', () => {
    const span = new Span('test', { traceId: 'tid', spanId: 'sid' }, 64);
    span.setAttribute('key', 'value');
    expect(span.getData().attributes['key']).toBe('value');
  });

  it('rejects attributes after end', () => {
    const span = new Span('test', { traceId: 'tid', spanId: 'sid' }, 64);
    span.end();
    span.setAttribute('key', 'late');
    expect(span.getData().attributes['key']).toBeUndefined();
  });

  it('enforces maxAttributes cap', () => {
    const span = new Span('test', { traceId: 'tid', spanId: 'sid' }, 2);
    span.setAttribute('a', 1);
    span.setAttribute('b', 2);
    span.setAttribute('c', 3); // over cap — dropped
    expect(Object.keys(span.getData().attributes)).toHaveLength(2);
  });

  it('sets status to ok on end when unset', () => {
    const span = new Span('test', { traceId: 'tid', spanId: 'sid' }, 64);
    span.end();
    expect(span.getData().status).toBe('ok');
  });

  it('records error and sets status to error', () => {
    const span = new Span('test', { traceId: 'tid', spanId: 'sid' }, 64);
    const err = new Error('boom');
    span.recordError(err);
    expect(span.getData().status).toBe('error');
    expect(span.getData().attributes['error.message']).toBe('boom');
  });

  it('computes duration after end', () => {
    const span = new Span('test', { traceId: 'tid', spanId: 'sid' }, 64);
    span.end();
    expect(span.getDurationMs()).toBeGreaterThanOrEqual(0);
  });

  it('returns undefined duration before end', () => {
    const span = new Span('test', { traceId: 'tid', spanId: 'sid' }, 64);
    expect(span.getDurationMs()).toBeUndefined();
  });
});

// --- Unit: Tracer ---

describe('Tracer — core', () => {
  it('creates a root trace with traceId and spanId', async () => {
    const { tracer, exporter } = makeTracer();
    await tracer.trace('pipeline', async (span) => {
      expect(span.getContext().traceId).toBeTruthy();
      expect(span.getContext().spanId).toBeTruthy();
    });
    await tracer.flush();
    expect(exporter.getTraces()).toHaveLength(1);
  });

  it('attaches service.name to root span', async () => {
    const { tracer, exporter } = makeTracer({ serviceName: 'my-service' });
    await tracer.trace('pipeline', async () => {});
    await tracer.flush();
    expect(exporter.getTraces()[0].attributes['service.name']).toBe('my-service');
  });

  it('nests child spans under root', async () => {
    const { tracer, exporter } = makeTracer();
    await tracer.trace('root', async () => {
      await tracer.span('child', async () => {});
    });
    await tracer.flush();

    const root = exporter.getTraces()[0];
    expect(root.children).toHaveLength(1);
    expect(root.children[0].name).toBe('child');
    expect(root.children[0].context.parentSpanId).toBe(root.context.spanId);
  });

  it('shares traceId across nested spans', async () => {
    const { tracer, exporter } = makeTracer();
    await tracer.trace('root', async () => {
      await tracer.span('child', async () => {});
    });
    await tracer.flush();

    const root = exporter.getTraces()[0];
    expect(root.children[0].context.traceId).toBe(root.context.traceId);
  });

  it('runs without tracing when span() called outside trace()', async () => {
    const { tracer, exporter } = makeTracer();
    const result = await tracer.span('orphan', async (span) => {
      expect(span.getContext().traceId).toBe(''); // noop span
      return 42;
    });
    await tracer.flush();
    expect(result).toBe(42);
    expect(exporter.getAllSpans()).toHaveLength(0);
  });

  it('records errors on the root span and re-throws', async () => {
    const { tracer, exporter } = makeTracer();
    await expect(
      tracer.trace('failing', async () => {
        throw new Error('test error');
      }),
    ).rejects.toThrow('test error');
    await tracer.flush();
    expect(exporter.getTraces()[0].status).toBe('error');
  });

  it('respects samplingRate', async () => {
    const { tracer, exporter } = makeTracer({ samplingRate: 0 });
    for (let i = 0; i < 10; i++) {
      await tracer.trace('pipeline', async () => {});
    }
    await tracer.flush();
    expect(exporter.getTraces()).toHaveLength(0);
    expect(tracer.getMetrics().tracesCreated).toBe(10);
    expect(tracer.getMetrics().tracesSampled).toBe(0);
  });

  it('exposes getActiveSpan inside a trace', async () => {
    const { tracer } = makeTracer();
    await tracer.trace('root', async (rootSpan) => {
      expect(tracer.getActiveSpan()).toBe(rootSpan);
    });
  });
});

// --- Unit: LLM convenience helpers ---

describe('Tracer — traceLLMCall', () => {
  it('attaches model and token attributes', async () => {
    const { tracer, exporter } = makeTracer();
    await tracer.trace('root', async () => {
      await tracer.traceLLMCall(
        'generate',
        { prompt: 'hello', model: 'gpt-4o', maxTokens: 100 },
        async () => ({
          content: 'hi',
          model: 'gpt-4o',
          usage: { inputTokens: 10, outputTokens: 5 },
          latencyMs: 200,
        }),
      );
    });
    await tracer.flush();

    const llmSpan = exporter.getSpansByName('generate')[0];
    expect(llmSpan.attributes[LLM_ATTRIBUTES.MODEL]).toBe('gpt-4o');
    expect(llmSpan.attributes[LLM_ATTRIBUTES.INPUT_TOKENS]).toBe(10);
    expect(llmSpan.attributes[LLM_ATTRIBUTES.OUTPUT_TOKENS]).toBe(5);
  });

  it('does not capture prompt/completion when captureContent is false', async () => {
    const { tracer, exporter } = makeTracer({ captureContent: false });
    await tracer.trace('root', async () => {
      await tracer.traceLLMCall(
        'generate',
        { prompt: 'secret', model: 'gpt-4o' },
        async () => ({
          content: 'also secret',
          model: 'gpt-4o',
          usage: { inputTokens: 5, outputTokens: 3 },
          latencyMs: 100,
        }),
      );
    });
    await tracer.flush();

    const llmSpan = exporter.getSpansByName('generate')[0];
    expect(llmSpan.attributes[LLM_ATTRIBUTES.PROMPT]).toBeUndefined();
    expect(llmSpan.attributes[LLM_ATTRIBUTES.COMPLETION]).toBeUndefined();
  });

  it('captures content when captureContent is true', async () => {
    const { tracer, exporter } = makeTracer({ captureContent: true });
    await tracer.trace('root', async () => {
      await tracer.traceLLMCall(
        'generate',
        { prompt: 'hello', model: 'gpt-4o' },
        async () => ({
          content: 'world',
          model: 'gpt-4o',
          usage: { inputTokens: 2, outputTokens: 1 },
          latencyMs: 50,
        }),
      );
    });
    await tracer.flush();

    const llmSpan = exporter.getSpansByName('generate')[0];
    expect(llmSpan.attributes[LLM_ATTRIBUTES.PROMPT]).toBe('hello');
    expect(llmSpan.attributes[LLM_ATTRIBUTES.COMPLETION]).toBe('world');
  });
});

describe('Tracer — traceRetrieval', () => {
  it('attaches stage type and doc count', async () => {
    const { tracer, exporter } = makeTracer();
    await tracer.trace('root', async () => {
      await tracer.traceRetrieval('retrieve', 'test query', async () => ({
        documentCount: 5,
        topScore: 0.92,
      }));
    });
    await tracer.flush();

    const rSpan = exporter.getSpansByName('retrieve')[0];
    expect(rSpan.attributes[LLM_ATTRIBUTES.STAGE_TYPE]).toBe('retrieval');
    expect(rSpan.attributes[LLM_ATTRIBUTES.RETRIEVAL_DOC_COUNT]).toBe(5);
    expect(rSpan.attributes[LLM_ATTRIBUTES.RETRIEVAL_TOP_SCORE]).toBe(0.92);
  });
});

// --- Unit: Export queue and backpressure ---

describe('Tracer — queue and backpressure', () => {
  it('drops spans when queue is full and increments spansDropped', async () => {
    const { tracer } = makeTracer({ maxQueueSize: 1 });
    // Fill the queue with the first trace, don't flush
    await tracer.trace('first', async () => {});
    // Second trace gets dropped because queue is full (size 1)
    await tracer.trace('second', async () => {});

    const metrics = tracer.getMetrics();
    expect(metrics.spansDropped).toBeGreaterThan(0);
  });

  it('re-enqueues spans on export failure and throws ExportError', async () => {
    const failingExporter = {
      export: vi.fn().mockRejectedValue(new Error('network error')),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const tracer = new Tracer({ exporter: failingExporter, flushIntervalMs: 0 });

    await tracer.trace('pipeline', async () => {});
    await expect(tracer.flush()).rejects.toBeInstanceOf(ExportError);
  });

  it('shutdown flushes remaining spans', async () => {
    const { tracer, exporter } = makeTracer();
    await tracer.trace('pipeline', async () => {});
    // Don't flush manually — shutdown should do it
    await tracer.shutdown();
    expect(exporter.getTraces()).toHaveLength(1);
  });
});

// --- Unit: InMemoryExporter ---

describe('InMemoryExporter', () => {
  it('stores and retrieves traces', async () => {
    const { tracer, exporter } = makeTracer();
    await tracer.trace('root', async () => {});
    await tracer.flush();
    expect(exporter.getTraces()).toHaveLength(1);
  });

  it('getSpansByName traverses children', async () => {
    const { tracer, exporter } = makeTracer();
    await tracer.trace('root', async () => {
      await tracer.span('target', async () => {});
    });
    await tracer.flush();

    const found = exporter.getSpansByName('target');
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('target');
  });

  it('getAllSpans flattens the tree', async () => {
    const { tracer, exporter } = makeTracer();
    await tracer.trace('root', async () => {
      await tracer.span('child', async () => {});
    });
    await tracer.flush();

    expect(exporter.getAllSpans()).toHaveLength(2); // root + child
  });

  it('clear removes all traces', async () => {
    const { tracer, exporter } = makeTracer();
    await tracer.trace('root', async () => {});
    await tracer.flush();
    exporter.clear();
    expect(exporter.getTraces()).toHaveLength(0);
  });
});

// --- Integration: full RAG pipeline ---

describe('Integration — RAG pipeline', () => {
  it('produces a complete trace tree for a multi-stage pipeline', async () => {
    const { tracer, exporter } = makeTracer({ serviceName: 'rag-service' });

    await tracer.trace('rag-pipeline', async (rootSpan) => {
      rootSpan.setAttribute('user.id', 'user-123');
      rootSpan.setAttribute('query', 'What is structured tracing?');

      // Stage 1: retrieval
      await tracer.traceRetrieval('retrieval', 'structured tracing', async () => ({
        documentCount: 3,
        topScore: 0.88,
      }));

      // Stage 2: generation
      await tracer.traceLLMCall(
        'generation',
        { prompt: 'Context: ...\n\nQ: What is structured tracing?', model: 'gpt-4o-mini' },
        async () => ({
          content: 'Structured tracing is...',
          model: 'gpt-4o-mini',
          usage: { inputTokens: 120, outputTokens: 80 },
          latencyMs: 450,
        }),
      );

      // Stage 3: validation
      await tracer.span('validation', async (vSpan) => {
        vSpan.setAttribute('passed', true);
        vSpan.setAttribute('errors', 0);
      });
    });

    await tracer.flush();

    const root = exporter.getTraces()[0];
    expect(root.name).toBe('rag-pipeline');
    expect(root.attributes['service.name']).toBe('rag-service');
    expect(root.children).toHaveLength(3);

    const [retrieval, generation, validation] = root.children;
    expect(retrieval.name).toBe('retrieval');
    expect(retrieval.attributes[LLM_ATTRIBUTES.RETRIEVAL_DOC_COUNT]).toBe(3);

    expect(generation.name).toBe('generation');
    expect(generation.attributes[LLM_ATTRIBUTES.INPUT_TOKENS]).toBe(120);

    expect(validation.name).toBe('validation');
    expect(validation.attributes['passed']).toBe(true);

    // All spans share the same traceId
    const allSpans = exporter.getAllSpans();
    const traceIds = new Set(allSpans.map((s) => s.context.traceId));
    expect(traceIds.size).toBe(1);
  });

  it('handles concurrent independent traces without cross-contamination', async () => {
    const { tracer, exporter } = makeTracer();

    await Promise.all([
      tracer.trace('trace-a', async (span) => {
        span.setAttribute('trace', 'a');
        await tracer.span('child-a', async () => {});
      }),
      tracer.trace('trace-b', async (span) => {
        span.setAttribute('trace', 'b');
        await tracer.span('child-b', async () => {});
      }),
    ]);

    await tracer.flush();

    const traces = exporter.getTraces();
    expect(traces).toHaveLength(2);

    const traceA = traces.find((t) => t.attributes['trace'] === 'a')!;
    const traceB = traces.find((t) => t.attributes['trace'] === 'b')!;
    expect(traceA.context.traceId).not.toBe(traceB.context.traceId);
    expect(traceA.children[0].name).toBe('child-a');
    expect(traceB.children[0].name).toBe('child-b');
  });
});

// --- Failure mode: sampling drift ---

describe('Failure mode — silent sampling drift', () => {
  it('metrics expose sampling ratio for alerting', async () => {
    const { tracer } = makeTracer({ samplingRate: 0.5 });
    for (let i = 0; i < 100; i++) {
      await tracer.trace('pipeline', async () => {});
    }
    await tracer.flush();

    const metrics = tracer.getMetrics();
    expect(metrics.tracesCreated).toBe(100);
    // At 50% sampling, roughly 50 should be sampled — check it's not 0 or 100
    expect(metrics.tracesSampled).toBeGreaterThan(0);
    expect(metrics.tracesSampled).toBeLessThan(100);
  });

  it('tracesCreated stays accurate even when sampling drops to zero', async () => {
    const { tracer } = makeTracer({ samplingRate: 0 });
    for (let i = 0; i < 5; i++) {
      await tracer.trace('pipeline', async () => {});
    }
    const metrics = tracer.getMetrics();
    expect(metrics.tracesCreated).toBe(5);
    expect(metrics.tracesSampled).toBe(0);
  });
});

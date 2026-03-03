/**
 * Structured Tracing — Test Suite
 *
 * Three categories:
 * 1. Unit tests — core tracing logic
 * 2. Failure mode tests — one per Failure Modes table row
 * 3. Integration tests — end-to-end pipeline with mock provider
 */

import { describe, it, expect } from 'vitest';
import { Tracer, Span, InMemoryExporter } from '../index.js';
import { MockProvider, ProviderError } from '../mock-provider.js';
import {
  LLM_ATTRIBUTES,
  SpanData,
  SpanExporter,
  TracerConfig,
} from '../types.js';

// --- Helpers ---

function createTracer(overrides: Partial<TracerConfig> = {}): {
  tracer: Tracer;
  exporter: InMemoryExporter;
} {
  const exporter = new InMemoryExporter();
  const tracer = new Tracer({
    exporter,
    flushIntervalMs: 0,
    ...overrides,
  });
  return { tracer, exporter };
}

function getAllSpanNames(span: SpanData): string[] {
  const names = [span.name];
  for (const child of span.children) {
    names.push(...getAllSpanNames(child));
  }
  return names;
}

// =====================
// 1. Unit Tests
// =====================

describe('Unit: Span', () => {
  it('creates a span with correct initial state', async () => {
    const { tracer, exporter } = createTracer();
    await tracer.trace('root', async (span) => {
      expect(span.isEnded()).toBe(false);
      expect(span.getData().status).toBe('unset');
    });
    await tracer.flush();
    const traces = exporter.getTraces();
    expect(traces[0].status).toBe('ok');
  });

  it('sets attributes on a span', async () => {
    const { tracer, exporter } = createTracer();
    await tracer.trace('root', async (span) => {
      span.setAttribute('key1', 'value1');
      span.setAttribute('key2', 42);
      span.setAttribute('key3', true);
    });
    await tracer.flush();
    const trace = exporter.getTraces()[0];
    expect(trace.attributes['key1']).toBe('value1');
    expect(trace.attributes['key2']).toBe(42);
    expect(trace.attributes['key3']).toBe(true);
  });

  it('sets multiple attributes at once', async () => {
    const { tracer, exporter } = createTracer();
    await tracer.trace('root', async (span) => {
      span.setAttributes({ a: 1, b: 'two', c: false });
    });
    await tracer.flush();
    const trace = exporter.getTraces()[0];
    expect(trace.attributes['a']).toBe(1);
    expect(trace.attributes['b']).toBe('two');
    expect(trace.attributes['c']).toBe(false);
  });

  it('ignores setAttribute after span ends', async () => {
    const { tracer, exporter } = createTracer();
    let capturedSpan: Span;
    await tracer.trace('root', async (span) => {
      capturedSpan = span;
      span.setAttribute('before', true);
    });
    capturedSpan!.setAttribute('after', true);
    await tracer.flush();
    const trace = exporter.getTraces()[0];
    expect(trace.attributes['before']).toBe(true);
    expect(trace.attributes['after']).toBeUndefined();
  });

  it('records errors with name and message', async () => {
    const { tracer, exporter } = createTracer();
    await expect(
      tracer.trace('root', async () => {
        throw new TypeError('bad type');
      }),
    ).rejects.toThrow('bad type');

    await tracer.flush();
    const trace = exporter.getTraces()[0];
    expect(trace.status).toBe('error');
    expect(trace.attributes['error.type']).toBe('TypeError');
    expect(trace.attributes['error.message']).toBe('bad type');
  });

  it('computes span duration', async () => {
    const { tracer, exporter } = createTracer();
    await tracer.trace('root', async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    await tracer.flush();
    const trace = exporter.getTraces()[0];
    expect(trace.endTime).toBeDefined();
    const duration = trace.endTime! - trace.startTime;
    expect(duration).toBeGreaterThanOrEqual(5);
  });
});

describe('Unit: Tracer context', () => {
  it('nests child spans under parent automatically', async () => {
    const { tracer, exporter } = createTracer();
    await tracer.trace('pipeline', async () => {
      await tracer.span('step1', async () => {});
      await tracer.span('step2', async () => {});
    });
    await tracer.flush();
    const root = exporter.getTraces()[0];
    expect(root.children).toHaveLength(2);
    expect(root.children[0].name).toBe('step1');
    expect(root.children[1].name).toBe('step2');
    expect(root.children[0].context.traceId).toBe(root.context.traceId);
    expect(root.children[0].context.parentSpanId).toBe(root.context.spanId);
  });

  it('supports deeply nested spans', async () => {
    const { tracer, exporter } = createTracer();
    await tracer.trace('level0', async () => {
      await tracer.span('level1', async () => {
        await tracer.span('level2', async () => {
          await tracer.span('level3', async () => {});
        });
      });
    });
    await tracer.flush();
    const root = exporter.getTraces()[0];
    expect(root.children[0].name).toBe('level1');
    expect(root.children[0].children[0].name).toBe('level2');
    expect(root.children[0].children[0].children[0].name).toBe('level3');
  });

  it('handles parallel child spans', async () => {
    const { tracer, exporter } = createTracer();
    await tracer.trace('pipeline', async () => {
      await Promise.all([
        tracer.span('parallel-a', async () => {
          await new Promise((r) => setTimeout(r, 5));
        }),
        tracer.span('parallel-b', async () => {
          await new Promise((r) => setTimeout(r, 5));
        }),
      ]);
    });
    await tracer.flush();
    const root = exporter.getTraces()[0];
    expect(root.children).toHaveLength(2);
    const names = root.children.map((c) => c.name).sort();
    expect(names).toEqual(['parallel-a', 'parallel-b']);
  });

  it('runs function without tracing when span() is called outside a trace', async () => {
    const { tracer } = createTracer();
    const result = await tracer.span('orphan', async () => 42);
    expect(result).toBe(42);
  });

  it('provides active span inside trace context', async () => {
    const { tracer } = createTracer();
    let activeInsideTrace: Span | undefined;
    let activeInsideSpan: Span | undefined;

    await tracer.trace('root', async () => {
      activeInsideTrace = tracer.getActiveSpan();
      await tracer.span('child', async () => {
        activeInsideSpan = tracer.getActiveSpan();
      });
    });

    expect(activeInsideTrace).toBeDefined();
    expect(activeInsideTrace!.getData().name).toBe('root');
    expect(activeInsideSpan).toBeDefined();
    expect(activeInsideSpan!.getData().name).toBe('child');
  });
});

describe('Unit: Tracer configuration', () => {
  it('respects sampling rate', async () => {
    const { tracer, exporter } = createTracer({ samplingRate: 0.0 });

    for (let i = 0; i < 10; i++) {
      await tracer.trace(`trace-${i}`, async () => {});
    }
    await tracer.flush();

    expect(exporter.getTraces()).toHaveLength(0);
    const metrics = tracer.getMetrics();
    expect(metrics.tracesCreated).toBe(10);
    expect(metrics.tracesSampled).toBe(0);
  });

  it('caps attributes per span at maxSpanAttributes', async () => {
    const { tracer, exporter } = createTracer({ maxSpanAttributes: 3 });
    await tracer.trace('root', async (span) => {
      span.setAttribute('a', 1);
      span.setAttribute('b', 2);
      span.setAttribute('c', 3);
      span.setAttribute('d', 4);
      span.setAttribute('e', 5);
    });
    await tracer.flush();
    const trace = exporter.getTraces()[0];
    // service.name is auto-added first, then a, b fit within 3
    const attrCount = Object.keys(trace.attributes).length;
    expect(attrCount).toBeLessThanOrEqual(3);
  });

  it('adds service name attribute to root spans', async () => {
    const { tracer, exporter } = createTracer({ serviceName: 'my-service' });
    await tracer.trace('root', async () => {});
    await tracer.flush();
    expect(exporter.getTraces()[0].attributes['service.name']).toBe('my-service');
  });
});

describe('Unit: Tracer LLM helpers', () => {
  it('traceLLMCall captures model and token attributes', async () => {
    const { tracer, exporter } = createTracer();
    const provider = new MockProvider({ latencyMs: 1 });

    await tracer.trace('pipeline', async () => {
      await tracer.traceLLMCall(
        'generate',
        { prompt: 'test prompt', model: 'gpt-4o', temperature: 0.7, maxTokens: 500 },
        () => provider.call({ prompt: 'test prompt', model: 'gpt-4o' }),
      );
    });

    await tracer.flush();
    const llm = exporter.getSpansByName('generate')[0];
    expect(llm.attributes[LLM_ATTRIBUTES.MODEL]).toBe('gpt-4o');
    expect(llm.attributes[LLM_ATTRIBUTES.TEMPERATURE]).toBe(0.7);
    expect(llm.attributes[LLM_ATTRIBUTES.MAX_TOKENS]).toBe(500);
    expect(llm.attributes[LLM_ATTRIBUTES.INPUT_TOKENS]).toBe(100);
    expect(llm.attributes[LLM_ATTRIBUTES.OUTPUT_TOKENS]).toBe(200);
  });

  it('does not capture content by default', async () => {
    const { tracer, exporter } = createTracer({ captureContent: false });
    const provider = new MockProvider({ latencyMs: 1 });

    await tracer.trace('pipeline', async () => {
      await tracer.traceLLMCall(
        'generate',
        { prompt: 'secret prompt' },
        () => provider.call({ prompt: 'secret prompt' }),
      );
    });

    await tracer.flush();
    const llm = exporter.getSpansByName('generate')[0];
    expect(llm.attributes[LLM_ATTRIBUTES.PROMPT]).toBeUndefined();
    expect(llm.attributes[LLM_ATTRIBUTES.COMPLETION]).toBeUndefined();
  });

  it('captures content when captureContent is true', async () => {
    const { tracer, exporter } = createTracer({ captureContent: true });
    const provider = new MockProvider({ latencyMs: 1, responseContent: 'mock output' });

    await tracer.trace('pipeline', async () => {
      await tracer.traceLLMCall(
        'generate',
        { prompt: 'my prompt' },
        () => provider.call({ prompt: 'my prompt' }),
      );
    });

    await tracer.flush();
    const llm = exporter.getSpansByName('generate')[0];
    expect(llm.attributes[LLM_ATTRIBUTES.PROMPT]).toBe('my prompt');
    expect(llm.attributes[LLM_ATTRIBUTES.COMPLETION]).toBe('mock output');
  });

  it('traceRetrieval captures document count and score', async () => {
    const { tracer, exporter } = createTracer();

    await tracer.trace('pipeline', async () => {
      await tracer.traceRetrieval('retrieve', 'search query', async () => ({
        documents: ['doc1', 'doc2'],
        documentCount: 2,
        topScore: 0.95,
      }));
    });

    await tracer.flush();
    const ret = exporter.getSpansByName('retrieve')[0];
    expect(ret.attributes[LLM_ATTRIBUTES.RETRIEVAL_DOC_COUNT]).toBe(2);
    expect(ret.attributes[LLM_ATTRIBUTES.RETRIEVAL_TOP_SCORE]).toBe(0.95);
    expect(ret.attributes[LLM_ATTRIBUTES.STAGE_TYPE]).toBe('retrieval');
  });
});

describe('Unit: Export and flush', () => {
  it('flushes queued spans to exporter', async () => {
    const { tracer, exporter } = createTracer();
    await tracer.trace('t1', async () => {});
    await tracer.trace('t2', async () => {});

    expect(exporter.getTraces()).toHaveLength(0);
    await tracer.flush();
    expect(exporter.getTraces()).toHaveLength(2);
  });

  it('handles empty flush gracefully', async () => {
    const { tracer } = createTracer();
    await tracer.flush();
  });

  it('shutdown flushes and stops', async () => {
    const { tracer, exporter } = createTracer();
    await tracer.trace('t1', async () => {});
    await tracer.shutdown();
    expect(exporter.getTraces()).toHaveLength(1);
  });
});

// =====================
// 2. Failure Mode Tests
// =====================

describe('Failure Mode: Trace export backlog', () => {
  it('drops spans when queue is full', async () => {
    const { tracer, exporter } = createTracer({ maxQueueSize: 2 });

    await tracer.trace('t1', async () => {});
    await tracer.trace('t2', async () => {});
    await tracer.trace('t3', async () => {});

    const metrics = tracer.getMetrics();
    expect(metrics.spansDropped).toBe(1);
    expect(metrics.queueSize).toBe(2);

    await tracer.flush();
    expect(exporter.getTraces()).toHaveLength(2);
  });

  it('reports spans dropped in metrics', async () => {
    const { tracer } = createTracer({ maxQueueSize: 1 });
    await tracer.trace('t1', async () => {});
    await tracer.trace('t2', async () => {});
    await tracer.trace('t3', async () => {});

    const metrics = tracer.getMetrics();
    expect(metrics.spansDropped).toBe(2);
  });
});

describe('Failure Mode: Context propagation loss', () => {
  it('produces orphaned spans when called outside any trace context', async () => {
    const { tracer, exporter } = createTracer();

    // A span created with no active trace runs as a noop — the function executes
    // but no span data is recorded. This simulates context loss.
    const result = await tracer.span('orphan', async () => 42);
    expect(result).toBe(42);

    await tracer.flush();
    // No traces at all — the span ran but wasn't captured
    expect(exporter.getTraces()).toHaveLength(0);
    expect(exporter.getSpansByName('orphan')).toHaveLength(0);
  });

  it('verifies spans inside trace context are properly nested', async () => {
    const { tracer, exporter } = createTracer();

    await tracer.trace('pipeline', async () => {
      await tracer.span('child', async () => {});
    });

    await tracer.flush();
    const root = exporter.getTraces()[0];
    expect(root.children).toHaveLength(1);
    expect(root.children[0].context.parentSpanId).toBe(root.context.spanId);
  });
});

describe('Failure Mode: Sensitive data in traces', () => {
  it('does not capture content by default', async () => {
    const { tracer, exporter } = createTracer();
    const provider = new MockProvider({ latencyMs: 1 });

    await tracer.trace('pipeline', async () => {
      await tracer.traceLLMCall(
        'llm',
        { prompt: 'SSN: 123-45-6789' },
        () => provider.call({ prompt: 'SSN: 123-45-6789' }),
      );
    });

    await tracer.flush();
    const spans = exporter.getAllSpans();
    for (const span of spans) {
      expect(span.attributes[LLM_ATTRIBUTES.PROMPT]).toBeUndefined();
      expect(span.attributes[LLM_ATTRIBUTES.COMPLETION]).toBeUndefined();
    }
  });
});

describe('Failure Mode: High cardinality attributes', () => {
  it('respects maxSpanAttributes limit', async () => {
    const { tracer, exporter } = createTracer({ maxSpanAttributes: 5 });

    await tracer.trace('root', async (span) => {
      for (let i = 0; i < 100; i++) {
        span.setAttribute(`key-${i}`, `value-${i}`);
      }
    });

    await tracer.flush();
    const trace = exporter.getTraces()[0];
    const attrCount = Object.keys(trace.attributes).length;
    expect(attrCount).toBeLessThanOrEqual(5);
  });
});

describe('Failure Mode: Instrumentation gaps', () => {
  it('produces traces with timing gaps when stages are not traced', async () => {
    const { tracer, exporter } = createTracer();

    await tracer.trace('pipeline', async () => {
      await tracer.span('retrieval', async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
      await new Promise((r) => setTimeout(r, 10));
      await tracer.span('generation', async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    });

    await tracer.flush();
    const root = exporter.getTraces()[0];
    const childDuration = root.children.reduce(
      (sum, c) => sum + (c.endTime! - c.startTime),
      0,
    );
    const rootDuration = root.endTime! - root.startTime;
    expect(rootDuration - childDuration).toBeGreaterThan(5);
  });
});

describe('Failure Mode: Silent sampling drift', () => {
  it('metrics reveal when sampling is active', async () => {
    const { tracer } = createTracer({ samplingRate: 0.0 });

    for (let i = 0; i < 100; i++) {
      await tracer.trace(`t-${i}`, async () => {});
    }

    const metrics = tracer.getMetrics();
    expect(metrics.tracesCreated).toBe(100);
    expect(metrics.tracesSampled).toBe(0);
    const sampledRatio = metrics.tracesSampled / metrics.tracesCreated;
    expect(sampledRatio).toBe(0);
  });
});

describe('Failure Mode: Export failure recovery', () => {
  it('re-enqueues spans on export failure', async () => {
    let callCount = 0;
    const failingExporter: SpanExporter = {
      export: async () => {
        callCount++;
        if (callCount === 1) throw new Error('network error');
      },
      shutdown: async () => {},
    };

    const tracer = new Tracer({ exporter: failingExporter, flushIntervalMs: 0 });
    await tracer.trace('t1', async () => {});

    await expect(tracer.flush()).rejects.toThrow('Failed to export');

    const metrics = tracer.getMetrics();
    expect(metrics.queueSize).toBeGreaterThan(0);

    await tracer.flush();
    expect(callCount).toBe(2);
  });
});

// =====================
// 3. Integration Tests
// =====================

describe('Integration: Full RAG pipeline trace', () => {
  it('traces a complete retrieval-augmented generation pipeline', async () => {
    const { tracer, exporter } = createTracer({ captureContent: true });
    const provider = new MockProvider({
      latencyMs: 5,
      responseContent: 'The answer is 42.',
      inputTokensPerRequest: 500,
      outputTokensPerRequest: 50,
    });

    const result = await tracer.trace(
      'rag-pipeline',
      async () => {
        const retrieval = await tracer.traceRetrieval('retrieve', 'what is the answer?', async () => ({
          documents: ['doc1: the answer is 42', 'doc2: some other info'],
          documentCount: 2,
          topScore: 0.92,
        }));

        const context = retrieval.documents.join('\n');
        const response = await tracer.traceLLMCall(
          'generate',
          { prompt: `Context: ${context}\nQuestion: what is the answer?`, model: 'gpt-4o' },
          () =>
            provider.call({
              prompt: `Context: ${context}\nQuestion: what is the answer?`,
              model: 'gpt-4o',
            }),
        );

        await tracer.span('validate', async (span) => {
          const valid = response.content.includes('42');
          span.setAttribute('validation.passed', valid);
          span.setAttribute('validation.check', 'contains_answer');
        });

        return response.content;
      },
      { 'pipeline.type': 'rag', 'user.session_id': 'test-session' },
    );

    expect(result).toBe('The answer is 42.');

    await tracer.flush();
    const traces = exporter.getTraces();
    expect(traces).toHaveLength(1);

    const root = traces[0];
    expect(root.name).toBe('rag-pipeline');
    expect(root.attributes['pipeline.type']).toBe('rag');
    expect(root.children).toHaveLength(3);

    const retrievalSpan = root.children[0];
    expect(retrievalSpan.name).toBe('retrieve');
    expect(retrievalSpan.attributes[LLM_ATTRIBUTES.RETRIEVAL_DOC_COUNT]).toBe(2);
    expect(retrievalSpan.attributes[LLM_ATTRIBUTES.RETRIEVAL_TOP_SCORE]).toBe(0.92);

    const genSpan = root.children[1];
    expect(genSpan.name).toBe('generate');
    expect(genSpan.attributes[LLM_ATTRIBUTES.MODEL]).toBe('gpt-4o');
    expect(genSpan.attributes[LLM_ATTRIBUTES.INPUT_TOKENS]).toBe(500);
    expect(genSpan.attributes[LLM_ATTRIBUTES.COMPLETION]).toBe('The answer is 42.');

    const valSpan = root.children[2];
    expect(valSpan.name).toBe('validate');
    expect(valSpan.attributes['validation.passed']).toBe(true);

    const allSpans = exporter.getAllSpans();
    const traceIds = new Set(allSpans.map((s) => s.context.traceId));
    expect(traceIds.size).toBe(1);
  });

  it('traces error propagation through the pipeline', async () => {
    const { tracer, exporter } = createTracer();
    const provider = new MockProvider({
      latencyMs: 1,
      errorSequence: [503],
    });

    await expect(
      tracer.trace('rag-pipeline', async () => {
        await tracer.span('retrieve', async () => ({ documents: [] }));
        await tracer.traceLLMCall(
          'generate',
          { prompt: 'test' },
          () => provider.call({ prompt: 'test' }),
        );
      }),
    ).rejects.toThrow('Provider error');

    await tracer.flush();
    const root = exporter.getTraces()[0];
    expect(root.status).toBe('error');
    expect(root.children[0].status).toBe('ok');

    const genSpan = root.children[1];
    expect(genSpan.status).toBe('error');
    expect(genSpan.attributes['error.type']).toBe('ProviderError');
  });

  it('handles concurrent pipeline traces independently', async () => {
    const { tracer, exporter } = createTracer();
    const provider = new MockProvider({ latencyMs: 1 });

    await Promise.all([
      tracer.trace('pipeline-a', async () => {
        await tracer.span('step-a1', async () => {});
        await tracer.traceLLMCall('llm-a', { prompt: 'a' }, () =>
          provider.call({ prompt: 'a' }),
        );
      }),
      tracer.trace('pipeline-b', async () => {
        await tracer.span('step-b1', async () => {});
        await tracer.traceLLMCall('llm-b', { prompt: 'b' }, () =>
          provider.call({ prompt: 'b' }),
        );
      }),
    ]);

    await tracer.flush();
    const traces = exporter.getTraces();
    expect(traces).toHaveLength(2);
    expect(traces[0].context.traceId).not.toBe(traces[1].context.traceId);
    expect(traces[0].children).toHaveLength(2);
    expect(traces[1].children).toHaveLength(2);

    for (const trace of traces) {
      for (const child of trace.children) {
        expect(child.context.traceId).toBe(trace.context.traceId);
      }
    }
  });
});

describe('Integration: MockProvider', () => {
  it('simulates configurable latency', async () => {
    const provider = new MockProvider({ latencyMs: 20 });
    const start = performance.now();
    await provider.call({ prompt: 'test' });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(15);
  });

  it('simulates deterministic error sequences', async () => {
    const provider = new MockProvider({
      latencyMs: 1,
      errorSequence: ['success', 503, 'success', 429],
    });

    const results: Array<'ok' | number> = [];
    for (let i = 0; i < 4; i++) {
      try {
        await provider.call({ prompt: 'test' });
        results.push('ok');
      } catch (e) {
        results.push((e as ProviderError).statusCode);
      }
    }

    expect(results).toEqual(['ok', 503, 'ok', 429]);
  });

  it('tracks call count and resets', async () => {
    const provider = new MockProvider({ latencyMs: 1 });
    await provider.call({ prompt: 'a' });
    await provider.call({ prompt: 'b' });
    expect(provider.getCallCount()).toBe(2);
    provider.reset();
    expect(provider.getCallCount()).toBe(0);
  });
});

describe('Integration: InMemoryExporter', () => {
  it('searches spans by name across nested traces', async () => {
    const { tracer, exporter } = createTracer();

    await tracer.trace('pipeline', async () => {
      await tracer.span('retrieve', async () => {});
      await tracer.span('generate', async () => {
        await tracer.span('llm-call', async () => {});
      });
    });

    await tracer.flush();
    expect(exporter.getSpansByName('llm-call')).toHaveLength(1);
    expect(exporter.getSpansByName('retrieve')).toHaveLength(1);
    expect(exporter.getSpansByName('nonexistent')).toHaveLength(0);
    expect(exporter.getAllSpans()).toHaveLength(4);
  });

  it('clears all traces', async () => {
    const { tracer, exporter } = createTracer();
    await tracer.trace('t1', async () => {});
    await tracer.flush();
    expect(exporter.getTraces()).toHaveLength(1);
    exporter.clear();
    expect(exporter.getTraces()).toHaveLength(0);
  });
});

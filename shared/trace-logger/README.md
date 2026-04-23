# Shared Utility: trace-logger

A minimal, reusable tracer for LLM pipelines. The span data model, context propagation, exporter interface, and LLM-specific attribute keys were duplicated across `structured-tracing`, `output-quality-monitoring`, `drift-detection`, and `online-eval-monitoring` — this utility extracts the common interface.

## What it provides

| Export | What it does |
|--------|-------------|
| `Tracer` | Root tracer — creates traces, manages the active span context, batches exports |
| `Span` | A single unit of work: set attributes, record errors, end the span |
| `ConsoleExporter` | Prints completed spans as JSON to stdout — useful for development |
| `InMemoryExporter` | Stores spans in memory — use in tests to assert on span attributes |
| `SpanExporter` | Interface for custom backends (Jaeger, Langfuse, OTLP, etc.) |
| `LLM_ATTRIBUTES` / `LLMAttributes` | Standard attribute key constants aligned with OTel GenAI semantic conventions |
| `SpanData`, `SpanContext`, `SpanStatus`, `TracerConfig` | Core type definitions |

## When to use this vs. the structured-tracing pattern

This utility provides the tracer engine. The [structured-tracing pattern](../../patterns/observability/structured-tracing/) is the right choice when you want the full production-readiness layer: architecture guidance, failure mode analysis, cost projections, operational runbooks, and tuning advice.

Use this shared utility when a pattern already has its own observability concern and needs to attach structured spans to existing request flows — for example, output-quality-monitoring recording scorer results as span attributes, or drift-detection attaching distribution stats to observed traces.

## Installation

This is a shared internal utility — import the source directly, not from npm:

```typescript
// TypeScript
import { Tracer, InMemoryExporter, LLM_ATTRIBUTES } from '../../shared/trace-logger/src/ts/index.js';
```

```python
# Python
from shared.trace_logger import Tracer, InMemoryExporter, LLMAttributes
```

## Usage

### TypeScript

```typescript
import { Tracer, InMemoryExporter, LLM_ATTRIBUTES } from './shared/trace-logger/src/ts/index.js';

const tracer = new Tracer({ serviceName: 'my-rag-pipeline' });

// Wrap a full pipeline execution in a root trace
const result = await tracer.trace('rag-pipeline', async (span) => {
  span.setAttribute('user.id', 'user-abc');

  // Nest child spans for each stage
  const docs = await tracer.span('retrieval', async (rSpan) => {
    rSpan.setAttribute(LLM_ATTRIBUTES.STAGE_TYPE, 'retrieval');
    rSpan.setAttribute(LLM_ATTRIBUTES.RETRIEVAL_DOC_COUNT, 5);
    return fetchDocuments(query);
  });

  const response = await tracer.traceLLMCall('generation', { prompt, model: 'gpt-4o' }, () =>
    llmProvider.call(prompt),
  );

  return response;
});

await tracer.flush();
await tracer.shutdown();
```

### Testing with InMemoryExporter

```typescript
import { Tracer, InMemoryExporter } from './shared/trace-logger/src/ts/index.js';

const exporter = new InMemoryExporter();
const tracer = new Tracer({ exporter, flushIntervalMs: 0 });

await tracer.trace('pipeline', async (span) => {
  span.setAttribute('key', 'value');
});
await tracer.flush();

const spans = exporter.getAllSpans();
expect(spans[0].attributes['key']).toBe('value');
```

### Python

```python
from shared.trace_logger import Tracer, InMemoryExporter, LLMAttributes, TracerConfig

exporter = InMemoryExporter()
tracer = Tracer(TracerConfig(exporter=exporter, flush_interval_s=0))

with tracer.trace("rag-pipeline") as span:
    span.set_attribute("user.id", "user-abc")

    with tracer.span("retrieval") as r_span:
        r_span.set_attribute(LLMAttributes.STAGE_TYPE, "retrieval")
        r_span.set_attribute(LLMAttributes.RETRIEVAL_DOC_COUNT, 5)

tracer.flush()

spans = exporter.all_spans()
assert spans[0].attributes["user.id"] == "user-abc"
```

## How consuming patterns use it

### structured-tracing

The pattern's full implementation — the tracer, exporters, and all types — is the canonical source. This shared utility extracts exactly those components so other patterns don't duplicate the span data model.

### output-quality-monitoring

Quality scores are recorded as span attributes on each scored interaction. The pattern attaches `quality.score` and `quality.scorer` attributes to existing pipeline traces by calling `tracer.span('quality-score', ...)` after a response is generated — keeping quality data co-located with latency and token data in the same trace.

### drift-detection

Distribution stats (mean, stdDev, p95) are recorded as span attributes when a drift check fires. Tagging spans with `drift.score` and `drift.dimension` lets you correlate behavioral drift with specific request characteristics visible in the trace.

### online-eval-monitoring

Eval results are attached to the traces they evaluate. The monitor records `eval.scorer`, `eval.score`, and `eval.passed` on the span context for the interaction being scored — giving a trace that shows both what the model did and whether it passed the eval.

## Wiring example: structured-tracing + output-quality-monitoring

```typescript
import { Tracer, LLM_ATTRIBUTES } from '../shared/trace-logger/src/ts/index.js';
import { QualityMonitor, LengthScorer } from '../patterns/observability/output-quality-monitoring/src/ts/index.js';

const tracer = new Tracer({ serviceName: 'rag-api' });
const monitor = new QualityMonitor();
monitor.addScorer(new LengthScorer(50, 2000));

// Trace the pipeline
const response = await tracer.trace('rag-pipeline', async (span) => {
  const result = await llmProvider.call(prompt);
  span.setAttribute(LLM_ATTRIBUTES.INPUT_TOKENS, result.usage.inputTokens);
  span.setAttribute(LLM_ATTRIBUTES.OUTPUT_TOKENS, result.usage.outputTokens);

  // Score quality off the critical path, attaching results to the same span
  monitor.observe({ input: prompt, output: result.content, latencyMs: result.latencyMs }).then(
    (scores) => scores.forEach((s) => span.setAttribute(`quality.${s.scorerName}`, s.value)),
  );

  return result;
});
```

## Running the tests

```bash
# TypeScript
cd shared/trace-logger/src/ts
npm install
npm test

# Python
cd shared/trace-logger/src/py
python -m pytest tests/ -v
```

## LLM_ATTRIBUTES reference

All keys are aligned with [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/):

| Key | Value | When to use |
|-----|-------|-------------|
| `LLM_ATTRIBUTES.MODEL` | `gen_ai.request.model` | Model identifier on LLM call spans |
| `LLM_ATTRIBUTES.INPUT_TOKENS` | `gen_ai.usage.input_tokens` | Token counts from provider response |
| `LLM_ATTRIBUTES.OUTPUT_TOKENS` | `gen_ai.usage.output_tokens` | Token counts from provider response |
| `LLM_ATTRIBUTES.PROMPT` | `gen_ai.prompt` | Prompt text (requires `captureContent: true`) |
| `LLM_ATTRIBUTES.COMPLETION` | `gen_ai.completion` | Response text (requires `captureContent: true`) |
| `LLM_ATTRIBUTES.RETRIEVAL_DOC_COUNT` | `retrieval.document_count` | Number of docs returned from vector search |
| `LLM_ATTRIBUTES.RETRIEVAL_TOP_SCORE` | `retrieval.top_score` | Highest relevance score from retrieval |
| `LLM_ATTRIBUTES.STAGE_TYPE` | `pipeline.stage.type` | Stage classification (retrieval, generation, validation) |

## Design decisions

**Why not wrap OpenTelemetry directly?** The OTel Node SDK adds measurable throughput overhead (the structured-tracing pattern benchmarks show ~40K ops/sec at full OTel vs. ~82K ops/sec with 10% sampling using this lightweight tracer). The exporter interface is intentionally OTel-compatible — bridging to an OTLP backend is straightforward when needed.

**Why context-based nesting?** Passing parent span IDs manually is error-prone and couples pipeline stages to each other. `AsyncLocalStorage` (Node) and `contextvars` (Python) propagate context automatically through async chains, keeping the API clean for the common case of single-process pipelines.

**Why no singleton?** Singleton tracers create test coupling and make it impossible to test with different configurations in parallel. Each `Tracer` instance owns its exporter and queue.

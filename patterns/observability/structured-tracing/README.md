# Structured Tracing

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

LLM calls return 200 OK and the response reads fluently — but the answer's wrong. Without structured tracing, there's no way to tell whether the problem was a bad retrieval, a poorly constructed prompt, an ignored context window, or a model hallucination. The system looks healthy from every traditional monitoring angle: latency is normal, error rate is zero, and throughput is steady.

This is the fundamental gap. A modern LLM pipeline isn't a single API call — it's a chain: user input → guardrail check → query embedding → vector search → reranking → prompt assembly → LLM generation → output parsing → validation. When output quality degrades, the failure could be hiding in any of those stages. Traditional logging captures events but not causality. Flat logs from a RAG pipeline might show "retrieved 5 documents" and "generated response in 1.2s" — but they don't connect the two. They can't tell you that the retrieved documents were irrelevant, which made the generation confident but wrong.

The cost of debugging without traces is real. Even with tracing, you could be spending 20+ minutes scanning 200+ spans to find root causes in complex agent workflows. Without traces, that same investigation means manually grepping through logs hoping to reconstruct a call chain that crossed multiple services — often after the relevant logs have already rotated out of retention. A single LLM trace is roughly 25KB (prompts, completions, metadata), roughly 50x larger than a typical microservice trace — though both numbers vary by implementation. At 10K requests/day, that's 250MB of trace data daily. The data volume alone makes ad-hoc debugging approaches collapse within weeks.

## What I Would Not Do

The first instinct is `console.log` everywhere — log the prompt, log the response, log the retrieval results, maybe add a timestamp. This works for about a week.

Here's what breaks. Each log line is independent. There's no correlation ID linking the retrieval step to the generation step to the validation step within a single request. When a user reports a bad response, reconstructing the full pipeline execution means searching for timestamps that roughly align across multiple log streams, hoping no two requests interleaved in the same second.

At around 1K requests/day, this manual correlation starts failing. At 10K/day, it's impossible — the log volume is too high, the interleaving is too dense, and you're spending more time reconstructing traces than actually diagnosing problems. It's also fragile: a single missing log statement (someone forgot to log the embedding step) creates a blind spot that might not surface for months.

The next common approach is adding a `requestId` field to every log line. Better, but still insufficient. You can now filter logs by request, but there's no hierarchy — you can't see that the retrieval span was a child of the pipeline span, or that three LLM calls happened in parallel within the same request. Without parent-child relationships, you can't compute time spent in each stage, identify which stage contributed most to latency, or detect when one stage's output corrupted the next stage's input.

Some teams reach for a full APM tool (Datadog, New Relic) assuming it'll cover LLM calls automatically. It won't — traditional APM captures HTTP spans and database queries, but doesn't know about prompt construction, token counts, model parameters, or retrieval relevance. The traces exist but lack the LLM-specific attributes that make them useful for diagnosing quality problems.

## When You Need This

- Your LLM pipeline has more than one step — retrieval, generation, validation, tool calls, or any combination — and you can't currently answer "why did this specific request produce a bad response?" from your logs
- Debugging a single bad output takes more than 5 minutes because you're manually correlating log lines across services
- You're past the prototype stage and need to diagnose latency bottlenecks, cost attribution per pipeline stage, or quality regressions
- Multiple people are debugging the same system and need a shared understanding of request flow, not individual `grep` intuitions
- You want to build downstream observability (quality monitoring, drift detection, eval loops) that depends on having structured traces to analyze

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **Agents → Critical.** Agent loops are non-deterministic and multi-step — tool calls, reasoning chains, and branching decisions create execution paths that are nearly impossible to reconstruct from flat logs. Without structured traces showing the parent-child hierarchy of each decision, I wouldn't be able to diagnose why an agent chose tool A over tool B, or why it looped 7 times instead of 3. This is the system type where production could genuinely break without tracing — a single misrouted tool call in a 12-step agent run is invisible without span-level visibility.
- **RAG → Required.** RAG pipelines have a clear failure boundary between retrieval and generation. If the retrieval returns irrelevant documents, the generation will confidently produce wrong answers — and the output looks perfectly fine. I wouldn't want to get paged for a quality degradation without traces that separate retrieval quality (what was fetched, relevance scores) from generation quality (what was produced given the context). Without that separation, every investigation starts with "is it the data or the model?" and takes too long to answer.
- **Streaming → Required.** Streaming adds time-sensitivity to the tracing problem. Token delivery latency, time-to-first-token, and partial response failures all need span-level timing to diagnose. I wouldn't be comfortable operating a streaming system without traces that show where latency accumulated across the pipeline — a 200ms retrieval step is fine, but a 200ms-per-token delivery step isn't, and you can't distinguish them without structured spans.
- **Batch → Recommended.** Batch systems process high volumes but usually without a user waiting, so the debugging urgency is lower. I'd notice the gap by month six — when a batch job's quality degrades across 100K items, traces let you sample specific items and drill into their pipeline execution. Without traces, you're limited to aggregate statistics that tell you _something_ degraded but not _where_.

## The Pattern

### Architecture

**Pipeline flow** — how the tracer wraps a request at runtime:

```
User Request
     │
     ▼
┌──────────────────────────────────────────────────┐
│  Tracer (context-based span nesting)             │
│                                                  │
│  ┌────────────────┐                              │
│  │  1. Retrieval   │  query, doc_count, scores   │
│  └───────┬────────┘                              │
│          ▼                                       │
│  ┌────────────────┐                              │
│  │  2. Generation  │  model, tokens_in/out       │
│  └───────┬────────┘                              │
│          ▼                                       │
│  ┌────────────────┐                              │
│  │  3. Validation  │  passed, errors             │
│  └───────┬────────┘                              │
│          ▼                                       │
│  ┌─────────────────┐    ┌──────────────────────┐ │
│  │  Span Exporter  │───▶│  Backend (Jaeger,    │ │
│  │  (configurable) │    │  Langfuse, stdout…)  │ │
│  └─────────────────┘    └──────────────────────┘ │
└──────────────────────────────────────────────────┘
```

**Resulting span tree** — what the trace looks like in a viewer:

```
Pipeline Span (root)                    ← 1 per request
├── Retrieval Span                      ← query, doc_count, scores
├── Generation Span
│   └── LLM Call Span                   ← model, tokens_in, tokens_out, latency_ms
└── Validation Span                     ← passed, errors
```

The pipeline flow shows where spans are created; the span tree shows how they nest. Attributes shown (doc_count, tokens, latency) are illustrative — actual values depend on the specific pipeline and model.

#### Core Abstraction

The tracer exposes a minimal interface: start a trace, create spans (with automatic parent-child nesting via context), attach LLM-specific attributes, and export completed traces.

```typescript
interface Tracer {
  // Start a new root trace for a pipeline execution
  startTrace(
    name: string,
    attributes?: Record<string, SpanAttributeValue>
  ): Trace;

  // Create a child span within the current trace context
  startSpan(
    name: string,
    attributes?: Record<string, SpanAttributeValue>
  ): Span;

  // Get the currently active span (for nesting)
  getActiveSpan(): Span | undefined;
}

interface Span {
  // Attach attributes at any point during span lifetime
  setAttribute(key: string, value: SpanAttributeValue): void;

  // Record an error that occurred during this span
  recordError(error: Error): void;

  // Mark span as complete
  end(): void;
}
```

The key design choice is **context-based nesting**. Rather than manually passing parent span IDs, the tracer uses async context (Node.js `AsyncLocalStorage` / Python `contextvars`) to automatically nest spans under their parent. This keeps the API clean — callers just start and end spans without wiring up the tree.

#### Configurability

| Parameter           | Default           | Purpose                                                      |
| ------------------- | ----------------- | ------------------------------------------------------------ |
| `exporter`          | `ConsoleExporter` | Where traces go — console, HTTP endpoint, or custom backend  |
| `captureContent`    | `false`           | Whether to record prompt/completion text (privacy-sensitive) |
| `samplingRate`      | `1.0`             | Fraction of traces to record (1.0 = all, 0.1 = 10%)          |
| `maxSpanAttributes` | `64`              | Cap on attributes per span to prevent memory bloat           |
| `flushIntervalMs`   | `5000`            | How often to batch-export spans to the backend               |
| `maxQueueSize`      | `2048`            | Max spans queued before dropping (backpressure)              |

These defaults are starting points. SLA requirements, provider response times, and data sensitivity would all shift them — a healthcare system would keep `captureContent: false` and `samplingRate: 1.0`, while a high-throughput batch system might use `samplingRate: 0.1` and a shorter flush interval.

#### Key Design Tradeoffs

| Tradeoff                                              | Decision                                                                             | Consequence                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Custom tracer vs. raw OpenTelemetry SDK**           | Lightweight custom tracer wrapping the OTel concepts without the full SDK            | Avoids the [19-80% throughput overhead](https://atlarge-research.com/pdfs/2024-msc-anders_tracing_overhead.pdf) that one academic study measured with full OTel instrumentation under various configurations, at the cost of not being immediately compatible with OTel backends. The exporter interface makes it straightforward to bridge to OTel when needed. |
| **Context-based nesting vs. explicit parent passing** | Automatic context propagation via `AsyncLocalStorage` / `contextvars`                | Cleaner API — callers just start and end spans without wiring up the tree. Makes it harder to trace across async boundaries that break context (worker threads, message queues). Favors developer ergonomics for the common case (single-process pipelines) while documenting the escape hatch for distributed scenarios.                                        |
| **Content capture off by default**                    | `captureContent: false` — requires explicit opt-in to record prompts and completions | Prevents accidental PII leakage into trace backends. The cost is that initial debugging is harder until the team decides to enable it. When enabled, storage increases ~5x.                                                                                                                                                                                      |
| **Synchronous span creation, async export**           | Span creation is synchronous; export is batched and async via `flushIntervalMs`      | Minimizes latency on the hot path — span creation adds ~0.014ms (from this pattern's benchmarks). Network calls to the trace backend don't block request processing. The risk is that spans can be lost if the process crashes before the next flush.                                                                                                            |

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

| Failure Mode                                                                                                                                                                                 | Detection Signal                                                                                                                                                                           | Mitigation                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trace export backlog** — span queue fills faster than the exporter can drain it, causing span drops                                                                                        | `spans_dropped` counter increases; queue size metric stays near `maxQueueSize`                                                                                                             | Increase `maxQueueSize`, reduce `flushIntervalMs`, or switch to a faster exporter. If the backend is slow, add a local buffer (file-based) as a spill-over.                                                                                                                                                                  |
| **Context propagation loss** — async boundaries (worker threads, message queues, `setTimeout`) break the context chain, producing orphaned spans with no parent                              | Orphaned span count rises; traces appear incomplete in the visualization — root spans have missing children                                                                                | Explicitly pass `traceId` and `parentSpanId` across async boundaries that don't propagate `AsyncLocalStorage`. Document which boundaries need manual propagation.                                                                                                                                                            |
| **Sensitive data in traces** — `captureContent: true` records PII, API keys, or other sensitive data into the trace backend                                                                  | Periodic audit of exported traces reveals PII; compliance scanning flags trace storage                                                                                                     | Keep `captureContent: false` by default. When enabled, run a redaction filter on span attributes before export. Integrate with the PII Detection pattern.                                                                                                                                                                    |
| **High cardinality attributes** — unbounded attribute values (raw user queries, full document contents) explode storage and make trace backends slow to query                                | Trace backend query latency increases; storage costs grow faster than request volume                                                                                                       | Cap attribute value length (e.g., 256 chars). Use `maxSpanAttributes` to limit count. Log full content to a separate store if needed.                                                                                                                                                                                        |
| **Instrumentation gaps** — some pipeline stages are traced, others aren't, creating blind spots in the trace tree                                                                            | Traces show timing gaps between parent span duration and sum of child spans; manual inspection reveals missing stages                                                                      | Maintain a "span coverage" checklist for each pipeline. Add an integration test that verifies all expected spans appear in a trace.                                                                                                                                                                                          |
| **Silent sampling drift** — sampling rate is set to 1.0 at launch but someone reduces it to 0.01 during a cost-cutting initiative, and months later the team assumes they have full coverage | Trace volume drops but no alert fires because `spans_dropped` stays at zero — the spans were never created. Quality regressions go undiagnosed because sampled traces happen to look fine. | Alert on `trace_volume` as a ratio of request volume. If `traces / requests` drops below expected sampling rate by >10%, fire a warning. Review sampling config quarterly. This is the silent degradation failure — it happens gradually, nobody notices, and it erodes the value of every downstream observability pattern. |

## Observability & Operations

- **Key metrics:**

| Metric              | Type      | Description                                                                                                                              |
| ------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `traces_created`    | counter   | Total traces started. Baseline for all other ratios.                                                                                     |
| `traces_sampled`    | counter   | Traces actually recorded. Compare to `traces_created` to verify sampling rate matches config.                                            |
| `spans_created`     | counter   | Total spans created across all traces. Useful for spotting instrumentation changes (sudden increase = new spans added, decrease = gaps). |
| `spans_dropped`     | counter   | Spans lost due to queue backpressure. This should be zero in steady state.                                                               |
| `export_queue_size` | gauge     | Current depth of the span export queue.                                                                                                  |
| `export_latency_ms` | histogram | Time to flush a batch to the backend. Tracks exporter health.                                                                            |
| `export_errors`     | counter   | Failed export attempts. Non-zero means traces are being lost or re-queued.                                                               |
| `trace_duration_ms` | histogram | End-to-end trace duration. Helps detect when the tracing overhead itself becomes a problem.                                              |

- **Alerting:**

| Severity           | Condition                                                                        | Meaning                                                           |
| ------------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Warning            | `spans_dropped > 0` sustained for >5 minutes                                     | Queue is under pressure, traces are being lost                    |
| Warning            | `traces_sampled / traces_created` deviates from configured sampling rate by >10% | Possible config drift or sampling logic bug                       |
| Warning            | `export_latency_ms` p95 > 1000ms                                                 | Exporter is slow, spans are backing up                            |
| Warning (low-side) | `spans_created / traces_created` drops below expected ratio                      | Instrumentation gaps — pipeline stages are no longer being traced |
| Critical           | `export_errors` > 10 in 5 minutes                                                | Exporter is failing, traces are being lost at scale               |
| Critical           | `traces_created` drops to zero while request volume is non-zero                  | Tracing has silently stopped                                      |

These thresholds are starting points — the right values depend on baseline traffic profile, SLA requirements, and how aggressively you've tuned the queue size.

- **Runbook:**
  - **spans_dropped > 0:** Check `export_queue_size` — if near `maxQueueSize`, increase the limit or reduce `flushIntervalMs`. If the exporter is slow, check backend health (is Jaeger/Langfuse reachable? is the network saturated?). If the queue grows unbounded, add a file-based spill-over buffer.
  - **export_errors spiking:** Check the exporter's target endpoint. Is the trace backend healthy? DNS resolution working? Network connectivity stable? If the backend is down, traces queue locally — verify `maxQueueSize` is large enough to buffer during the outage window.
  - **sampling ratio drift:** Pull the current config from the deployment. Compare `samplingRate` in config vs. the observed ratio. If they match, the issue is resolved (config was intentionally changed). If they don't match, check for environment variable overrides or dynamic config updates that bypassed version control.
  - **traces_created = 0:** Check if the tracing middleware is still initialized. Look for deployment changes that might have removed the tracer from the request path. Verify the tracer constructor was called (check startup logs). If the tracer is initialized but not creating traces, check if sampling rate was set to 0.

## Tuning & Evolution

- **Tuning levers:**

| Parameter           | Default | Effect                                                                                                                                                                                              | Safe Range                 | Dangerous Extreme                                                                   |
| ------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| `samplingRate`      | 1.0     | Reduces storage and export costs linearly. At >10K req/day, 10% sampling still provides enough traces for statistical analysis while reducing overhead by ~2x (from benchmarks: 40K → 82K ops/sec). | 0.01–1.0                   | 0.0 — disables tracing entirely, only useful for emergency performance recovery     |
| `maxQueueSize`      | 2048    | Controls backpressure behavior. Increase if `spans_dropped > 0` in steady state.                                                                                                                    | 1024–16384                 | Above 16K — memory usage may become significant (~80KB per queued span at 5KB each) |
| `flushIntervalMs`   | 5000    | How often spans are batch-exported. Lower = less data loss on crash, higher = fewer export calls.                                                                                                   | 1000–30000                 | Below 1000ms — export overhead may compete with request processing                  |
| `maxSpanAttributes` | 64      | Caps attributes per span. From benchmarks: 64 attributes = 0.073ms/span, 256 = 1.935ms/span.                                                                                                        | 16–128                     | 256+ — measurable latency impact                                                    |
| `captureContent`    | false   | Toggle prompt/completion recording. Enables rich debugging but 5x storage increase. Consider enabling per-environment (staging: on, production: off).                                               | true/false per environment | true in production without PII redaction                                            |

- **Drift signals:**

| Signal                                                                            | Meaning                                                                                          |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `spans_created / traces_created` ratio changes                                    | Instrumentation was added or removed (pipeline refactoring, new stages, removed steps)           |
| `export_latency_ms` trending upward over weeks                                    | Trace backend may need scaling or index maintenance                                              |
| `trace_duration_ms` p99 increasing without corresponding request latency increase | Tracing overhead is growing, likely from attribute count or nesting depth increases              |
| Quarterly config review needed                                                    | Compare current `samplingRate`, `maxQueueSize`, and `maxSpanAttributes` to actual usage patterns |

- **Silent degradation:**
  - **Month 3:** Sampling rate was reduced from 1.0 to 0.1 during a cost-cutting sprint. The team forgets this happened. Downstream patterns (quality monitoring, drift detection) now analyze only 10% of traffic, missing rare failure modes that affect <10% of requests.
  - **Month 6:** Several pipeline stages were refactored but nobody updated the tracing instrumentation. Traces show 3 spans where there should be 5 — two stages are invisible. The team assumes quality is fine because traced stages look healthy, while the untraced stages have quietly degraded.
  - **Proactive checks:** Run a monthly "trace completeness audit" — compare the expected span tree structure (from pipeline documentation) to actual traces. Alert if the ratio of `child_span_duration / parent_span_duration` drops below 80% (indicating significant untraced work).

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers.

| Scale        | Additional Cost  | ROI vs. No Pattern                                                   |
| ------------ | ---------------- | -------------------------------------------------------------------- |
| 1K req/day   | +$5/month infra  | Pays for itself with 1-2 debugging incidents/month                   |
| 10K req/day  | +$20/month infra | 37-75x ROI from debugging time savings alone                         |
| 100K req/day | +$75/month infra | 25-50x ROI; enables downstream patterns that reduce wasted LLM spend |

## Testing

See [`src/ts/__tests__/index.test.ts`](src/ts/__tests__/index.test.ts) for the full test suite. Run with `cd src/ts && npm test`.

- **Unit tests (19 tests):** Span creation, attribute setting (including after-end rejection), error recording, duration computation, context nesting (including deep and parallel spans), sampling rate, maxSpanAttributes cap, service name injection, LLM call tracing (model/token/content attributes), retrieval tracing, and flush/shutdown behavior.
- **Failure mode tests (7 tests):** One test per Failure Modes table row — trace export backlog (queue full drops spans, metrics report drops), context propagation loss (orphaned spans outside trace context, nested span verification), sensitive data protection (content not captured by default), high cardinality attributes (maxSpanAttributes enforced), instrumentation gaps (timing gaps detected), silent sampling drift (metrics expose sampling ratio), and export failure recovery (re-enqueue on exporter error).
- **Integration tests (7 tests):** Full RAG pipeline (retrieve → generate → validate with attribute verification and trace ID consistency), error propagation through pipeline, concurrent independent traces, MockProvider behavior (configurable latency, deterministic error sequences, call count tracking), and InMemoryExporter search capabilities.

## When This Advice Stops Applying

- **Single-step LLM calls with no chain** — if your system is literally "send prompt, get response," basic request/response logging is sufficient. Structured tracing adds value when there's a pipeline to trace. A single API call doesn't need parent-child span relationships.
- **Prototypes and rapid iteration** — when you're changing the prompt 20 times a day and the system serves 50 requests total, the overhead of setting up tracing infrastructure isn't worth it. `console.log` is fine until the system stabilizes enough that you need to diagnose rather than rewrite.
- **Existing APM with LLM-native support** — if your team already runs [Datadog LLM Observability](https://www.datadoghq.com/product/llm-observability/) or a similar tool that captures prompt/completion/token data natively, building custom tracing duplicates work. The value of this pattern is the trace structure, not the specific implementation — if something else already provides it, use that.
- **Very low volume systems (<100 req/day)** — when you can manually inspect every request, the investment in tracing infrastructure doesn't pay off. The break-even is roughly when manual log inspection takes longer than reading a trace visualization would.
- **[OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/) mature enough for your stack** — as the OTel GenAI SIG stabilizes conventions, framework-level auto-instrumentation might handle tracing without custom code. If your framework (LangChain, LlamaIndex) ships with OpenTelemetry spans that capture the attributes you need, custom tracing becomes unnecessary scaffolding.

<!-- ## Companion Content

- Blog post: [Structured Tracing — Deep Dive](https://prompt-deploy.com/structured-tracing) (coming soon)
- Related patterns:
  - [Graceful Degradation](../../resilience/graceful-degradation/) — traces reveal which degradation paths are triggered and how often
  - [Output Quality Monitoring](../output-quality-monitoring/) (#16, S5) — attaches quality scores to traces, turning individual traces into quality data points
  - [Drift Detection](../drift-detection/) (#28, S8) — uses trace data to detect behavioral changes over time by comparing trace attribute distributions
  - [Online Eval Monitoring](../online-eval-monitoring/) (#21, S6) — runs eval functions on traced production traffic for continuous quality assessment
  - [Prompt Version Registry](../prompt-version-registry/) (#10, S3) — traces reference prompt versions, enabling correlation between prompt changes and quality shifts
  - [PII Detection](../../safety/pii-detection/) (#7, S2) — traces that capture content must run through PII detection to prevent sensitive data leakage into trace backends -->

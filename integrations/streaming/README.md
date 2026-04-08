# Integration Guide: Streaming Systems

> **Part of [Production LLM Patterns](../../README.md).** This guide shows which patterns to combine for streaming LLM systems, in what order to adopt them, and how they wire together in practice.

A streaming system is a live connection: the user is watching tokens arrive in real time, and every failure is immediately visible. There's no spinner, no retry window, no way to hide a dropped stream behind a loading state. The moment generation stalls, the user sees it.

The way I think about streaming in production: the defining constraint is the connection, not the generation. Getting tokens out of a model is a solved problem — providers handle that. The hard part is delivering those tokens reliably over a real network to clients you don't control, across intermediaries that may buffer or drop chunks, from provider infrastructure that goes down several times a year. The resilience patterns carry more weight here than in any other system type.

What that means for pattern selection: streaming has five Critical-rated patterns — more than RAG, fewer than agents, but concentrated in resilience and performance where the streaming-specific failure modes live. Every one of them addresses something that causes a visibly broken experience if it's absent.

---

## Pattern Priority for Streaming

These designations come from the [Navigation Matrix](../../README.md#navigation-matrix). The way I'd read this: **Critical** goes in before launch, **Required** should be in place before I'd be comfortable being paged, **Recommended** is solid practice once those are in place.

### Critical — absence risks outages or user-visible failures

| Pattern | Why for Streaming |
|---------|------------------|
| [Graceful Degradation](../../patterns/resilience/graceful-degradation/) | When generation fails mid-stream, the user sees a broken response. Without a defined fallback — a retry on a secondary provider, a clean error message, or a partial-completion signal — the stream just stops mid-sentence. |
| [Multi-Provider Failover](../../patterns/resilience/multi-provider-failover/) | A dropped stream is immediately visible. An [OpenAI outage in December 2024](https://status.openai.com/incidents/01JMYB483C404VMPCW726E8MET) took down the API for over four hours. Without failover, every active streaming session breaks simultaneously — there's no graceful degradation without a secondary target to fail over to. |
| [Circuit Breaker](../../patterns/resilience/circuit-breaker/) | When a provider is degraded, a streaming system without a circuit breaker spends 30+ seconds hammering a dead endpoint before failing over. For a user watching tokens arrive, that delay is unacceptable. The circuit breaker is what makes failover fast enough to matter. |
| [Latency Budget](../../patterns/performance/latency-budget/) | Time to first token (TTFT) is the single most user-visible metric in streaming. If the pipeline can't start streaming within ~1 second, the experience feels broken even if the generation is fast. A latency budget enforces a TTFT ceiling and allows the pipeline to shed optional enrichment steps when the deadline is close. |
| [Streaming Backpressure](../../patterns/performance/streaming-backpressure/) | LLM inference engines generate tokens at 100+ tokens/second; mobile clients on poor connections consume far slower. Without flow control, the server's write queue grows without bound — a spike of slow clients causes OOM, taking down every concurrent session including the fast ones. [NGINX's default proxy buffering](https://www.getpagespeed.com/server-setup/nginx-reverse-proxy-ollama-vllm) silently breaks SSE token delivery unless `proxy_buffering off` is set. |

### Required — the system runs without it, but it's not production-ready

| Pattern | Why for Streaming |
|---------|------------------|
| [Retry with Budget](../../patterns/resilience/retry-with-budget/) | Provider rate limits and transient 503s happen. Without retry logic, every transient error produces a broken stream. The budget prevents retry cascades — at 1K concurrent streams, unbounded retries can amplify a momentary provider hiccup into sustained overload. |
| [Structured Tracing](../../patterns/observability/structured-tracing/) | Streaming failures are hard to debug without traces. The question "why did that stream stall at token 40?" needs spans covering connection setup, TTFT, token delivery rate, and provider response codes. Without traces, the only signal is user complaints. |
| [Structured Output Validation](../../patterns/safety/structured-output-validation/) | Not all streaming responses are plain text — many streaming systems deliver structured content (JSON, markdown with specific formatting) that downstream consumers parse. A malformed closing tag or truncated JSON object at stream end is as bad as a dropped connection. |
| [PII Detection](../../patterns/safety/pii-detection/) | Streaming chat systems accumulate conversation history that may contain PII. That history is echoed back into every subsequent turn's context window. The exposure surface grows with every message if PII isn't detected and handled at the input boundary. |
| [Prompt Injection Defense](../../patterns/safety/prompt-injection-defense/) | Streaming chat systems are a primary target for prompt injection — users have a natural expectation of direct influence over the output. An injected instruction in a multi-turn session can redirect later turns in ways that are hard to detect after the fact. |
| [Context Management](../../patterns/data-pipeline/context-management/) | Every streaming turn appends to the conversation history. Without active management, long sessions hit the context window ceiling and start losing earlier messages — silently, since generation continues without error but with degraded coherence. A 15-turn conversation can consume 30K+ tokens before the actual current question. |

### Recommended — solid engineering practice once the foundation is in place

| Pattern | Why for Streaming |
|---------|------------------|
| [Token Budget Middleware](../../patterns/cost-control/token-budget-middleware/) | Long streaming sessions with verbose users can accumulate far more context than expected. Token budgets per session prevent outlier conversations from costing 10× the average. |
| [Output Quality Monitoring](../../patterns/observability/output-quality-monitoring/) | Quality degradation in streaming systems shows up as coherence issues, truncated thoughts, and mid-stream topic shifts — not errors. Monitoring catches degradation that never triggers an alert. |
| [Prompt Version Registry](../../patterns/observability/prompt-version-registry/) | Streaming system prompts change frequently. Without versioning, correlating a quality shift to the prompt update that caused it requires detective work across logs. |
| [Online Eval Monitoring](../../patterns/observability/online-eval-monitoring/) | CI evals cover scripted scenarios. Production streaming sessions are messier — longer conversations, more diverse user inputs, more unexpected turns. Online monitoring samples real sessions. |
| [Eval Harness](../../patterns/testing/eval-harness/) | Streaming quality isn't verifiable with unit tests. An eval harness that scores multi-turn coherence and response quality against representative conversation samples is the baseline for detecting regressions. |
| [Regression Testing](../../patterns/testing/regression-testing/) | Every prompt change, model version update, or context management configuration change is a regression risk. Streaming quality is sensitive to prompt wording in ways that don't surface in unit tests. |
| [Prompt Rollout Testing](../../patterns/testing/prompt-rollout-testing/) | Streaming prompt changes can alter tone, verbosity, and response structure across all sessions simultaneously. Rolling out to 5% of traffic first limits the blast radius of unexpected behavioral changes. |
| [Agent Loop Guards](../../patterns/orchestration/agent-loop-guards/) | For streaming systems with light agentic behavior (tool calls, multi-step reasoning), loop guards prevent runaway generation when the model gets stuck in a reasoning loop or fails to converge. |
| [Model Routing](../../patterns/cost-control/model-routing/) | Simple conversational turns (acknowledgments, clarification questions) don't need a frontier model. Routing them to a lighter model reduces cost per session without user-visible quality change. |
| [Concurrent Request Management](../../patterns/performance/concurrent-request-management/) | Under load, unmanaged concurrent connections spike provider rate limits. Each streaming session holds a long-running connection — 100 concurrent sessions can exhaust rate limits faster than 100 independent requests. |
| [Cost Dashboard](../../patterns/cost-control/cost-dashboard/) | Once token budgets are in place, a dashboard makes per-session and per-day spend visible. Streaming cost profiles differ from request-response — longer sessions and higher token counts per interaction. |
| [Adversarial Inputs](../../patterns/testing/adversarial-inputs/) | Streaming chat systems are a direct interface between users and the model. Jailbreaks, prompt injections, and manipulation attempts are worth testing against deliberately before launch. |

### Optional — context-dependent

| Pattern | Why for Streaming |
|---------|------------------|
| [Drift Detection](../../patterns/observability/drift-detection/) | Useful if input distributions shift meaningfully over time (new user populations, seasonal topics). Less critical for streaming than for RAG or batch — input drift in conversational systems is typically slower-moving. |
| [Prompt Diffing](../../patterns/observability/prompt-diffing/) | Valuable when debugging why a prompt change shifted response quality or tone. Worth adding once the team is actively iterating on system prompts. |
| [Snapshot Testing](../../patterns/testing/snapshot-testing/) | Catches unexpected format regressions in structured streaming outputs. Relevant only if downstream consumers parse the streaming content programmatically. |
| [Tool Call Reliability](../../patterns/orchestration/tool-call-reliability/) | Relevant only if the streaming system makes tool calls (streaming + tools is a specific architecture, not universal). |
| [Multi-Agent Routing](../../patterns/orchestration/multi-agent-routing/) | Relevant only for multi-agent streaming architectures — a minority of streaming deployments. |

---

## System Architecture

A streaming system has two concerns: the **delivery path** (connection → generation → client) and the **resilience layer** (what happens when anything in that path fails). Both need pattern coverage, but the delivery path is where streaming-specific failures occur.

```
   User (SSE / WebSocket connection)
           │
           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  A. Input Guard Layer                                                │
│     1. Prompt Injection Defense — scan message for injections       │
│     2. PII Detection — detect/redact PII in user input              │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ clean input
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  B. Context Assembly                                                 │
│     Context Management — fit conversation history to window         │
│       → pin system prompt + recent N turns                          │
│       → compress or summarize stale history                         │
│     Token Budget — record context tokens consumed                   │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ assembled context
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  C. Latency Gate                                                     │
│     Latency Budget — set TTFT deadline (e.g. 800ms to first token)  │
│       → skip optional enrichment if deadline is close               │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ request with deadline
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  D. Provider Layer                                                   │
│     Circuit Breaker — CLOSED: pass through; OPEN: fail fast         │
│       │                                                              │
│       ├─ [circuit CLOSED] → Primary Provider (streaming call)       │
│       │     Retry with Budget — transient errors get bounded retry  │
│       │                                                              │
│       └─ [circuit OPEN / failure] → Multi-Provider Failover         │
│             → Secondary Provider                                     │
│             → Graceful Degradation (error message / partial result) │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ token stream
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  E. Stream Delivery                                                  │
│     Streaming Backpressure — flow control per client                │
│       → check write buffer before each chunk                        │
│       → drain() / pause signal when client is slow                  │
│       → detect client disconnect → cancel upstream generation       │
│     Structured Output Validation — validate at stream completion    │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ tokens → client
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  F. Observability (Side Channel)                                    │
│     Structured Tracing — spans: connection, TTFT, delivery rate     │
│     Output Quality Monitoring — score completed responses           │
│     Token Budget — record actual token spend per session            │
│     Circuit Breaker — record trip events, recovery times            │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Adoption Sequence

The way I'd sequence these: start with what keeps the stream alive (resilience layer), then add what makes it safe (safety layer), then visibility (observability), then quality measurement (testing), then optimization. Resilience comes first because streaming failures are immediately user-visible — there's no grace period.

### Phase 1 — Resilience Foundation (Before Launch)

These five patterns are the difference between a streaming demo and a streaming system you'd run in production. Every one of them addresses a failure mode that's immediately visible to users.

1. **[Circuit Breaker](../../patterns/resilience/circuit-breaker/)** — Set a failure threshold (e.g., 5 failures in 60 seconds) before configuring failover. The circuit breaker is what makes failover fast — without it, each failed request waits for the full timeout before trying the secondary provider.
2. **[Multi-Provider Failover](../../patterns/resilience/multi-provider-failover/)** — Configure a secondary provider (e.g., OpenAI primary → Anthropic secondary) and wire it to the circuit breaker's OPEN state. Test the failover path explicitly before launch — failover that's never been tested tends to have a bug.
3. **[Graceful Degradation](../../patterns/resilience/graceful-degradation/)** — Define what happens when both providers are unavailable: a clean "service unavailable" message, a cached recent response, or a non-streaming fallback. The worst outcome is a stream that stops mid-sentence with no signal to the user.
4. **[Streaming Backpressure](../../patterns/performance/streaming-backpressure/)** — Add flow control before exposing to real users. Set `proxy_buffering off` in NGINX if you're proxying SSE. Check `response.write()` return values in Node.js or `await writer.drain()` in Python asyncio — these are the signals the runtime uses to say "slow down." Without them, a spike of mobile clients on poor connections can OOM the server.
5. **[Latency Budget](../../patterns/performance/latency-budget/)** — Set a TTFT budget (~800ms for conversational, ~1.5s for complex tasks) before the generation call. If context assembly or any enrichment step is consuming that budget, you want to know before users tell you. Start conservative; you can relax it after measuring real TTFT distributions.

**What you have:** The stream survives provider outages, client-side failures don't cascade into server OOM, and TTFT is bounded. Ready for real traffic.

### Phase 2 — Safety Baseline (Before Exposing to Real Users)

6. **[Prompt Injection Defense](../../patterns/safety/prompt-injection-defense/)** — Scan every user message. Streaming chat surfaces are a natural target — users expect their input to directly influence output, which makes injection attempts feel intuitive to attempt. Scan before the message enters context.
7. **[PII Detection](../../patterns/safety/pii-detection/)** — Add PII detection on input and output. Streaming conversations accumulate history; PII entered in turn 1 gets echoed back into every subsequent prompt. Detect it at the boundary and decide whether to redact, flag, or reject.
8. **[Structured Output Validation](../../patterns/safety/structured-output-validation/)** — If the streaming response has a structured format (markdown, JSON, specific schemas), validate at stream completion. Truncated or malformed structured output at stream end is a silent failure that downstream consumers may not handle gracefully.

**What you have:** The streaming surface is safe to open to real users. Injection attempts are caught, PII doesn't leak through conversation history, and structured outputs are validated.

### Phase 3 — Observability Foundation (First Week of Production)

9. **[Structured Tracing](../../patterns/observability/structured-tracing/)** — Instrument the full streaming path: connection established, time to first token, token delivery rate, client disconnect events, and circuit breaker state transitions. The first production issue will require these spans to debug.
10. **[Context Management](../../patterns/data-pipeline/context-management/)** — Add conversation history management once you see real session lengths in production. Check your trace data for sessions approaching the context limit. Set a compression policy (summarize messages older than N turns) before users encounter the ceiling.
11. **[Retry with Budget](../../patterns/resilience/retry-with-budget/)** — Add bounded retry logic on the provider call. Budget the retry tokens (not just attempts) — a 3-attempt retry on a streaming call with generous max_tokens can cost more than the original call.

**What you have:** The full streaming path is observable. Long sessions don't silently degrade. Transient provider errors recover without breaking the stream.

### Phase 4 — Quality Monitoring (Month 1)

12. **[Output Quality Monitoring](../../patterns/observability/output-quality-monitoring/)** — Score completed streaming responses for quality. Streaming-specific degradation shows up as mid-stream topic shifts, incoherence in long responses, or model hallucinations — none of which trigger errors. Monitor for quality signals that latency and error rates miss.
13. **[Prompt Version Registry](../../patterns/observability/prompt-version-registry/)** — Version every system prompt. Streaming system prompts are deceptively influential — a word change can shift tone, verbosity, or response structure. Without versioning, correlating a quality shift to its cause takes much longer.
14. **[Token Budget Middleware](../../patterns/cost-control/token-budget-middleware/)** — Set per-session token budgets once you have real session length data from traces. Start with p99 session length × 1.5 as the ceiling. Streaming sessions tend to be longer and more expensive than one-shot requests.

**What you have:** Quality degradation surfaces in monitoring before users report it. Costs are bounded per session. Every prompt change is tracked.

### Phase 5 — Testing Coverage (Month 1–2)

15. **[Eval Harness](../../patterns/testing/eval-harness/)** — Build a curated conversation set: 30–50 multi-turn dialogues covering your core use cases, with scoring criteria for coherence and task completion. This is the baseline for detecting regressions across prompt and model changes.
16. **[Regression Testing](../../patterns/testing/regression-testing/)** — Run the eval harness on every system prompt change and model version update. Streaming quality is sensitive to context window management configuration and prompt wording in ways that don't surface in unit tests.
17. **[Prompt Rollout Testing](../../patterns/testing/prompt-rollout-testing/)** — Route 5–10% of streaming sessions to a new prompt version before full rollout. A changed system prompt can shift response tone and verbosity across all sessions simultaneously — catching that in a canary is much cheaper than rolling back after full deployment.
18. **[Online Eval Monitoring](../../patterns/observability/online-eval-monitoring/)** — Sample and score live streaming sessions. The eval harness covers scripted dialogues; production sessions are longer, more varied, and more adversarial. The gap between eval scores and production scores is where the real quality risks live.

**What you have:** Behavioral changes are detectable before they reach users. The eval harness provides a quality baseline; production monitoring tracks drift from that baseline.

### Phase 6 — Optimization (Quarter 1+)

19. **[Model Routing](../../patterns/cost-control/model-routing/)** — Once quality monitoring is in place, route simpler conversational turns to a lighter model. Acknowledgments, clarifications, and short factual responses often don't need a frontier model. Measure quality on the routed turns using the eval harness before expanding routing coverage.
20. **[Concurrent Request Management](../../patterns/performance/concurrent-request-management/)** — Add concurrency limits once you're operating at volume. Streaming sessions hold long-lived connections — 200 concurrent sessions can exhaust rate limits faster than 200 independent requests because each session makes multiple calls over its lifetime.

---

## Wiring Guide

These snippets show how the core patterns compose for a streaming use case.

### TypeScript: Streaming Request Handler

```typescript
import { CircuitBreaker } from '../../patterns/resilience/circuit-breaker/src/ts/index.js';
import { FailoverProvider } from '../../patterns/resilience/multi-provider-failover/src/ts/index.js';
import { GracefulDegradation } from '../../patterns/resilience/graceful-degradation/src/ts/index.js';
import { LatencyBudget } from '../../patterns/performance/latency-budget/src/ts/index.js';
import { BackpressureStream } from '../../patterns/performance/streaming-backpressure/src/ts/index.js';
import { ContextManager } from '../../patterns/data-pipeline/context-management/src/ts/index.js';
import { Tracer } from '../../patterns/observability/structured-tracing/src/ts/index.js';
import { InjectionDefense } from '../../patterns/safety/prompt-injection-defense/src/ts/index.js';

// Wire up once at startup
const circuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 30_000,
});

const failover = new FailoverProvider([primaryProvider, secondaryProvider], {
  circuitBreaker,
});

const degradation = new GracefulDegradation({
  fallback: () => "I'm having trouble connecting right now. Please try again in a moment.",
});

const contextManager = new ContextManager({
  maxTokens: 12_000,     // leaves room for system prompt + new message + output
  preserveSystemPrompt: true,
  compressionStrategy: 'summarize-oldest',
});

const tracer = new Tracer({ serviceName: 'streaming-service' });
const injectionDefense = new InjectionDefense({ threshold: 0.8 });

// Per-request handler (SSE response)
async function handleStreamingTurn(
  userMessage: string,
  history: Message[],
  res: ServerResponse,
): Promise<void> {
  const span = tracer.startSpan('stream.turn');
  const budget = new LatencyBudget({ totalMs: 800 }); // 800ms TTFT budget

  try {
    // 1. Scan for injection before message enters context
    const scan = injectionDefense.scan(userMessage);
    if (scan.flagged) {
      res.write(`data: ${JSON.stringify({ error: 'Invalid input' })}\n\n`);
      return;
    }

    // 2. Assemble context — compress history if needed
    const fittedMessages = await contextManager.fitToWindow([
      ...history,
      { role: 'user', content: userMessage },
    ]);
    span.setAttributes({ 'context.tokens': fittedMessages.tokenCount });

    // 3. Initiate provider call (circuit breaker + failover)
    budget.checkpoint('context_ready'); // record time spent on context assembly
    const stream = await degradation.execute(() =>
      failover.streamChat(fittedMessages, SYSTEM_PROMPT),
    );

    // 4. Deliver stream with backpressure
    const bpStream = new BackpressureStream(res, {
      highWaterMark: 16 * 1024, // 16KB buffer ceiling
      onDisconnect: () => {
        stream.cancel(); // stop generating for disconnected clients
        span.setAttributes({ 'stream.client_disconnected': true });
      },
    });

    span.setAttributes({ 'stream.ttft_ms': budget.elapsed() });

    for await (const chunk of stream) {
      const canWrite = bpStream.write(`data: ${JSON.stringify(chunk)}\n\n`);
      if (!canWrite) {
        await bpStream.drain(); // wait for buffer to clear before continuing
      }
    }

    bpStream.end('data: [DONE]\n\n');
    span.setAttributes({ 'stream.completed': true });

  } catch (err) {
    span.setAttributes({ 'stream.error': String(err) });
    if (!res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: 'Stream failed' })}\n\n`);
    }
  } finally {
    span.end();
  }
}
```

### Python: Streaming Request Handler (asyncio)

```python
import asyncio
from patterns.resilience.circuit_breaker.src.py import CircuitBreaker
from patterns.resilience.multi_provider_failover.src.py import FailoverProvider
from patterns.resilience.graceful_degradation.src.py import GracefulDegradation
from patterns.performance.latency_budget.src.py import LatencyBudget
from patterns.performance.streaming_backpressure.src.py import BackpressureWriter
from patterns.data_pipeline.context_management.src.py import ContextManager
from patterns.observability.structured_tracing.src.py import Tracer
from patterns.safety.prompt_injection_defense.src.py import InjectionDefense

# Wire up once at startup
circuit_breaker = CircuitBreaker(
    failure_threshold=5,
    window_seconds=60,
    cooldown_seconds=30,
)

failover = FailoverProvider(
    providers=[primary_provider, secondary_provider],
    circuit_breaker=circuit_breaker,
)

degradation = GracefulDegradation(
    fallback=lambda: "I'm having trouble connecting right now. Please try again."
)

context_manager = ContextManager(
    max_tokens=12_000,
    preserve_system_prompt=True,
    compression_strategy="summarize_oldest",
)

tracer = Tracer(service_name="streaming-service")
injection_defense = InjectionDefense(threshold=0.8)


async def handle_streaming_turn(
    user_message: str,
    history: list[dict],
    writer: asyncio.StreamWriter,
) -> None:
    span = tracer.start_span("stream.turn")
    budget = LatencyBudget(total_ms=800)

    try:
        # 1. Scan for injection before message enters context
        scan = injection_defense.scan(user_message)
        if scan.flagged:
            writer.write(b'data: {"error": "Invalid input"}\n\n')
            await writer.drain()
            return

        # 2. Assemble context — compress history if needed
        fitted_messages = await context_manager.fit_to_window(
            [*history, {"role": "user", "content": user_message}]
        )
        span.set_attributes({"context.tokens": fitted_messages.token_count})

        # 3. Initiate provider call (circuit breaker + failover)
        budget.checkpoint("context_ready")
        stream = await degradation.execute(
            lambda: failover.stream_chat(fitted_messages, SYSTEM_PROMPT)
        )

        # 4. Deliver stream with backpressure — drain() after each write
        bp = BackpressureWriter(writer, high_water_mark=16 * 1024)
        span.set_attributes({"stream.ttft_ms": budget.elapsed()})

        async for chunk in stream:
            data = f"data: {json.dumps(chunk)}\n\n".encode()
            bp.write(data)
            await bp.drain()  # yields to event loop; respects transport buffer

        writer.write(b"data: [DONE]\n\n")
        await writer.drain()
        span.set_attributes({"stream.completed": True})

    except asyncio.CancelledError:
        # Client disconnected — cancel upstream generation
        span.set_attributes({"stream.client_disconnected": True})
        raise
    except Exception as err:
        span.set_attributes({"stream.error": str(err)})
        try:
            writer.write(f'data: {{"error": "Stream failed"}}\n\n'.encode())
            await writer.drain()
        except Exception:
            pass  # connection already gone
    finally:
        span.end()
```

### Composing Circuit Breaker + Failover + Graceful Degradation

These three patterns have a specific wiring order that matters:

```
Circuit Breaker → Multi-Provider Failover → Graceful Degradation
```

- **Circuit Breaker** watches the primary provider and trips when failure rate exceeds the threshold. Once open, requests don't touch the primary at all — they skip directly to failover. This is what makes recovery fast.
- **Multi-Provider Failover** receives requests when the circuit is open or when an individual request fails. It routes to the secondary provider and tracks the secondary's health separately.
- **Graceful Degradation** handles the case where all providers are unavailable. It defines the user-visible response when there's genuinely nothing to stream — a clean error message is always better than a silent dropped connection.

The common mistake is wiring them in parallel (try primary, try secondary, give up) rather than in sequence with state. The sequential + stateful version is what prevents retry storms — the circuit breaker's memory of recent failures is shared across all concurrent requests.

---

## Tradeoffs

### What to skip early-stage

- **Online Eval Monitoring** — valuable, but requires a quality scoring pipeline and enough production traffic to sample meaningfully. Skip until Phase 3–4 patterns are stable.
- **Model Routing** — requires quality monitoring data to calibrate routing thresholds safely. Skip until you have eval harness results on both target models.
- **Concurrent Request Management** — low priority until you're at volume where provider rate limits become a real constraint (typically >1K concurrent sessions).

### What to add at scale

- **Prompt Rollout Testing** becomes more important as user base grows — the blast radius of a bad prompt change scales with traffic.
- **Drift Detection** becomes valuable when the user population is large enough to observe meaningful distribution shifts over weeks.
- **Cost Dashboard** pays for itself once token budget middleware is in place and stakeholders ask about per-feature spend.

### Where patterns create tension

**Latency Budget vs. Context Management**: Context compression adds latency (it often requires a summarization LLM call). I'd want to schedule compression out-of-band (on session end, or when approaching the window limit) rather than on the hot path of each turn. A compress-on-read strategy that blocks turn N adds TTFT variance that the latency budget can't absorb.

**Streaming Backpressure vs. Graceful Degradation**: When a client disconnects mid-stream, the backpressure handler cancels the upstream generation. But if the graceful degradation fallback is triggered (e.g., switching to a secondary provider mid-stream), there's no clean way to resume a dropped stream — the client's SSE connection needs to be re-established. Design the fallback for clean errors rather than mid-stream recovery.

**Circuit Breaker vs. Retry with Budget**: These aren't redundant — they operate at different scopes. Retry with Budget handles transient per-request failures (a single 503, a momentary rate limit). Circuit Breaker handles sustained provider degradation (5 failures in 60 seconds). Add retry first; add the circuit breaker once you've seen a provider outage in production and want faster failover than per-request retry provides.

---

## Related Guides

- [Agent Systems Integration Guide](../agents/) — if the streaming system includes tool calls or multi-step reasoning
- [RAG Systems Integration Guide](../rag/) — if the streaming system retrieves context before generating

# Streaming Backpressure

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

LLM inference engines generate tokens at 100+ tokens/second per stream (typical for [vLLM](https://docs.vllm.ai/en/latest/performance/benchmarks.html) and [TGI](https://huggingface.co/docs/text-generation-inference/en/conceptual/streaming) deployments). Human readers process around [250 words per minute](https://www.sciencedirect.com/science/article/abs/pii/S0749596X19300786) — roughly 4–8 tokens/second depending on tokenizer. Slow network connections and heavily loaded downstream consumers fall even further behind. Without a mechanism to signal "slow down," every layer upstream just keeps pushing — and buffers grow without bound.

The [Node.js documentation](https://nodejs.org/en/learn/modules/backpressuring-in-streams) illustrates this: a streaming pipeline that ignores backpressure signals can consume **roughly an order of magnitude more memory** than one that respects them. The GC profile shifts too — sweeps become longer and less frequent, driving latency spikes instead of the steady, short collections you get with a well-managed buffer.

On the server side, the production failure mode is more specific than "memory grows." When a slow client connects and the server's write attempts start failing silently, an unbounded queue accumulates pending writes. The [http-kit SSE issue #474](https://github.com/http-kit/http-kit/issues/474) describes this exactly: a `LinkedList<ByteBuffer>` with no upper bound — "there's no back-pressure (except for that exerted by an OutOfMemory exception)." That's not a mitigation. That's a crash.

In Python asyncio, the trap is subtler. [`StreamWriter.write()`](https://docs.python.org/3/library/asyncio-stream.html) is not a coroutine — it doesn't block, it doesn't yield, and it doesn't care whether the transport's buffer is full. The correct pattern requires `await writer.drain()` after each write batch to cooperate with the transport's high-water mark. [Armin Ronacher documented this in 2020](https://lucumr.pocoo.org/2020/1/1/async-pressure/): skipping `drain()` "disables a core safety valve and can inflate memory under bursts." Production aiohttp deployments hit this regularly without realizing it — the server appears healthy until a burst of slow clients causes a sudden OOM.

Client disconnects add a second failure mode that's even harder to observe. When a browser tab closes mid-stream, the TCP connection drops — but the LLM inference engine doesn't know. It keeps generating tokens, the KV cache keeps filling, and the GPU keeps burning compute for a response nobody will read. On a busy server, this compounds: each zombie stream holds KV cache memory and consumes inference capacity that could serve live requests.

## What I Would Not Do

The naive approach is treating the stream like a regular iterator: pull tokens from the LLM, write them to the response, repeat. No flow control, no disconnect detection, no bounded queues.

Here's what that looks like in Node.js:

```javascript
for await (const chunk of llmStream) {
  response.write(chunk); // ignores the return value
}
```

[`response.write()`](https://nodejs.org/api/stream.html) returns `false` when the kernel socket buffer is full and the writable stream is requesting a pause. Ignoring that return value is ignoring the backpressure signal entirely — the writable stream's internal queue grows until the process runs out of memory.

The equivalent Python mistake:

```python
async for token in llm.stream():
    writer.write(token.encode())
    # no drain() — socket buffer grows unboundedly under slow clients
```

Both patterns work fine in load tests with fast clients on a local network. They fail in production when a mobile client on a bad connection, a corporate proxy that buffers aggressively, or a downstream service under load can't consume fast enough. The failure is also non-obvious: the server appears to be making progress (tokens are being written to the queue), but memory climbs steadily until OOM.

There's a subtler version of this mistake: teams add a fixed `highWaterMark` to their readable stream and consider the problem solved. That prevents OOM but doesn't handle disconnect detection — zombie streams with zombie KV caches are a GPU cost problem, not just a memory problem.

## When You Need This

- Your streaming responses go to mobile clients, browser clients over variable connections, or any consumer you don't control
- You've seen memory growth, client timeouts, or dropped connections under moderate concurrent load
- You're serving diverse clients — some on fast connections, some on slow ones — from the same endpoint
- Your server hosts 50+ concurrent streaming connections (the problem compounds; 50 slow clients is very different from 50 fast ones)
- You operate through NGINX, a CDN, or any intermediary that might buffer SSE/chunked responses (proxy buffering can cause [20-minute delivery delays](https://dev.to/miketalbot/server-sent-events-are-still-not-production-ready-after-a-decade-a-lesson-for-me-a-warning-for-you-2gie) in production)
- Your GPU utilization is inexplicably high during periods of moderate user-facing activity (zombie streams consuming inference capacity)

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **Streaming → Critical.** This is the defining production concern for real-time LLM delivery. A streaming system without backpressure isn't delivering tokens to users — it's delivering tokens to a queue that may or may not reach users. The test: could this system break in production without it? Yes, trivially: a spike of slow clients causes OOM, taking down every concurrent session including the fast ones.
- **Agents → Optional.** Agent loops typically consume full responses before deciding on the next tool call, so the streaming path is often internal (server-to-server, fast consumer). Worth adding if the agent streams to a human-facing UI, but not required for the agent's correctness.
- **RAG → Optional.** RAG pipelines usually buffer the complete generation before ranking or citation injection. Streaming backpressure only matters in the subset of RAG systems that stream partial results to users before completion.
- **Batch → N/A.** Batch processing by definition collects complete responses before downstream processing. There's no slow-consumer problem in a non-interactive pipeline.

## The Pattern

### Architecture

```
LLM Provider
     │ token stream
     ▼
┌──────────────────────────────────┐
│  Backpressure Controller         │
│                                  │
│  [1] readable: LLMTokenStream    │
│       │                          │
│       │ chunk                    │
│       ▼                          │
│  [2] buffer [■■■■□□□□□□□□]       │
│       │              │           │
│       │ write(chunk) │ full?     │
│       ▼              └──pause──► readable.pause()
│  [3] writable.write()            │        │
│       │                          │        │ drained?
│       │ returns false?           │        ▼
│       └──pause──► readable.pause()   readable.resume()
│       │                          │     ▲
│       │ drain event              │     │
│       └──────────────────────────┘─────┘
│                                  │
│  [4] disconnect detector         │
│       req.on('close') ──────────►│── AbortSignal → cancel inference
└──────────────────────────────────┘
          │ delivered tokens
          ▼
     Client (SSE / WebSocket / HTTP stream)
```

_Note: buffer sizes and token counts above are illustrative. Tune `highWaterMark` based on your observed token rate and client latency distribution._

The controller sits between the LLM token source and the client write target. It:

1. **Pauses the readable** when `writable.write()` returns `false` (buffer full)
2. **Resumes the readable** on the `drain` event (buffer cleared)
3. **Cancels the upstream inference** on client disconnect — signaling the provider to release KV cache, not just closing the socket

### Core Abstraction

```typescript
interface BackpressureController {
  // Pipe LLM token stream to client, respecting flow control
  pipe(
    source: AsyncIterable<string>,
    sink: WritableStream | ServerResponse,
    options?: BackpressureOptions
  ): Promise<StreamResult>;
}

interface BackpressureOptions {
  highWaterMark?: number; // token buffer size before pausing (default: 16)
  onBackpressure?: () => void; // fired when producer is paused
  onDrain?: () => void; // fired when producer resumes
  signal?: AbortSignal; // for upstream cancellation on disconnect
}

interface StreamResult {
  tokensDelivered: number;
  backpressureEvents: number; // how many times producer was paused
  drainEvents: number;
  clientDisconnected: boolean;
}
```

### Configurability

| Parameter                 | Default   | Effect                                     | Dangerous Extreme                                                                    |
| ------------------------- | --------- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `highWaterMark`           | 16 tokens | Buffer capacity before pausing producer    | Too high → more memory per slow client; too low → excessive pause/resume churn       |
| `drainTimeout`            | 5000ms    | Max time to wait for drain before aborting | Too long → zombie streams linger; too short → aggressive disconnects on slow clients |
| `maxConcurrentStreams`    | 50        | Semaphore cap on concurrent active streams | Too high → OOM under slow-client spike; too low → unnecessary 503s                   |
| `disconnectCheckInterval` | 500ms     | How often to probe for client liveness     | Too frequent → syscall overhead; too infrequent → zombie streams persist longer      |

_Defaults are starting points. `highWaterMark` and `maxConcurrentStreams` should be sized from measurement: profile your median client latency and p99 token rate, then calculate how large the buffer needs to be to avoid unnecessary pauses at that rate._

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

| Failure Mode                                                                                                                                                                      | Detection Signal                                                                                                                                                        | Mitigation                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Zombie streams after client disconnect** — inference continues generating tokens for disconnected clients, consuming KV cache and GPU cycles                                    | GPU utilization stays high when active client count drops; KV cache memory doesn't shrink after visible disconnects                                                     | Wire `req.on('close')` / `request.is_disconnected()` to an AbortSignal passed to the LLM client; validate in staging by killing clients mid-stream and measuring GPU recovery time                              |
| **Unbounded buffer growth under slow-client spike** — `highWaterMark` too high, or not set, allows per-stream buffers to grow during a burst of slow clients                      | Server RSS memory climbs steadily; `backpressureEvents` metric flat (producer never paused) while client write latency rises                                            | Set a meaningful `highWaterMark`; add an RSS memory alert; cap concurrent streams with a semaphore and return 503 when capacity is exceeded                                                                     |
| **Drain starvation** — slow client never drains fast enough; stream holds open indefinitely                                                                                       | `drainTimeout` expires frequently; long-tail stream duration distribution; `p99_stream_duration` diverges from `p50_stream_duration`                                    | Enforce `drainTimeout`; close connections that don't drain within the deadline; log client address and user-agent to identify repeat offenders                                                                  |
| **Proxy buffering defeats SSE delivery** — corporate proxies or CDN edges buffer chunked responses, holding events for minutes before forwarding                                  | Clients report delayed token delivery; server metrics show normal latency but client-side TTFT is high for certain network paths                                        | Add `X-Accel-Buffering: no` and `Cache-Control: no-transform` headers; use a heartbeat comment (`:\n\n`) every 10s to force proxy flush; monitor client-reported TTFT separately from server-side write latency |
| **Silent degradation: backpressure events climb over months** — as traffic grows and client device diversity increases, the fraction of slow consumers rises slowly               | `backpressureEvents` count climbs week-over-week without a step change; p99 stream duration trends upward; no alerts fire because absolute values stay below thresholds | Review `backpressureEvents / tokensDelivered` ratio weekly; alert on the ratio, not just the absolute count; re-evaluate `highWaterMark` and `maxConcurrentStreams` at each order-of-magnitude traffic growth   |
| **Token loss on abort** — incomplete stream delivery when `drainTimeout` fires or disconnect is detected; downstream expects full response                                        | `tokensDelivered < expectedTokens`; partial structured output causes parse errors in downstream consumers                                                               | On abort, send a structured termination marker before closing (`data: [DONE]\n\n` in SSE); downstream should handle partial streams explicitly                                                                  |
| **maxConcurrentStreams too low causes unnecessary 503s** — semaphore cap sized conservatively during initial deployment; doesn't scale with hardware or optimization improvements | 503 rate climbs with traffic; GPU utilization stays low (capacity exists but is gated)                                                                                  | Monitor `activeStreams / maxConcurrentStreams` ratio; raise the cap incrementally with traffic; automate cap adjustment based on memory headroom                                                                |

## Observability & Operations

### Key Metrics

| Metric                              | Unit          | What It Indicates                                                             |
| ----------------------------------- | ------------- | ----------------------------------------------------------------------------- |
| `active_streams`                    | count         | Current concurrent streaming connections                                      |
| `backpressure_events_total`         | count/request | How often the producer was paused; rising ratio = slow consumers increasing   |
| `drain_events_total`                | count/request | Correlates with `backpressure_events`; should track closely                   |
| `drain_timeout_total`               | count         | Streams aborted due to drain timeout; rising = aggressive slow-client problem |
| `zombie_stream_cancellations_total` | count         | Upstream cancellations triggered by client disconnect detection               |
| `tokens_delivered_total`            | count         | Total tokens actually written to clients                                      |
| `stream_duration_p50/p99`           | ms            | p99 diverging from p50 signals slow-consumer tail                             |
| `server_rss_mb`                     | MB            | Steady RSS growth under load = unbounded buffer leak                          |
| `gpu_utilization_pct`               | %             | High GPU with low active_streams = zombie streams burning inference           |

### Alerting

| Alert                          | Condition                                             | Severity | Check First                                                                                                       |
| ------------------------------ | ----------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| Backpressure ratio high        | `backpressure_events / tokens_delivered > 0.1` for 5m | Warning  | Client diversity mix, recent traffic growth, `highWaterMark` setting                                              |
| Drain timeout spike            | `drain_timeout_total` rate > 1/min                    | Warning  | Network path to clients, p99 stream duration trend, whether a specific network path or client type is responsible |
| RSS growth                     | RSS grows > 20% over 10m with stable `active_streams` | Critical | `highWaterMark` value, whether a slow-client spike is in progress, buffer size per stream × active count          |
| Zombie streams                 | `gpu_utilization > 60%` with `active_streams < 20`    | Warning  | Disconnect detection health; validate that `req.on('close')` fires in staging by killing clients mid-stream       |
| Concurrent stream cap pressure | `active_streams / maxConcurrentStreams > 0.8` for 5m  | Warning  | Traffic growth rate, current `maxConcurrentStreams`, memory headroom                                              |

_These thresholds are starting points. A high-traffic deployment with primarily fast clients will have naturally high `tokens_delivered` that keeps the ratio low even under occasional backpressure spikes. Calibrate warning levels against a baseline week of normal traffic._

### Runbook

**Backpressure ratio alert fires:**

1. Check `active_streams` — is this a concurrent-stream spike or a slow-consumer problem?
2. Check `drain_timeout_total` — are streams aborting or just taking longer?
3. Segment by user-agent or network path if available — often a single client type or ISP causes disproportionate pressure
4. If ratio is elevated but drain timeouts are low: slow-consumer population is growing, not misbehaving. Consider increasing `highWaterMark` slightly or raising `maxConcurrentStreams` cap if memory headroom allows
5. If drain timeouts are also elevated: lower `drainTimeout` to shed unresponsive clients faster

**RSS growth alert fires:**

1. Check `backpressureEvents` — if rising in step with RSS, buffers are accumulating
2. Verify `highWaterMark` is set (a value of 0 or undefined can disable the limit)
3. Check if a `maxConcurrentStreams` semaphore is in place — without it, slow-client spikes have no ceiling
4. If RSS continues growing after the slow-client spike ends, look for buffer leak: streams that hit error paths without draining their internal queue

**GPU high with low active streams:**

1. Assume zombie streams until proven otherwise
2. Check whether the disconnect detection hook (`req.on('close')`) is wired to upstream cancellation — this is the most common omission
3. Deploy a canary that kills itself mid-stream and verify GPU recovers within 30s
4. Check AbortSignal propagation through the LLM client SDK — some SDKs ignore abort signals on in-flight requests

## Tuning & Evolution

### Tuning Levers

| Parameter              | Safe Range                  | Effect of Increasing                                                    | Effect of Decreasing                                                              |
| ---------------------- | --------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `highWaterMark`        | 8–64 tokens                 | More tolerance for client latency spikes; higher peak memory per stream | Less memory per slow stream; more pause/resume churn on healthy connections       |
| `drainTimeout`         | 2s–10s                      | More tolerance for transient network hiccups                            | Sheds slow clients faster; can drop legitimate mobile clients on poor connections |
| `maxConcurrentStreams` | 20–200 (hardware-dependent) | More capacity; higher memory ceiling under worst-case slow-client spike | More conservative; returns 503 earlier under load                                 |
| Token batch size       | 1–8 tokens                  | Fewer write syscalls, lower overhead; larger buffer chunks              | Lower TTFT; more granular backpressure signal                                     |

### Drift Signals

| Signal                                                                        | Implication                                                           | Action                                                                          |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `backpressure_events / tokens_delivered` ratio trending upward week-over-week | Client population is getting slower relative to your generation speed | Re-evaluate `highWaterMark` and whether client diversity assumptions still hold |
| p99 stream duration growing without p50 growth                                | Slow-consumer tail widening                                           | Consider lower `drainTimeout` to cap worst-case resource hold                   |
| 503 rate from `maxConcurrentStreams` semaphore climbing                       | Traffic is approaching capacity                                       | Evaluate whether hardware headroom allows raising the cap                       |

Review `highWaterMark` and `maxConcurrentStreams` any time traffic grows by an order of magnitude or client mix shifts significantly (e.g., new mobile app launch).

### Silent Degradation

The failure nobody notices until Month 6: the `backpressureEvents / tokensDelivered` ratio climbs by 1–2% per week as traffic grows and the mobile/slow-client fraction of your user base increases. No individual alert fires because absolute counts stay below thresholds. Meanwhile, the p99 stream duration drifts upward, server memory usage trends up, and at some point a routine traffic spike turns into an OOM because the buffer baseline has been quietly growing for months.

The proactive check: track `backpressureEvents / tokensDelivered` as a weekly metric, not just an instantaneous one. A value that was 0.02 six months ago and is now 0.08 is a signal even if 0.08 doesn't trigger any alert. The ratio is more meaningful than the absolute count because it normalizes against traffic growth.

Month 3 check: verify disconnect detection is still firing. It's common for this to regress silently during a framework upgrade or middleware refactor — the hook exists but gets removed or reordered.

Month 6 check: run the zombie-stream canary test (kill a client mid-stream, measure GPU recovery). If recovery takes longer than 30s, the abort propagation chain has degraded.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers.

| Scale        | Additional Cost | ROI vs. No Pattern                             |
| ------------ | --------------- | ---------------------------------------------- |
| 1K req/day   | -$0.33/day      | Saves ~$10/month (5% zombie streams cancelled) |
| 10K req/day  | -$3.28/day      | Saves ~$98/month                               |
| 100K req/day | -$32.81/day     | Saves ~$984/month                              |

## Testing

See [`src/ts/__tests__/index.test.ts`](src/ts/__tests__/index.test.ts) for the full test suite.

- **Unit tests:** Core happy path (all tokens delivered), backpressure event counting (fires on write() returning false), `onBackpressure`/`onDrain` callback verification, `durationMs` reporting, and behavior when `highWaterMark` exceeds token count.
- **Failure mode tests:** One test per failure mode row: client disconnect stops delivery and sets `clientDisconnected` (zombie stream FM); drain timeout sets `drainTimeoutExpired` and aborts early (drain starvation FM); partial delivery is observable via `tokensDelivered` (token loss FM); backpressure ratio metric is exposed for monitoring (silent degradation FM).
- **Integration tests:** Full end-to-end pipe via `streamWithDisconnectDetection`: no-disconnect flow completes all tokens; `req.on('close')` firing cancels upstream; slow consumer with backpressure delivers all tokens while recording pause/resume cycles.
- **What to regression test:** Ensure `clientDisconnected=true` when signal aborts; ensure `drainTimeoutExpired=true` when drain never fires; ensure token count integrity across all paths.

```bash
cd src/ts && npm test
```

## When This Advice Stops Applying

- Non-streaming systems that collect full responses before processing — backpressure is only relevant when there's a sustained data flow with variable consumption rate
- Batch processing pipelines where responses are buffered offline — there's no slow-consumer problem without a real-time consumer
- Server-to-server communication where both sides are on the same fast network and the consumer is always faster than the LLM's generation rate
- Short responses (< 1KB total) where total buffering is trivial — the overhead of pause/resume cycles exceeds the benefit
- Deployments where all clients are on the same controlled network (e.g., internal tooling) and you can guarantee minimum bandwidth — the failure mode requires network variability to manifest
- If your LLM provider enforces rate limits that cap generation speed below your minimum client consumption rate, the producer can never outpace the consumer by enough to matter

<!-- ## Companion Content

- Blog post: [Streaming Backpressure — Deep Dive](https://prompt-deploy.com/streaming-backpressure) (coming soon)
- Related patterns:
  - [Latency Budget](../latency-budget/) (#14, S4) — backpressure affects perceived latency; latency budget determines when to stop buffering and abort
  - [Concurrent Request Management](../concurrent-request-management/) (#23, S7) — concurrent streams multiply the backpressure problem; the `maxConcurrentStreams` semaphore connects these two patterns
  - [Context Management](../../data-pipeline/context-management/) (#22, S6) — context size affects generation length and backpressure severity
  - [Graceful Degradation](../../resilience/graceful-degradation/) (#1, S1) — when backpressure is unmanageable (too many slow clients), degrade gracefully (shorter responses, lower quality, 503 with retry-after) -->

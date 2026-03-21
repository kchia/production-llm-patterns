# Concurrent Request Management

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

LLM API calls are slow — typically 1–10 seconds for a full response — and every provider enforces hard rate limits on both requests-per-minute and tokens-per-minute. Without concurrency management, you're choosing between two bad outcomes: serialize all requests (which turns a 10-step pipeline into a 100-second wall-clock wait) or fire everything in parallel and trigger rate limit errors that cascade.

The cascade is the dangerous part. When 429 errors arrive, every instance of your application retries. If those retries aren't staggered, they re-saturate the rate limiter at exactly the same moment — a thundering herd made worse by the fact that LLM requests are expensive to discard. OpenAI [appears to enforce an undocumented ceiling of roughly 8 concurrent in-flight requests (based on community reports)](https://community.openai.com/t/concurrent-request-restriction/1062443) before throttling activates regardless of published RPM limits. [Anthropic enforces a 60 RPM limit as 1 request per second (as of early 2025)](https://platform.claude.com/docs/en/api/rate-limits) — not 60 requests at second zero of each minute. Fire 60 requests simultaneously and most of them fail immediately.

The real-world numbers are stark: [5 concurrent requests to GPT-4 averaged 2.32 seconds per call; 100 concurrent requests averaged 9.22 seconds](https://community.openai.com/t/concurrency-rate-limiting-a-10-000-issue/907411) — a 4x latency degradation at high concurrency even before hitting hard rate limits. In batch jobs that process thousands of items, unmanaged concurrency turns a predictable throughput problem into an unpredictable retry storm.

## What I Would Not Do

The first instinct is to reach for `asyncio.gather()` (Python) or `Promise.all()` (TypeScript) with no concurrency cap. It's trivially easy to write, and it works beautifully in development when you have one or two test cases. In production, when a batch job launches 500 tasks, it fires all 500 requests simultaneously. The first 8 or so succeed; the rest get 429 errors. Now all 492 failures retry — at similar exponential backoff intervals because they all started at the same moment. The retry wave hits the provider all at once. Failures breed more failures.

The subtler failure is a semaphore without a token budget. `asyncio.Semaphore(25)` limits concurrent in-flight requests, which prevents the initial thundering herd. But it doesn't prevent you from hitting your tokens-per-minute limit. A batch of 25 requests each with a 4,000-token input will blow through a 100,000 TPM limit instantly. Token exhaustion errors behave differently from RPM errors — the reset time is longer and the error messages are less standardized. Treating tokens as if they don't count is how you get opaque rate limit errors that look like provider bugs.

The third failure mode is synchronized retry timing. Even with semaphores and exponential backoff, if you don't add jitter, every retrying instance wakes up at approximately the same time (they all failed at the same moment). The standard fix — `±25% random jitter on the delay` — desynchronizes waves across application instances. Skipping it means your exponential backoff is theater.

## When You Need This

- Your system makes more than one LLM call per user request (RAG pipeline, parallel tool calls, multi-step agent, batch document processing)
- You're seeing 429 errors during peak traffic or batch job execution
- You're running batch jobs that process more than 50–100 items concurrently
- Your retry storms are self-amplifying — error rate increases during the recovery window after a rate limit hit
- Your p99 latency is climbing but p50 is stable (a signal of queuing effects from unmanaged concurrency)
- You're spending significantly on wasted API calls from failed retries

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **Batch → Critical.** Batch jobs launch many tasks in parallel by design. Without concurrency management, a job that processes 1,000 documents will saturate provider rate limits in the first second, and every subsequent retry extends the job's total runtime unpredictably. I wouldn't want to run a batch job without this in place — the failure mode is a hung job that incurs costs without completing.
- **RAG → Required.** RAG pipelines commonly parallelize retrieval and generation — querying multiple indexes, running parallel re-ranking, or processing multi-document questions. I wouldn't feel comfortable getting paged without knowing the parallelism is bounded; an unbounded RAG pipeline looks fine at 10 users and collapses at 100.
- **Agents → Required.** Agents call tools in parallel and may spawn sub-agents. An agent with 8 parallel tool calls hitting an LLM provider will reliably trigger rate limit errors on any non-enterprise tier. I'd want concurrency control in place before shipping an agent to production, even at low traffic.
- **Streaming → Recommended.** Streaming systems typically have one LLM call per user connection, so raw concurrency pressure is lower. The concern is more about fairness — without limits, a burst of users can starve each other's streams. Worth implementing once you're past the "one or two concurrent users" stage, but it's not the first thing I'd reach for in a streaming system.

## The Pattern

### Architecture

```
Requests In
     │
     ▼
┌────────────────────────────────┐
│       ConcurrencyManager       │
│                                │
│  1. ┌──────────────────────┐   │
│     │  Semaphore           │   │  ← bound in-flight count
│     │  (maxConcurrent: N)  │   │
│     └──────────┬───────────┘   │
│                │ slot acquired │
│  2. ┌──────────▼───────────┐   │
│     │  Dual Token Bucket   │   │  ← bound RPM + TPM
│     │  (rpm: R, tpm: T)    │   │
│     └──────────┬───────────┘   │
│                │ capacity ok   │
└────────────────┼───────────────┘
                 │
                 ▼
           LLM Provider
                 │
      ┌──────────┴──────────┐
      │                     │
      ▼                     ▼
   success              429 / 5xx
      │                     │
      ▼              ┌──────▼──────────┐
 release slot        │  Backoff Queue  │
      │              │  exp. backoff   │
      ▼              │  + jitter (±25%)│
   Caller            └──────┬──────────┘
                            │
                ┌───────────┴──────────┐
                │                      │
           retry ≤ M              retry > M
                │                      │
                ▼                      ▼
          back to step 1          surface error

Side channel (all paths):
   ──► Metrics & Logs
       (in_flight, queue_depth, wait_ms,
        retry_count, tokens_per_request)
```

_Numbers shown in config (max_concurrent, rpm, tpm, max_retries) are illustrative starting points — right values depend on your provider tier, request size mix, and SLA._

### Core Abstraction

```typescript
interface ConcurrencyManagerConfig {
  maxConcurrent: number; // max in-flight requests (default: 10)
  maxRequestsPerMinute: number; // RPM limit (set to 80% of provider limit)
  maxTokensPerMinute: number; // TPM limit (set to 80% of provider limit)
  maxRetries: number; // max retry attempts on 429 (default: 4)
  baseRetryDelayMs: number; // base exponential backoff (default: 1000ms)
  maxRetryDelayMs: number; // cap on retry delay (default: 60000ms)
  jitterFactor: number; // random jitter ±factor (default: 0.25)
}

interface ManagedRequest {
  estimatedInputTokens: number;
  execute: () => Promise<LLMResponse>;
}

class ConcurrencyManager {
  async run(request: ManagedRequest): Promise<LLMResponse>;
  getMetrics(): ConcurrencyMetrics;
}
```

**Why dual controls (semaphore + token bucket)?** The semaphore prevents connection saturation and controls in-flight queue depth. The token bucket prevents token exhaustion, which has a different reset profile than RPM limits. You need both because hitting your TPM limit with only 3 concurrent requests is entirely possible when those requests carry large contexts.

**Why 80% of provider limits?** Leaving 20% headroom absorbs burst spikes without triggering rate limits. At exactly 100% utilization, any slight variation in request timing will cause 429 errors. The 80% figure isn't a law — it's a starting point I'd adjust up or down based on observed headroom utilization in your metrics.

### Configurability

| Parameter              | Default | Safe Range | Dangerous Extreme                                      |
| ---------------------- | ------- | ---------- | ------------------------------------------------------ |
| `maxConcurrent`        | 10      | 5–50       | >100: connection saturation, provider throttling       |
| `maxRequestsPerMinute` | 500     | 50–5000    | >provider limit: immediate 429 cascade                 |
| `maxTokensPerMinute`   | 80,000  | 10K–2M     | >provider limit: silent token exhaustion               |
| `maxRetries`           | 4       | 2–6        | >8: retry storms amplify rather than recover           |
| `baseRetryDelayMs`     | 1000    | 500–2000   | <200ms: desynchronization fails; retries bunch up      |
| `maxRetryDelayMs`      | 60,000  | 30K–120K   | <10K: still bunching at sustained rate limit           |
| `jitterFactor`         | 0.25    | 0.1–0.5    | 0: synchronized retry waves; >0.75: excessive variance |

_These defaults are starting points. Your right values depend on your provider tier, average request token size, and traffic profile. Check your provider's rate limit response headers in production — `anthropic-ratelimit-tokens-remaining` and `x-ratelimit-remaining-tokens` give you live capacity data to tune against._

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

| Failure Mode                                                                                                                                                                                                 | Detection Signal                                                                                                                                                 | Mitigation                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Thundering herd after rate limit** — all retrying instances wake up simultaneously, re-saturating the provider                                                                                             | Spike in 429 errors 1–2× the backoff interval after the first wave; error rate doesn't recover between waves                                                     | Add per-retry jitter (±25%); stagger initial request dispatch across instances with a startup delay                                                           |
| **Token exhaustion without RPM violation** — token-heavy requests blow through TPM while staying under RPM                                                                                                   | 429 errors citing token limits, not request counts; TPM metrics spike while concurrent request count looks normal                                                | Track TPM separately from RPM; pre-estimate input tokens before queuing; set TPM limit to 80% of provider cap                                                 |
| **Queue depth grows unbounded** — slow processing causes queue to accumulate faster than it drains                                                                                                           | Memory growth proportional to outstanding work; latency of first item served increases over time                                                                 | Bound queue depth; reject excess items with a `QueueFullError` rather than letting memory grow; alert on queue depth > 2× normal                              |
| **Stale provider limits after tier upgrade** — config reflects old limits, leaving throughput on the table                                                                                                   | Low concurrency metrics despite capacity; queue depth growing unnecessarily; unused headroom in `*-remaining` headers                                            | Read provider response headers live; review config after any tier change or provider update                                                                   |
| **Retry amplification in burst events** — scheduled cron jobs or webhook bursts cause all instances to hit rate limits simultaneously                                                                        | Error rate spikes at regular intervals (every minute, every hour); correlated with cron or event schedules                                                       | Add startup jitter at instance level; use provider's Batch API for large scheduled jobs; spread cron triggers across a time window                            |
| **Silent TPM drift** _(silent degradation)_ — model upgrades or prompt changes quietly increase token usage, pushing against limits without triggering hard errors; throughput degrades gradually over weeks | Slowly increasing `queue_wait_ms` without corresponding error rate increase; TPM metrics creeping toward limit over weeks; subtle latency increase at peak hours | Track average tokens-per-request over time; alert on 20% upward drift over a 7-day window; treat token-per-request as a health metric, not just a cost metric |

## Observability & Operations

### Key Metrics

| Metric                                     | Unit               | What it Signals                                                      |
| ------------------------------------------ | ------------------ | -------------------------------------------------------------------- |
| `concurrency_manager.queue_depth`          | count              | Work backlog; rising = request rate > drain rate                     |
| `concurrency_manager.queue_wait_ms`        | ms (p50/p99)       | Time spent waiting for a slot; rising = saturation                   |
| `concurrency_manager.in_flight`            | count              | Active concurrent requests; should stay < `maxConcurrent`            |
| `concurrency_manager.retry_count`          | count (by attempt) | Retry pressure; high 3rd/4th attempt count = sustained rate limiting |
| `concurrency_manager.rate_limit_errors`    | count/min          | Provider 429 frequency                                               |
| `concurrency_manager.tokens_per_request`   | tokens (p50/p99)   | Token consumption per call; drift here flows into TPM pressure       |
| `concurrency_manager.effective_throughput` | req/min            | Completed requests/min; compare against RPM limit for headroom       |
| `concurrency_manager.wait_ratio`           | ratio              | `queue_wait_ms / total_request_ms`; >0.5 means waiting dominates     |

### Alerting

| Condition                          | Level    | Threshold                       | Response                                                                                          |
| ---------------------------------- | -------- | ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `retry_count` (3rd attempt) rising | Warning  | >5% of requests reach attempt 3 | Check provider status; verify jitter is active; review error classification                       |
| `rate_limit_errors` per minute     | Warning  | >10/min sustained for 5 min     | Rate limits being hit regularly; reduce `maxRequestsPerMinute` by 10%; investigate traffic bursts |
| `rate_limit_errors` per minute     | Critical | >50/min sustained for 2 min     | Rate limit storm underway; open circuit breaker; pause non-critical batch work                    |
| `queue_depth` growth               | Warning  | >2× baseline for 10 min         | Input rate exceeding drain rate; scale horizontally or shed load                                  |
| `queue_depth` growth               | Critical | >5× baseline or OOM risk        | Queue runaway; enable back-pressure; reject new work with 503                                     |
| `tokens_per_request` drift         | Warning  | +20% vs 7-day average           | Prompt changes or model upgrades increased token usage; review recent changes                     |
| `effective_throughput` drop        | Warning  | <70% of expected RPM            | Check provider status; verify limits haven't been downgraded                                      |

_These thresholds are starting points. Your baselines will differ by tier and traffic profile — calibrate warning levels against your normal operating range in the first two weeks._

### Runbook

**Alert: rate_limit_errors rising (Warning)**

1. Check provider status page for incidents
2. Look at `retry_count` distribution — is it 3rd+ attempts climbing? That suggests sustained pressure, not a burst
3. Check `tokens_per_request` — if token usage rose recently, you may be hitting TPM before RPM
4. Verify `jitterFactor` > 0 in config — synchronized retries look like sustained rate limit pressure
5. If no incident: reduce `maxRequestsPerMinute` by 10–15% and monitor

**Alert: rate_limit_errors rising (Critical)**

1. Immediately pause non-critical batch jobs
2. Enable circuit breaker mode — stop issuing new requests for 30–60 seconds
3. Check all application instances — are they all retrying simultaneously? (thundering herd)
4. After pause: resume at 50% of normal concurrency; scale back up over 5–10 minutes
5. Post-incident: add per-instance startup jitter if not present

**Alert: queue_depth runaway (Critical)**

1. Check `in_flight` — is processing blocked? Or is input rate genuinely exceeding capacity?
2. Enable load shedding — reject new items with 503 until queue_depth returns to baseline
3. Check for blocked coroutines or deadlocked semaphores (in_flight = 0 with queue_depth > 0)
4. If stuck: restart with a clean queue; failed items should have been durably queued upstream

## Tuning & Evolution

### Tuning Levers

| Lever                  | Effect                                                                                   | When to Adjust                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `maxConcurrent`        | Controls in-flight request count; lower = more latency per item, lower provider pressure | Increase if `wait_ratio` is high but `in_flight` is low; decrease if seeing connection errors   |
| `maxRequestsPerMinute` | Primary RPM throttle; set to 80% of provider limit                                       | Raise if you have headroom in `ratelimit-remaining` headers; lower if seeing regular 429s       |
| `maxTokensPerMinute`   | TPM throttle; set independently from RPM                                                 | Lower if token exhaustion errors appear; estimate from `tokens_per_request` × target throughput |
| `maxRetries`           | Retry attempt cap; higher = more resilience, more retry amplification risk               | Keep at 3–5; increase only for critical paths with acceptable latency budget for retries        |
| `baseRetryDelayMs`     | Starting backoff; too low = synchronized retries; too high = unnecessary wait time       | Increase if retry waves are still synchronizing despite jitter                                  |
| `jitterFactor`         | Desynchronization factor; 0.25 = ±25% randomness on delay                                | Increase to 0.5 if seeing correlated retry spikes across instances                              |

### Drift Signals

- **Token usage per request rising** — a common slow drift from prompt iteration, model upgrades, or expanding context windows. I'd want a weekly review of `tokens_per_request` p50 and p99. A 20% rise over a month means your TPM headroom has quietly shrunk.
- **Provider tier changes** — upgrading tiers changes both RPM and TPM limits; config doesn't update automatically. Review concurrency config after any tier change.
- **Traffic pattern shifts** — a new batch job, a new integration, or a new user segment can change the ratio of large-to-small requests. Review `wait_ratio` quarterly.
- **Review cadence:** monthly config review against current `ratelimit-remaining` header averages; immediate review after any provider tier change or major prompt update.

### Silent Degradation

At Month 3: prompt engineering iterations have gradually increased average input token count. TPM limit is being hit more frequently, but individual requests still succeed (they just wait in queue longer). `queue_wait_ms` p99 has risen 40% from baseline. No alerts are firing because error rate is unchanged.

At Month 6: a model upgrade doubled output token counts for complex queries. The TPM limit is now regularly saturated. Batch jobs that used to complete in 2 hours now take 4. The system is "working" — no errors, no alerts — but throughput has halved.

The catch: track `tokens_per_request` as a health metric, not just a cost metric. An upward drift here is an early warning signal before latency or errors appear.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers.

| Scale        | Additional Cost | ROI vs. No Pattern                                             |
| ------------ | --------------- | -------------------------------------------------------------- |
| 1K req/day   | $0 overhead     | -$3.58/day saved (GPT-4o; eliminates 1.7× retry amplification) |
| 10K req/day  | $0 overhead     | -$35.75/day saved (GPT-4o)                                     |
| 100K req/day | $0 overhead     | -$357.50/day saved (GPT-4o)                                    |

## Testing

See [`src/ts/__tests__/index.test.ts`](src/ts/__tests__/index.test.ts) (TypeScript) and [`src/py/tests/test_index.py`](src/py/tests/test_index.py) (Python).

```bash
# TypeScript
cd src/ts && npm install && npm test

# Python
cd src/py && pip install -r requirements.txt && pytest
```

- **Unit tests:** Default config values, single request completion, metrics accuracy, `runAll`/`runAllSettled` ordering, custom requestId propagation
- **Failure mode tests (one per FM table row):**
  - FM1: Jitter produces retry delay variance (no synchronized retry waves)
  - FM2: TokenBudgetExceededError thrown for single request exceeding TPM limit
  - FM3: `maxConcurrent` enforced — observed in-flight count never exceeds limit
  - FM4: New manager with updated limits allows higher throughput
  - FM5: Non-retryable 4xx errors fail immediately without retries (callCount=1)
  - FM6: `tokensUsedThisWindow` in metrics exposes token drift for monitoring
- **Integration tests:** Batch with mixed outcomes, concurrent callers sharing a manager, transient 5xx recovery, metrics consistency across success/failure paths
- **What to regression test:** Semaphore release always happens (even on error), jitter factor produces real variance, token window prunes correctly after 60 seconds, retry amplification stays bounded at `maxRetries`

## When This Advice Stops Applying

- Single-request systems with no parallelism — if each user interaction is one LLM call, sequentially, there's nothing to manage. Add this when you add the second parallel call.
- Very low volume where rate limits are never approached — under ~10 requests/minute with generous provider limits, concurrency management is overhead without benefit.
- Self-hosted or dedicated GPU inference — if you control the inference stack (vLLM, TGI, NIM on your own hardware), provider rate limits don't apply. You may still want backpressure and queue depth controls, but the RPM/TPM bucket mechanics are irrelevant.
- Unlimited-tier contracts — some enterprise contracts eliminate rate limits entirely. If you're in this situation, a simple semaphore for connection management may be sufficient without the full token bucket overhead.
- Batch API use cases — Anthropic's Message Batches API and OpenAI's Batch API process jobs asynchronously with 24-hour SLAs and 50% cost discounts. If your latency tolerance is hours, not seconds, using the Batch API sidesteps real-time rate limit management entirely.

<!-- ## Companion Content

- Blog post: [Concurrent Request Management — Deep Dive](https://prompt-deploy.com/concurrent-request-management) (coming soon)
- Related patterns:
  - [Latency Budget](../latency-budget/) (#14, S4) — concurrency is a tool for meeting latency budgets; managed concurrency prevents budget-blowing retries
  - [Request Batching](../request-batching/) (#26, S7) — batching groups requests; concurrency management controls how many batches run simultaneously
  - [Streaming Backpressure](../streaming-backpressure/) (#27, S7) — backpressure at the response layer complements concurrency control at the request layer
  - [Retry with Budget](../../resilience/retry-with-budget/) (#5, S2) — retries interact with concurrency limits; more retries means more concurrent requests
  - [Token Budget Middleware](../../cost-control/token-budget-middleware/) (#3, S1) — concurrency affects total spend rate -->

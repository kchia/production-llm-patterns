# Circuit Breaker

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

On [December 11, 2024](https://status.openai.com/incidents/01JMYB483C404VMPCW726E8MET), OpenAI deployed a new telemetry service across their Kubernetes fleet. Within 30 minutes, every large cluster's control plane was overwhelmed — and all services went down for over 4 hours. Engineers identified the root cause within 5 minutes, but couldn't fix it because the tools they needed to roll back the change depended on the systems that were failing. DNS caches masked the problem just long enough for the bad deployment to propagate everywhere before anyone saw the damage.

Two weeks later, on [December 26](https://status.openai.com/incidents/01JMYB44RFAHDFT1HWDPD0M2N5), a cloud provider power failure triggered a second outage. This time, ChatGPT, Sora, and most APIs saw >90% error rates. The compounding factor: users retrying failed requests created a retry storm that crash-looped web service pods, turning a provider issue into a self-inflicted cascading failure that prevented recovery even after the underlying database came back.

That's the pattern without a circuit breaker. A provider degrades. Your system keeps sending requests. Each failing request adds latency, burns tokens, and eats retry budget. At scale, the retry traffic itself becomes the problem — a 2-second provider hiccup amplifies into 30+ seconds of cascading failures because every instance is independently hammering the same sick endpoint. The provider can't recover because your traffic won't let it.

[Netflix](https://github.com/Netflix/Hystrix/wiki) learned this at scale years ago running [10+ billion](https://github.com/Netflix/Hystrix/wiki/How-it-Works) [Hystrix](https://github.com/Netflix/Hystrix) command executions per day: "the most typical type of failure in a distributed system is for a single dependency to fail or become latent while all others remain healthy." The circuit breaker exists to contain that blast radius — to let one provider fail without taking everything else down with it.

## What I Would Not Do

It's tempting to rely on per-request retry logic with exponential backoff. It's the right instinct but incomplete. Retries handle transient errors — a single 503, a momentary rate limit. They don't know when a failure is persistent. If the provider is down, retries just keep hammering the same endpoint. At 10K req/day, each instance independently retrying 3 times turns a degraded provider into 30K+ failed requests, each waiting for a timeout before falling back. That's not resilience; that's a coordinated denial-of-service against a provider that's already struggling.

The second tempting thing to try is timeout-based detection: "if the request takes longer than 5 seconds, something's wrong." That catches slow failures but misses fast ones — a provider returning 500s in 50ms doesn't trigger timeout logic. And a fixed timeout doesn't distinguish between "this one request was slow" and "every request to this provider is failing." There's no state, no memory of recent failures, no threshold to trip.

What's missing is a mechanism that **watches the pattern of failures over a sliding window and makes a system-level decision:** this provider is sick, stop sending traffic to it. That's what a circuit breaker adds — not per-request protection (retries do that), but system-level protection that kicks in when failures cross a threshold and stops the bleeding before it cascades.

## When You Need This

- Your system sends >1K requests/day to an LLM provider — enough volume that continued requests to a failing endpoint cause meaningful queuing and cost
- You've observed (or can model) cascading failures where one provider's degradation rippled through your entire system
- Your p99 latency SLA is tight enough that waiting for per-request retry timeouts isn't acceptable — fast failure detection (seconds, not minutes) is needed to trigger failover or degradation
- You're spending >$50/day on API calls, where wasted tokens during an outage have real dollar impact
- You operate multiple instances or services that share a provider — without coordination, each independently retries, multiplying the load on a sick endpoint

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **Streaming → Critical.** Users are watching tokens arrive in real time. A stalled stream is immediately visible — there's no "loading spinner" grace period. I wouldn't want to get paged for a streaming outage and discover the system spent 30 seconds hammering a dead endpoint before failing over. The circuit breaker is what makes failover fast enough to matter for streaming.
- **Agents → Required.** Agent loops make multiple LLM calls per task, often chained. A degraded provider doesn't just slow one request — it stalls entire workflows and burns through token budgets on calls that won't succeed. I'd want circuit breaking in place before running agents in production; the cost of not having it compounds with every loop iteration.
- **RAG → Recommended.** RAG pipelines typically make one LLM call per query after retrieval. The blast radius per failed request is smaller than agents or streaming, but at scale, retry storms during a provider outage still queue up and degrade the whole system. I'd notice the gap within the first month of operating at volume.
- **Batch → Optional.** Batch systems process offline, without users waiting. They can pause, retry later, or checkpoint progress natively. A circuit breaker adds value if the batch job calls a provider frequently enough to create retry storms, but most batch architectures already have built-in backoff and resumption that serve a similar purpose.

## The Pattern

### Architecture

**Request flow** — what happens to each incoming request depending on circuit state:

```
                      Request
                         │
                         ▼
               ┌───────────────────┐
               │  Circuit Breaker  │
               │  check state      │
               └──┬──────┬──────┬──┘
                  │      │      │
             CLOSED  HALF_OPEN  OPEN
                  │      │      │
                  ▼      │      ▼
            ┌──────────┐ │  ┌──────────────────┐
            │ Provider │ │  │ Fast-fail         │
            │ call     │ │  │ CircuitOpenError  │
            └──┬────┬──┘ │  │ (no provider call)│
               │    │    │  └──────────────────┘
          success  error │
               │    │    ▼
               │    │  ┌──────────────────┐
               │    │  │ Probe request    │
               │    │  │ (limited to N)   │
               │    │  └──┬────────────┬──┘
               │    │     │            │
               │    │  success       failure
               │    │     │            │
               │    │     ▼            ▼
               │    │  count++      → OPEN
               │    │  (if N met     (reopen)
               │    │   → CLOSED)
               │    │
               ▼    ▼
         ┌──────────────────────────────┐
         │ Sliding Window               │
         │ record success or failure    │
         │ evaluate failure rate        │
         │ if rate > threshold → OPEN   │
         └──────────────────────────────┘
```

**State machine** — three states, four transitions:

```
         ┌──────────────────────────────────────────────┐
         │                                              │
         │  failure rate > threshold                    │
         │  (within minimum request volume)             │
         │                                              │
         ▼                                              │
    ┌─────────┐   reset timeout   ┌───────────┐   all probes   ┌────────┐
    │  OPEN   │ ────────────────→ │ HALF_OPEN │ ─────────────→ │ CLOSED │
    └─────────┘    expires        └───────────┘   succeed       └────────┘
         ▲                              │
         │        any probe fails       │
         └──────────────────────────────┘
```

Note: Threshold values (failure rate %, reset timeout) shown in the configurability table below are starting points — actual values depend on your SLA, provider characteristics, and traffic profile.

**Core abstraction:** `CircuitBreaker` wraps any `(request) => Promise<response>` callable. It tracks failures in a sliding window and transitions between three states:

- **CLOSED** — requests flow through normally. Failures and successes are recorded. When the failure rate exceeds the threshold within the minimum request volume, the circuit opens.
- **OPEN** — all requests fail immediately with a `CircuitOpenError`, without calling the provider. After the reset timeout expires, the circuit transitions to half-open.
- **HALF_OPEN** — a limited number of probe requests are allowed through. If they succeed, the circuit closes. If any fail, it reopens. This prevents a "thundering herd" of requests hitting a provider that may still be recovering.

**Key design tradeoffs:**

| Tradeoff                               | Choice                                   | Rationale                                                                                                                                                                                                                                                                     |
| -------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sliding window vs. tumbling window     | Sliding window (count + time-based)      | Smoother transitions, avoids edge effects where failure rate resets to zero at window boundaries. Tradeoff is slightly more memory and computation per request. I'd choose the sliding window — the smoother behavior is worth the cost.                                      |
| Per-provider vs. per-endpoint breakers | Per-provider instances                   | Prevents a single degraded endpoint from tripping the circuit for a healthy one on the same provider. More state to manage, but the isolation is essential — Netflix learned this [operating 100+ Hystrix command types](https://github.com/Netflix/Hystrix/wiki/Operations). |
| Fixed vs. configurable probe count     | Configurable `halfOpenMaxAttempts`       | Rather than a single probe, configurable probe count prevents premature closure when a provider is flapping — returning intermittent successes during an ongoing degradation.                                                                                                 |
| Polling vs. event-driven notifications | Event-driven callbacks (`onStateChange`) | Callbacks enable immediate failover routing and metric emission without additional monitoring overhead. No polling loop needed.                                                                                                                                               |

**Configurability:**

| Parameter             | Default                  | Description                                                       |
| --------------------- | ------------------------ | ----------------------------------------------------------------- |
| `failureThreshold`    | 50%                      | Failure rate percentage that trips the circuit                    |
| `resetTimeoutMs`      | 30000                    | How long the circuit stays open before probing                    |
| `halfOpenMaxAttempts` | 3                        | Number of successful probes required to close                     |
| `minimumRequests`     | 10                       | Minimum requests in window before evaluating failure rate         |
| `windowSize`          | 100                      | Sliding window size (number of requests tracked)                  |
| `windowDurationMs`    | 60000                    | Time-based window duration (requests older than this are evicted) |
| `isFailure`           | Status >= 500 or timeout | Custom function to classify which responses count as failures     |

These defaults are starting points — a tight SLA might need a lower `resetTimeoutMs` (10s), while a provider with known flappiness might need a higher `minimumRequests` (20+) to avoid false opens.

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Key design decisions:

- Class-based with generic function signature: `execute(request, fn)` accepts any callable, decoupled from specific providers
- `SlidingWindow` as a separate class for testability and reuse
- Custom `CircuitOpenError` preserves circuit state context (time until reset, failure rate at open)
- `destroy()` method for timer cleanup to prevent process-hanging
- Event callbacks for observability: `onStateChange`, `onSuccess`, `onFailure`

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

### Key design decisions:

- Dataclass-based configuration (`CircuitBreakerConfig`) with `**kwargs` convenience constructor — idiomatic Python, avoids verbose builder patterns
- `asyncio.TimerHandle` for reset timeout scheduling via `loop.call_later`, with a graceful fallback to polling in `execute`/`state` when no event loop is running
- `@property` accessor for `state` that checks reset timeout expiry on read — Pythonic alternative to the TS getter method
- Types in a separate `cb_types.py` module (avoids shadowing stdlib `types`) using `@dataclass` throughout — compact memory footprint (~122 bytes/entry vs ~2.8 KB in TS)
- `BaseException` in `is_failure` signature to catch broader exception hierarchy, matching Python's exception model

## Failure Modes

How this pattern itself can fail. Every solution creates new failure modes.

| Failure Mode                                       | Detection Signal                                                                                                                                                                                                                                                           | Mitigation                                                                                                                                                                                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **False open — circuit trips on transient errors** | Circuit opens but provider health endpoint returns OK; open rate spikes with no corresponding provider degradation on status page                                                                                                                                          | Increase `minimumRequests` threshold to require more evidence before tripping. Add error classification (`isFailure`) to distinguish transient errors (single 429) from systemic failures (repeated 503s).                                                       |
| **Thundering herd on close**                       | Latency spike and error rate spike immediately after circuit transitions from HALF_OPEN to CLOSED; provider metrics show request surge                                                                                                                                     | Use gradual ramp-up after close: route a percentage of traffic (10%, 25%, 50%, 100%) over 30-60 seconds instead of sending full load immediately.                                                                                                                |
| **Stuck open — circuit never closes**              | Circuit remains in OPEN state for >5x the `resetTimeoutMs`; half-open probes never succeed despite provider being healthy                                                                                                                                                  | Add a maximum open duration that forces a probe attempt. Monitor time-in-state — alert if OPEN duration exceeds a multiple of resetTimeout. Check if probe requests use a different path or auth than normal requests.                                           |
| **Stuck closed — threshold never triggers**        | Error rate is consistently high (40-49%) but circuit never opens because it's just below threshold; p99 latency climbs steadily                                                                                                                                            | Monitor the gap between current failure rate and threshold. If failure rate stays within 5% of threshold for >5 minutes, emit a warning. Consider adaptive thresholds that tighten under sustained degradation.                                                  |
| **State synchronization in distributed systems**   | Different instances have different circuit states — some OPEN, some CLOSED; inconsistent user experience, partial retry storms                                                                                                                                             | Use shared state store (Redis) for circuit state if consistency matters. Accept eventual consistency if instances converge within ~30s. Monitor per-instance circuit state divergence.                                                                           |
| **Silent threshold drift (slow degradation)**      | Over months, traffic patterns change but thresholds don't. A `minimumRequests` of 10 made sense at 1K req/day but at 100K req/day, the circuit trips on noise. No alert fires because the circuit is "working" — it's just opening too aggressively or too conservatively. | Schedule quarterly threshold reviews. Track circuit open frequency over time — a trend of increasing opens without corresponding provider incidents signals threshold drift. Compare `minimumRequests` against current traffic volume and adjust proportionally. |

## Observability & Operations

**Key metrics:**

| Metric                             | Description                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `circuit_breaker.state`            | Current state per provider (CLOSED/OPEN/HALF_OPEN), emitted on every transition via `onStateChange` |
| `circuit_breaker.failure_rate`     | Current sliding window failure rate (%), sampled every 10s or on each request                       |
| `circuit_breaker.open_duration_ms` | How long the circuit has been OPEN, resets on transition to HALF_OPEN                               |
| `circuit_breaker.rejection_count`  | Counter of requests fast-failed due to OPEN circuit, per provider                                   |
| `circuit_breaker.probe_result`     | Success/failure of HALF_OPEN probe attempts                                                         |
| `circuit_breaker.window_size`      | Current number of entries in the sliding window (should stay near `windowSize` config under load)   |

**Alerting:**

| Severity | Alert                               | Description                                                                                                                                                                                         |
| -------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Warning  | Circuit opened                      | Any transition to OPEN state. This isn't necessarily an emergency — it means the circuit is doing its job. But it signals provider degradation that needs attention.                                |
| Warning  | Failure rate near threshold         | Failure rate stays within 5% of `failureThreshold` for >5 minutes without tripping. The circuit is close to opening, and the provider is degraded but not quite failing enough to trip.             |
| Critical | Circuit stuck open                  | Circuit remains OPEN for >5x `resetTimeoutMs` (e.g., >2.5 minutes with 30s default). The provider may be down, or half-open probes may be failing for a different reason than the original failure. |
| Critical | Rapid open/close cycling (flapping) | Circuit transitions OPEN→HALF_OPEN→CLOSED→OPEN more than 3 times in 10 minutes. The provider is unstable, and the circuit breaker is oscillating.                                                   |
| Warning  | Rejection rate too high             | >50% of requests to a provider are being rejected by the circuit breaker over a 5-minute window. Sustained rejection means the provider has been unhealthy for a while.                             |
| Warning  | Rejection rate suspiciously low     | If the circuit has never opened across all providers in >30 days under normal traffic, the `minimumRequests` threshold may be set too high relative to traffic volume.                              |

These thresholds are starting points — a system with aggressive SLAs might alert on circuit open immediately at critical level, while a batch system might only care about sustained opens.

- **Runbook:**
  - **Circuit opened:**
    1. Check the provider's status page — is there a known incident?
    2. Check `circuit_breaker.failure_rate` — what was the rate at open? If it's near the threshold (e.g., 51%), this might be a false open. If it's 90%+, the provider is genuinely down.
    3. Check error types — are failures 503s (provider down), 429s (rate limited), or timeouts (network)?
    4. If provider is healthy: check `isFailure` classification — are transient errors being miscounted as failures?
    5. If provider is down: verify failover routing is active (if Multi-Provider Failover is deployed).
  - **Circuit stuck open:**
    1. Check if half-open probes are being sent — look for `circuit_breaker.probe_result` events.
    2. If probes aren't being sent: check if the reset timer is running. A `destroy()` call or process restart might have cleared it.
    3. If probes are failing: check if probe requests take the same path as normal requests. Auth token expiration, different endpoint routing, or firewall rules can cause probes to fail while the provider is healthy.
    4. Force a manual probe by temporarily lowering `resetTimeoutMs`.
  - **Flapping circuit:**
    1. Increase `halfOpenMaxAttempts` to require more successful probes before closing (e.g., 5 instead of 3).
    2. Increase `resetTimeoutMs` to give the provider more recovery time between probes.
    3. Check if the provider is partially degraded — returning successes intermittently but not fully recovered.

## Tuning & Evolution

**Tuning levers:**

| Parameter             | Default                  | Safe Range                                                            | Dangerous Extreme                                                                                                                                                |
| --------------------- | ------------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failureThreshold`    | 50%                      | 30-70%                                                                | Below 30% risks false opens on normal error noise. Above 70% means the provider is severely degraded before the circuit reacts.                                  |
| `resetTimeoutMs`      | 30s                      | 5s-120s                                                               | Below 5s doesn't give the provider meaningful recovery time. Above 120s means long outages for callers. Lower (5-10s) for streaming; higher (60-120s) for batch. |
| `minimumRequests`     | 10                       | Scale with traffic volume (10 at 100 req/day, 50-100 at 100K req/day) | <3 — circuit trips on a few unlucky requests                                                                                                                     |
| `windowSize`          | 100                      | 50-1000                                                               | Below 50 is too noisy. Above 1000 consumes memory (~2.9 KB per entry) and slows evaluation.                                                                      |
| `halfOpenMaxAttempts` | 3                        | 1-10                                                                  | 1 probe risks premature closure. >10 probes delay recovery unnecessarily.                                                                                        |
| `isFailure` function  | Status >= 500 or timeout | Start permissive (only 5xx), tighten if needed                        | Adding 429s as failures is common but consider whether rate limits are transient (back off) or systemic (circuit-break).                                         |

- **Drift signals:**
  - Circuit open frequency trending upward without corresponding provider incidents — thresholds may need adjustment
  - `minimumRequests` hasn't changed since initial deployment but traffic has grown 10x — the circuit either trips too easily or not at all
  - Failure rate consistently hovers just below threshold — the provider is degraded but not quite enough to trigger protection
  - Half-open probe success rate declining over time — provider recovery characteristics may have changed

- **Silent degradation:**
  - **Month 3:** Traffic has doubled since deployment. The `minimumRequests` of 10 was appropriate at 1K req/day but now at 2K req/day, the circuit occasionally trips on brief 503 bursts that resolve in seconds. No alert fires because the circuit is "working correctly" — it's just overreacting to transient noise. Review: compare open frequency against provider incident log.
  - **Month 6:** A provider has changed its rate limiting behavior — now returning 429s more aggressively with shorter Retry-After headers. The `isFailure` function doesn't count 429s, so the circuit never opens during rate-limit storms. Meanwhile, request latency has crept up because every 429 triggers a retry. Review: examine error type distribution in the sliding window. If 429s dominate during degradation, add them to `isFailure` or implement rate-limit-aware circuit breaking.
  - **Proactive check:** Quarterly, compare circuit breaker configuration against current traffic volume and provider behavior. Key questions: Has traffic volume changed by >2x? Has the provider changed error patterns? Has the retry budget upstream changed? Has the SLA tightened?

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers at all three model price points.

| Scale        | Additional Cost  | ROI vs. No Pattern                                                        |
| ------------ | ---------------- | ------------------------------------------------------------------------- |
| 1K req/day   | -$0.04/day saved | Marginal — insurance against tail events worth more than daily savings    |
| 10K req/day  | -$0.36/day saved | ~$11/mo steady-state savings; a single 2-hour outage saves ~$5.20         |
| 100K req/day | -$3.68/day saved | ~$110/mo steady-state; a single 2-hour outage avoids ~$31 in wasted spend |

## Testing

How to verify this pattern works correctly. See test files in `src/ts/__tests__/index.test.ts`.

**Run:** `cd src/ts && npm install && npm test`

- **Unit tests (10):** SlidingWindow stats computation, eviction by age and size, reset. CircuitBreaker default/custom config, 4xx non-failure classification, custom `isFailure` function, onSuccess/onFailure callbacks.
- **Failure mode tests (7):** FM1 (false open — genuine systemic failure trips circuit; minimumRequests prevents false open on small samples), FM2 (thundering herd — 100 requests fail fast during OPEN without hitting provider), FM3 (stuck open — transitions to HALF_OPEN after reset timeout; half-open failure reopens), FM4 (stuck closed — failure rate below threshold stays closed), FM5 (state divergence — independent instances), FM6 (silent threshold drift — stats are observable).
- **Integration tests (4):** Full lifecycle CLOSED→OPEN→HALF_OPEN→CLOSED with transition verification. Retry storm protection (100 concurrent requests fail fast). Concurrent request handling during state transitions. End-to-end with realistic provider degradation and recovery.

## When This Advice Stops Applying

- **Low-traffic systems (<100 req/day):** At this volume, retry storms can't generate enough load to harm a provider or meaningfully cascade through your system. The overhead of tracking failure rates, managing state transitions, and tuning thresholds isn't worth it — a simple retry with timeout is sufficient.
- **Single-provider, single-instance deployments:** If there's only one process making requests, there's no amplification effect. One instance retrying 3 times is 3 extra requests, not thousands. Circuit breaking adds complexity without proportional benefit.
- **Batch systems with built-in checkpointing:** If the batch job already pauses on failure, writes checkpoints, and resumes later, it's doing the circuit breaker's job at the application level. Adding a separate circuit breaker just introduces conflicting state machines.
- **Self-hosted models with dedicated health checks:** When the provider is your own infrastructure (vLLM, TGI, Ollama), you likely already have health endpoints, load balancer checks, and Kubernetes readiness probes that accomplish the same thing with more precision. A circuit breaker on top adds a redundant detection layer.
- **Providers mature into exposing real-time health signals:** If LLM providers start publishing machine-readable health endpoints or degradation signals (beyond status pages), client-side circuit breaking becomes less necessary — the provider is telling you to back off directly. Some of this is emerging with rate limit headers (429 + Retry-After), but we're not there yet for broader health signals.
- **When multi-provider failover handles the problem entirely:** If you're running Multi-Provider Failover with health-aware routing (not just round-robin), the router itself becomes the circuit breaker. At that point, a per-provider circuit breaker is redundant — the routing layer already removes unhealthy providers from the pool. [LiteLLM's cooldown mechanism](https://docs.litellm.ai/docs/routing) works this way, combining routing with cooldown-based circuit breaking in a single layer.

<!-- ## Companion Content

- Blog post: [Circuit Breaker — Deep Dive](https://prompt-deploy.com/circuit-breaker) (coming soon)
- Related patterns:
  - [Retry with Budget](../retry-with-budget/) — the circuit breaker sits above retries, stopping them when failure is systemic. Retries handle transient errors; the circuit breaker handles persistent ones.
  - [Multi-Provider Failover](../multi-provider-failover/) — when the circuit opens, failover routes to an alternative provider. The circuit breaker detects the problem; failover routes around it.
  - [Graceful Degradation](../graceful-degradation/) — when the circuit opens and no failover exists, degrade gracefully. Return cached responses, simplified outputs, or honest error messages.
  - [Structured Tracing](../../observability/structured-tracing/) — traces circuit state transitions for debugging. Without tracing, diagnosing why a circuit opened (and whether it should have) is guesswork. -->

# Multi-Provider Failover

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

Single-provider dependency means one outage takes your entire LLM capability offline. And provider outages aren't hypothetical — they're routine. [OpenAI's December 2024 incident](https://status.openai.com/incidents/01JMYB483C404VMPCW726E8MET) took down all services (API, ChatGPT, Sora) for over four hours because a telemetry deployment overwhelmed their Kubernetes control planes. DNS caching masked the issue initially, so the blast radius kept expanding while engineers were locked out of their own clusters. An [empirical study of LLM service reliability](https://atlarge-research.com/pdfs/2025-icpe-llm-service-analysis.pdf) found that OpenAI's API has a median time-to-recovery of 1.23 hours, while Anthropic's is 0.77 hours — and both show weekly periodic failure patterns.

The real cost is the amplification. At 10K requests/day, a 2-hour provider outage means ~833 failed requests. If those requests trigger retries without failover, you're now hammering a struggling API with 2-3x the normal load while every other customer does the same thing. Salesforce's [Agentforce](https://www.salesforce.com/blog/failover-design/?bc=OTH) team observed this pattern firsthand — based on public status page data, LLM outages tend to happen at least once or twice a quarter, and without failover, their agents appeared broken or unresponsive to customers.

Without this pattern, the blast radius of a provider outage equals the blast radius of your LLM feature. That's a direct mapping most teams don't realize they've accepted until the first incident report.

## What I Would Not Do

It's tempting to wrap LLM calls in a try/catch with a second provider as the fallback. Something like: if OpenAI fails, call Anthropic. It's simple, it works in dev, and it breaks in three specific ways under production load.

**First, retry storms.** When a provider starts returning 503s, every request retries — and if the retry also goes to the failing provider before falling back, you've doubled the load on an already-struggling API. At 1K concurrent requests, that's 1K retry attempts hitting the same endpoint within seconds, making recovery slower for everyone.

**Second, no health memory.** The naive approach treats every request independently. Request N gets a 503, falls back to Anthropic, succeeds. Request N+1 tries OpenAI again, gets another 503, falls back again. Every single request pays the latency penalty of a failed attempt before falling back. Without a circuit breaker or cooldown mechanism, you're adding 2-5 seconds of timeout latency to every request during an outage that might last hours.

**Third, error category blindness.** Not all errors are equal. A 429 (rate limit) means "slow down" — retrying on the same provider with backoff is correct. A 503 (service unavailable) means "try somewhere else." A 400 (bad request) means the payload is broken — retrying on any provider sends the same broken payload and fails again. LiteLLM's issue tracker has documented cases where format errors cascaded into provider-wide cooldowns because the failover logic treated every error the same way.

## When You Need This

- You've had an incident where a provider outage caused a customer-facing feature to go fully offline
- Your SLA requires higher availability than any single LLM provider can guarantee (most providers offer ~99.9%, which is 8.7 hours of downtime per year)
- You're processing more than ~5K requests/day — below that, brief outages affect few enough users that manual intervention is often practical
- Provider latency spikes are triggering timeouts that look like outages to your users (p99 > 10s when your SLA is 5s)
- You're in a regulated industry where provider concentration risk is an audit finding

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

| System Type   | Designation | Reasoning                                                                                                                                                                                                                                                                                                                     |
| ------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Streaming** | Critical    | A dropped stream is immediately visible to the user — there's no retry window and no way to hide it. I wouldn't want to run a streaming system in production without failover; a single provider outage means every active user session breaks simultaneously.                                                                |
| **Agents**    | High ROI    | Multi-step agent workflows can't pause mid-execution and resume on a different provider without losing context. Failover at the individual LLM call level keeps the workflow alive. The return on investment is high because agent failures are expensive — a failed 10-step workflow wastes all the tokens from prior steps. |
| **RAG**       | Recommended | RAG pipelines can often queue and retry, so brief outages are less catastrophic. But if the retrieval-then-generate pipeline is synchronous and user-facing, the math changes — a 2-hour outage blocks every query.                                                                                                           |
| **Batch**     | Recommended | Batch jobs aren't latency-sensitive, so they can absorb retries and cooldowns. Failover still helps avoid burning compute on a provider that's down, but it's not the first resilience investment I'd make for batch.                                                                                                         |

## The Pattern

### Architecture

```
Request
  │
  ▼
┌─────────────────────────────────────────────────┐
│                 FailoverRouter                    │
│                                                  │
│  ① Pick next healthy provider                    │
│     ┌──────┐    ┌──────┐    ┌──────┐            │
│     │  P1  │──▶ │  P2  │──▶ │  P3  │            │
│     └──────┘    └──────┘    └──────┘            │
│          (skip any in cooldown)                   │
│                                                  │
│  ② Send request to selected provider             │
│        │                                         │
│     success ─────────────────────────────▶ exit  │
│        │                                         │
│     failure                                      │
│        ▼                                         │
│  ③ Classify error                                │
│     ├─ retryable (429, 529) → backoff, go to ②  │
│     ├─ failover  (5xx, t/o) → go to ①           │
│     └─ fatal     (4xx auth) → return error       │
│                                                  │
│  ④ Health Tracker records outcome                │
│     sliding window · cooldown timers             │
│                                                  │
│  ⑤ Metrics / Callbacks (side-channel)            │
│     failover events · latency · provider usage   │
│                                                  │
└──────────────────────────┬───────────────────────┘
                           │
                           ▼
              Response (first successful provider)
```

_Numerical thresholds shown (e.g., cooldown durations, failure rate percentages) are illustrative starting points — actual values depend on your SLA, traffic volume, and provider characteristics._

The core abstraction is a `FailoverRouter` that wraps multiple LLM providers behind a single `complete()` interface. Three internal components do the work:

1. **Error Classifier** — categorizes each failed response into one of three buckets: `retryable` (429, 529 — retry same provider with backoff), `failover` (500, 502, 503, 504, timeout — try next provider), or `fatal` (400, 401, 403 — stop immediately, no retry helps). This prevents the error-category blindness described in "What I Would Not Do."

2. **Provider Ring** — an ordered list of provider configurations, each with its own health state. The ring determines failover order. When a provider enters cooldown, it's skipped until the cooldown expires and a probe request tests recovery. This is simpler than a full circuit breaker — the pattern integrates with the Circuit Breaker pattern for more sophisticated state machines.

3. **Health Tracker** — maintains a sliding window of recent request outcomes per provider. Tracks success rate, failure rate, average latency, and cooldown state. When the failure rate in the window exceeds a configurable threshold (default: 50% over the last 60 seconds), the provider enters cooldown automatically — no need to wait for the next request to fail.

#### Core Interface

```typescript
interface FailoverRouter {
  complete(request: LLMRequest): Promise<FailoverResult>;
  getProviderHealth(): Map<string, ProviderHealth>;
  resetProvider(name: string): void;
}
```

#### Configurability

| Parameter            | Default              | Description                                       |
| -------------------- | -------------------- | ------------------------------------------------- |
| `providers`          | (required)           | Ordered list of provider configurations           |
| `timeout`            | 30000ms              | Per-provider request timeout                      |
| `cooldownMs`         | 60000ms              | How long a failed provider stays in cooldown      |
| `failureThreshold`   | 0.5                  | Failure rate that triggers automatic cooldown     |
| `windowSize`         | 10                   | Number of recent requests in the sliding window   |
| `maxFailovers`       | providers.length - 1 | Max providers to try per request before giving up |
| `onFailover`         | undefined            | Callback when failover occurs (for metrics)       |
| `onProviderCooldown` | undefined            | Callback when provider enters/exits cooldown      |

_These defaults are starting points. Tighter SLAs or faster providers would justify lower timeouts and shorter cooldown periods; high-latency batch systems might increase both._

#### Key Design Tradeoffs

**Sequential vs. parallel failover.** This design tries providers sequentially — try P1, if it fails, try P2. The alternative (Salesforce's ["delayed parallel retries"](https://www.salesforce.com/blog/failover-design/?bc=OTH) pattern) starts a second request on P2 after a delay, racing both. Sequential is simpler and cheaper (no duplicate API calls), but adds latency on failover. The sequential approach is the right default for most systems; parallel hedging belongs in latency-critical streaming paths and can be layered on top.

**Per-provider cooldown vs. shared circuit breaker.** A full circuit breaker (closed → open → half-open state machine) is more sophisticated but adds complexity. This pattern uses a simpler model: cooldown timer + probe. It's less precise but easier to reason about and sufficient for 2-4 providers. For more complex setups, compose with the Circuit Breaker pattern.

**Error classification at the router level.** Some gateways ([LiteLLM](https://docs.litellm.ai/docs/routing), Portkey) handle error classification in middleware. This design puts it in the router itself because the classification directly determines routing behavior — separating them creates coupling bugs where the classifier and router disagree on what's retryable.

**No response normalization.** This pattern doesn't normalize responses across providers. If OpenAI returns `{ choices: [...] }` and Anthropic returns `{ content: [...] }`, the provider handler is responsible for presenting a consistent `LLMResponse` shape. Response normalization is a separate concern — mixing it into failover logic makes both harder to test.

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

Every resilience pattern introduces its own failure modes. Multi-provider failover is no exception.

| Failure Mode                                                                                                                                                                                                       | Detection Signal                                                                                                                                                                                                                                    | Mitigation                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cascading failover storm** — all providers get overwhelmed simultaneously because the failover sends a burst of traffic to backup providers that aren't scaled for it                                            | Backup provider error rate spikes immediately after primary failover triggers; latency jumps across all providers simultaneously                                                                                                                    | Configure rate limits per provider in the failover config; gradually shift traffic (10% → 50% → 100%) rather than instant switchover; pre-warm backup provider connections                                                            |
| **Cooldown oscillation** — provider recovers briefly, exits cooldown, gets slammed with traffic, fails again, re-enters cooldown in a repeating cycle                                                              | Provider health status flips between HEALTHY and COOLDOWN more than 3 times in 10 minutes; saw-tooth pattern in provider success rate metrics                                                                                                       | Implement exponential backoff on cooldown duration (60s → 120s → 240s); require N consecutive successes during probe phase before fully restoring traffic                                                                             |
| **Error misclassification** — a transient 500 gets classified as `fatal` (or a permanent 401 gets classified as `failover`), causing either premature request failure or wasted failover attempts                  | Elevated fatal error count from a provider that other clients report as operational; failover attempts that consistently fail with the same error across all providers                                                                              | Log the full error response (status, body, headers) with every classification decision; add overrides for provider-specific error codes; review classification accuracy weekly                                                        |
| **Silent quality degradation** — failover works mechanically (requests succeed) but the backup provider produces lower-quality outputs that nobody notices for weeks                                               | Output quality scores (if measured) drift downward during failover periods; user satisfaction metrics decline without corresponding error rate changes; the backup provider handles an increasing share of traffic without anyone investigating why | Run output quality evaluation on backup provider responses during failover; set alerts on quality score differential between primary and backup; review failover frequency monthly — if it's climbing, the primary may need attention |
| **Timeout amplification** — per-provider timeouts stack when multiple providers are tried sequentially, exceeding the caller's expected response time                                                              | End-to-end request latency exceeds global timeout or SLA during failover; p99 latency spikes correlate with failover events                                                                                                                         | Set a global request deadline that's shared across all provider attempts; reduce per-provider timeout during failover (e.g., 10s per provider instead of 30s); track remaining time budget and fail fast if insufficient              |
| **Stale health state** — health tracker data expires or becomes irrelevant after traffic patterns change (e.g., overnight lull means morning traffic hits a provider that went down hours ago with no recent data) | First requests of a traffic spike hit a down provider; health tracker shows "healthy" for a provider that hasn't been tested in hours                                                                                                               | Add TTL to health data (mark as "unknown" after N minutes of no traffic); send periodic probe requests during low-traffic windows; treat "unknown" as "try with caution" rather than "healthy"                                        |

## Observability & Operations

- **Key metrics:**

| Metric                         | Description                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `failover_rate`                | Percentage of requests that required failover (target: <5% under normal conditions) |
| `provider_success_rate`        | Per-provider success rate over 1m/5m/15m windows                                    |
| `failover_latency_overhead_ms` | Additional latency added by failover attempts (p50, p95, p99)                       |
| `provider_cooldown_events`     | Count of cooldown entries per provider per hour                                     |
| `provider_health_status`       | Current status (healthy/cooldown/unknown) per provider                              |
| `error_classification_counts`  | Counts by category (retryable/failover/fatal) per provider                          |

- **Alerting:**

| Severity           | Condition                                                                                     | Action                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Warning            | Failover rate exceeds 5% over 5 minutes                                                       | Primary provider may be degraded — check status page                     |
| Warning            | Any provider in cooldown for more than 10 minutes                                             | Investigate whether provider is down or threshold is misconfigured       |
| Critical           | Failover rate exceeds 30% over 5 minutes                                                      | Significant provider issue — check status page, verify backup is serving |
| Critical           | All providers in cooldown simultaneously                                                      | System is about to start returning errors — manual intervention needed   |
| Warning (low-side) | Failover rate drops to exactly 0% for 7+ days                                                 | The failover path is untested and may have silently broken               |
| Warning            | Backup provider's share of total traffic exceeds 20% for 24+ hours without an active incident | Possible silent primary degradation                                      |

_These thresholds are starting points. Baseline failover rate, traffic volume, and SLA requirements would shift them — a system with aggressive 5s timeouts will naturally see higher failover rates than one with 30s timeouts._

- **Runbook:**
  - **High failover rate alert fires:** (1) Check primary provider status page. (2) Check `error_classification_counts` — if mostly 429s, it's rate limiting, not an outage; consider reducing traffic or upgrading tier. (3) If 503/500s, verify the cooldown mechanism is working — primary should be in cooldown and backup should be serving. (4) Check backup provider latency — if it's also degraded, consider enabling graceful degradation fallbacks.
  - **All providers in cooldown:** (1) Check if it's a real multi-provider outage or a configuration issue (too-aggressive thresholds). (2) Manually reset the healthiest provider with `resetProvider()`. (3) Increase cooldown threshold temporarily if providers are flapping. (4) Activate graceful degradation fallbacks (cached responses, rule-based handlers).
  - **Zero failover for 7+ days:** (1) Verify the failover path hasn't been bypassed by a code change. (2) Run a manual failover test by temporarily misconfiguring the primary. (3) Check that the `onFailover` callback is still wired to metrics.

## Tuning & Evolution

- **Tuning levers:**

| Parameter                    | Safe Range                         | Dangerous Extreme                                                                                                                                                                           | Effect                                         |
| ---------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `failureThreshold` (0.0–1.0) | 0.3–0.6                            | Below 0.2: transient errors trigger premature cooldown. Above 0.8: users absorb hundreds of failures before cooldown activates (Benchmark Scenario 6: 1,335 failovers at 0.8 vs. 29 at 0.2) | Controls cooldown aggressiveness               |
| `cooldownMs` (ms)            | 30s–300s                           | Below 15s: providers that need minutes to recover get hit again too soon. Above 600s: a recovered provider stays idle unnecessarily                                                         | How long to avoid a failed provider            |
| `windowSize` (count)         | 5–50                               | Below 5: single failures trigger cooldown. Above 100: cooldown reacts too slowly to sudden outages                                                                                          | Number of recent requests in the health window |
| `timeout` (ms)               | 5s–30s interactive, 30s–120s batch | Below 3s: normal high-latency responses get classified as timeouts. Above 60s: users wait an unacceptable time during failover                                                              | Per-provider request timeout                   |
| `maxFailovers` (count)       | 1–3                                | Higher values increase worst-case latency linearly                                                                                                                                          | Caps the number of providers tried per request |

- **Drift signals:**
  - Failover rate creeping up over weeks without clear incidents — primary provider may be degrading slowly
  - Backup provider latency increasing — check if backup provider changed models, pricing, or capacity
  - Error classification accuracy dropping — new error codes from providers that aren't in the classifier
  - Cooldown duration no longer matches recovery time — provider recovery characteristics may have changed
  - Review configuration quarterly or after any provider API version change

- **Silent degradation:**
  - **Month 3:** The backup provider has been updated and its response format changed subtly. The handler still works (no errors), but output quality dropped 10% for failover requests. Nobody noticed because failover only happens 2% of the time.
  - **Month 6:** A provider added a new error code (529 "overloaded") that the error classifier doesn't recognize. It falls through to the default `failover` category — which works, but means retryable errors are being treated as failover events, sending premature traffic to the backup. Failover rate has crept from 2% to 8% without triggering alerts because it's still below the 30% critical threshold.
  - **Proactive checks:** Run monthly failover drills (force-fail the primary, verify backup serves correctly). Compare output quality scores between providers quarterly. Review error classification accuracy against actual provider error responses.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed projections across GPT-4o, Claude Sonnet, and GPT-4o-mini.

| Scale        | Additional Cost (GPT-4o) | ROI vs. No Pattern                                                              |
| ------------ | ------------------------ | ------------------------------------------------------------------------------- |
| 1K req/day   | +$0.04/day (+1.2%)       | Pays for itself on first outage avoiding ~42 failed requests/hr                 |
| 10K req/day  | +$0.37/day (+1.1%)       | One 2-hour outage without failover costs ~$27 in failed requests alone          |
| 100K req/day | +$3.70/day (+1.1%)       | Annual overhead ~$1,350 vs. single avoided 2-hour outage saving ~8,333 requests |

## Testing

See [`src/ts/__tests__/index.test.ts`](src/ts/__tests__/index.test.ts) for the full test suite. Run with `cd src/ts && npm test`.

- **Unit tests (10):** Primary routing, failover on 503, priority ordering, AllProvidersExhaustedError, fatal error short-circuit, maxFailovers limit, latency tracking, provider health reporting, manual reset, config validation
- **Error classification tests (10):** One test per HTTP status category — 429/529 (retryable), 500/503 (failover), 400/401/403 (fatal), timeout, network errors, unknown errors
- **Failure mode tests (6):** One test per failure mode from the Failure Modes table — cascading failover storm (maxFailovers limit), cooldown oscillation (sustained failure detection), error misclassification (400 doesn't trigger failover), silent quality degradation (provider attribution in result), timeout amplification (per-provider timeout caps total latency), stale health state (cooldown expiry re-enables probing)
- **Integration tests (2):** Full lifecycle (normal → failure → cooldown → recovery), concurrent request handling during failover

## When This Advice Stops Applying

- **Model behavior consistency is critical.** If your use case requires exact output reproducibility (fine-tuned model, specific formatting that only one provider handles), failover to a different provider changes the outputs. For structured extraction where you've tuned prompts to one model's behavior, the accuracy delta between providers might be worse than the downtime.
- **Single-provider lock-in is contractual.** Enterprise agreements, data residency requirements, or compliance mandates (e.g., "all LLM calls must go through our Azure tenant") can make multi-provider architectures a non-starter. The failover pattern assumes you have the organizational ability to use multiple providers.
- **Scale is too small to justify the complexity.** Below ~1K requests/day, a provider outage affects a handful of users. The operational cost of maintaining accounts, testing prompts across providers, and handling response format differences probably exceeds the cost of occasional downtime.
- **Provider convergence reduces the need.** As providers standardize on the OpenAI API format and response quality converges, the need for provider-specific handling diminishes. If the ecosystem moves toward true commodity APIs, simpler load-balancing replaces dedicated failover logic.
- **The failure mode you're solving for isn't provider outages.** If your actual reliability problem is prompt quality, data pipeline issues, or application bugs, adding failover addresses the wrong bottleneck. Failover only helps when the provider is the point of failure.

<!-- ## Companion Content

- Blog post: [Multi-Provider Failover — Deep Dive](https://prompt-deploy.com/multi-provider-failover) (coming soon)
- Related patterns:
  - [Graceful Degradation](../graceful-degradation/) — what happens when failover exhausts all providers; the fallback-of-last-resort
  - [Circuit Breaker](../circuit-breaker/) — more sophisticated state machine for provider health; this pattern uses a simpler cooldown model that can be swapped for a full circuit breaker
  - [Retry with Budget](../retry-with-budget/) — handles retryable errors (429) on the same provider; this pattern handles failover to a different provider
  - [Model Routing](../../cost-control/model-routing/) — routes by capability/cost; failover routes by availability. The two compose naturally — route to the cheapest capable provider, fail over to the next one
  - [Latency Budget](../../performance/latency-budget/) — failover latency counts against the budget; aggressive timeouts during failover prevent latency budget violations
  - [Structured Tracing](../../observability/structured-tracing/) — traces across failover attempts provide the observability needed to debug failover behavior in production -->

# Graceful Degradation

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

When an LLM provider goes down, most systems treat it as a binary event — either the response works or the user sees a 500 error. There's nothing in between.

On December 11, 2024, OpenAI went completely dark for over four hours. A new telemetry service deployment overwhelmed their Kubernetes control plane, causing cascading failures across every cluster. Every production system with a hard dependency on OpenAI's API was down for the duration — not because the application was broken, but because nobody had defined what "reduced service" looked like.

The same thing plays out at smaller scale constantly. A provider returns 429s for 90 seconds during a traffic spike. A model endpoint times out for 30 seconds during a rolling deployment. Without graceful degradation, these 30-second blips become minutes-long user-facing outages because the system has exactly two modes: "perfect" and "broken."

A 2024 Forrester study found that 71% of enterprises have no documented degradation plan for their production AI systems. The gap isn't technical — it's conceptual. Teams build for the happy path and treat failures as exceptions to handle later.

## What I Would Not Do

It could be tempting every LLM call in a try/catch with a generic error message: "Sorry, something went wrong. Please try again." This feels reasonable but creates two problems.

First, it's a lie. The user retries, hits the same outage, and loses trust. If the provider is down for four hours, "try again" is actively harmful advice.

Second — and this is the bigger issue — every request still hits the failing provider. At 10K req/day, that means 10K timeout waits, 10K error logs, and if there's any retry logic, a retry storm that amplifies a 2-second outage into 30 seconds of cascading failures. The system first waits for retries to fail before doing anything useful, and meanwhile every pending request is consuming connections, memory, and patience.

The slightly more sophisticated version is a static fallback message per endpoint. "AI features are temporarily unavailable." This is better than a 500 error but still binary — the system either works or it doesn't. There's no middle ground where the response is worse but still useful.

What's missing in both cases: the system has no concept of _quality tiers_. It doesn't know that a cached response from 10 minutes ago might be 80% as good as a fresh one, or that a simpler model could handle 60% of requests acceptably, or that rule-based logic could cover the most common cases with zero API dependency.

## When You Need This

- The system has any user-facing latency SLA — degraded responses within SLA beat perfect responses after a timeout
- External LLM APIs are a hard dependency and uptime isn't guaranteed
- There's been at least one incident where a provider outage took an entire feature offline
- Streaming use cases where dropped connections cascade immediately to the user
- RAG or agent workflows where a single failed LLM call breaks a multi-step pipeline
- The cost of a wrong-but-reasonable response is lower than the cost of no response at all

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **Streaming → Critical.** A dropped stream is immediately visible — the user watches the response die mid-sentence. There's no retry window once tokens are flowing. Without degradation tiers, any provider hiccup means a broken connection, and that's an outage. I'd want this in place before the first user connects.
- **RAG → Required.** By the time generation fails, retrieval has already done its work. Without degradation, that retrieved context gets thrown away and the user gets nothing. A cached or simpler response using the same retrieved context is still useful. Not critical because the failure isn't as immediately catastrophic — but I wouldn't want to get paged without it.
- **Agents → Required.** Agent loops depend on LLM calls at every step. A provider blip mid-loop kills the multi-step task. But agents can often checkpoint or restart from a known state — the work isn't lost, just interrupted. Same reasoning as RAG: I'd want this before production, but the system won't break the way a stream does.
- **Batch → Recommended.** No user is waiting. When a provider goes down, the job pauses, checkpoints, and resumes later. Retry logic and checkpointing cover most of the same failure scenarios. Degradation tiers add value — a cheaper model might handle some items acceptably — but the urgency is lower. I'd notice the gap by month six, not day one.

## The Pattern

### Architecture

The core idea: replace the binary "works or doesn't" with an ordered chain of quality tiers. When the primary provider fails, the system walks down the chain until something responds. Every response carries metadata about which tier served it.

```
                         ┌─────────────────────┐
                         │    Incoming Request  │
                         └──────────┬──────────┘
                                    ▼
                         ┌─────────────────────┐
                         │   Tier 1: Primary    │──── success ──→ Response
                         │   (full LLM call)    │                 quality: 1.0
                         └──────────┬──────────┘
                                    │ failure/timeout
                                    ▼
                         ┌─────────────────────┐
                         │  Tier 2: Fallback    │──── success ──→ Response
                         │  (alt model/provider)│                 quality: 0.7
                         └──────────┬──────────┘
                                    │ failure/timeout
                                    ▼
                         ┌─────────────────────┐
                         │  Tier 3: Cache       │──── hit ─────→ Response
                         │  (semantic lookup)   │                 quality: 0.5
                         └──────────┬──────────┘
                                    │ miss
                                    ▼
                         ┌─────────────────────┐
                         │  Tier 4: Rule-Based  │──── match ───→ Response
                         │  (deterministic)     │                 quality: 0.3
                         └──────────┬──────────┘
                                    │ no match
                                    ▼
                         ┌─────────────────────┐
                         │  Tier 5: Static      │──────────────→ Response
                         │  (last resort)       │                 quality: 0.1
                         └─────────────────────┘

        Every response includes:
        ┌──────────────────────────────────────────┐
        │  { content, tier, quality, latency,      │
        │    cached: bool, degraded: bool }         │
        └──────────────────────────────────────────┘
```

Quality scores shown are illustrative — actual values depend on the use case and how well each tier covers it.

**Core abstraction** — the `DegradationChain`:

```typescript
interface DegradationTier {
  name: string;
  handler: (request: LLMRequest) => Promise<LLMResponse>;
  qualityScore: number; // 0.0 – 1.0
  timeout: number; // ms, per-tier
  isHealthy?: () => boolean; // optional circuit state
}

interface DegradationResult {
  response: LLMResponse;
  tier: string;
  quality: number;
  latency: number;
  degraded: boolean;
}
```

The chain accepts an ordered array of tiers and walks them sequentially. If a tier throws, times out, or reports unhealthy via `isHealthy()`, the chain advances to the next tier. The last tier (static) won't fail in execution — it returns a hardcoded response — but the response may not be contextually relevant to the request. It's a "the system is still alive" signal, not a useful answer. If every tier is exhausted including static (which shouldn't happen unless there's a code-level bug), the chain throws an `AllTiersExhaustedError` with metadata about which tiers were attempted and why each failed.

**Configurability:**

| Parameter               | Default           | Purpose                                                    |
| ----------------------- | ----------------- | ---------------------------------------------------------- |
| `tiers`                 | (required)        | Ordered array of `DegradationTier` objects                 |
| `timeoutMs`             | `5000`            | Global timeout across all tiers combined                   |
| `minQuality`            | `0.0`             | Minimum acceptable quality — tiers below this are skipped  |
| `cacheTtlMs`            | `600000` (10 min) | How long cached responses are considered valid             |
| `onDegradation`         | `undefined`       | Callback fired when response comes from a non-primary tier |
| `healthCheckIntervalMs` | `30000` (30s)     | How often to re-check unhealthy tiers                      |

These defaults are starting points. Actual values depend on provider latency characteristics, user-facing SLA requirements, and how quickly the underlying data changes.

**Key design tradeoffs:**

| Decision                                  | Choice                                       | Rationale                                                                                                                                                                                        |
| ----------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sequential chain vs. parallel racing      | Sequential — first tier that succeeds wins   | Parallel racing would be faster in degraded scenarios but wastes resources when the primary is healthy (the vast majority of the time). Sequential also makes the quality semantics clearer.     |
| Quality scores as numbers vs. enums       | Numbers (0.0–1.0)                            | Lets consumers make their own quality decisions (e.g., "don't show responses below 0.3 in the main UI, but they're fine for autocomplete suggestions").                                          |
| Per-tier timeouts vs. global-only timeout | Both                                         | Each tier gets its own timeout so a slow fallback provider doesn't eat into cache/rule-based time. The global timeout acts as a safety net across the full chain.                                |
| Health check skip vs. always-try          | Skip if unhealthy                            | If `isHealthy() === false`, the chain skips the tier entirely without attempting a call. Avoids wasting time on providers known to be down. The circuit re-checks on a configurable interval.    |
| Partial responses                         | Full success or fail — no partial state      | The handler decides whether a truncated or malformed response counts as success or failure. Keeps the chain logic simple — each tier's handler encapsulates its own definition of "good enough." |
| Cross-tier data consistency               | Not enforced by the chain                    | Different tiers may return different formats or levels of detail. `DegradationResult` metadata (tier, quality, degraded) lets consumers adapt. The right adaptation depends on the use case.     |
| Security across providers                 | Operational concern, not runtime enforcement | Each provider in the chain sees request content. If requests contain sensitive data, all providers need to meet the same data handling requirements. Validate during setup, not at runtime.      |

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

Every degradation layer introduces its own failure modes. The pattern that's supposed to keep the system alive can itself become the problem.

| Failure Mode                                                                                                                                                                                                                                                                                                                                                                 | Detection Signal                                                                                                                                                                         | Mitigation                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Stale cache served indefinitely** — cache TTL is too generous or never expires, so users get outdated responses long after the provider recovers                                                                                                                                                                                                                           | Cache age histogram shows entries >10x the configured TTL; user reports of outdated information despite provider being healthy                                                           | Enforce hard max TTL independent of hit rate; include `cached_at` timestamp in response metadata; alert when average cache age exceeds 2x TTL                                                                                                                |
| **All tiers fail simultaneously** — an infrastructure issue (DNS, network partition, OOM) takes out every tier including static fallback                                                                                                                                                                                                                                     | Response rate drops to zero; error rate hits 100%; the chain exhausts all tiers and throws `AllTiersExhaustedError` with per-tier failure reasons                                        | Ensure the static tier is truly static (in-memory, zero network or I/O dependencies); test the full degradation chain in CI with all-tiers-failing scenario; the static tier can depend on basic runtime libraries but nothing that requires network or disk |
| **Health check false positive** — circuit marks the primary provider as unhealthy when it's actually working, routing all traffic to lower-quality tiers unnecessarily                                                                                                                                                                                                       | Primary provider success rate is high (via external monitoring) but internal health check shows it as down; degradation rate spikes without a corresponding provider incident            | Require N consecutive failures (not just 1) before marking unhealthy; implement half-open state that probes the primary periodically; cross-reference with provider status page                                                                              |
| **Fallback quality too low for use case** — the system serves a response from a low-quality tier for a request that genuinely needs full LLM capability                                                                                                                                                                                                                      | Quality score distribution shifts downward; user satisfaction/NPS drops; task completion rate decreases for AI-assisted features                                                         | Set `minQuality` threshold per endpoint/use-case; return an honest "limited functionality" indicator rather than pretending a rule-based response is equivalent to full LLM output                                                                           |
| **Timeout cascade across tiers** — each tier consumes its full timeout before failing, so the total latency is the sum of all tier timeouts                                                                                                                                                                                                                                  | End-to-end latency spikes to (N tiers × per-tier timeout); p99 latency far exceeds SLA during partial outages                                                                            | Set a global timeout as a safety net; make per-tier timeouts aggressive (fail fast); skip tiers that report unhealthy via `isHealthy()`                                                                                                                      |
| **Tier ordering becomes suboptimal** — the fallback provider is now faster or higher-quality than the primary, but the ordering was set once at deploy time                                                                                                                                                                                                                  | Fallback tier latency and quality metrics consistently outperform primary tier; unnecessary degradation penalty on every fallback                                                        | Monitor per-tier success rate, latency, and quality; log tier performance weekly; review and adjust ordering quarterly or when provider pricing/performance changes                                                                                          |
| **Cache poisoning** — a bad or hallucinated response gets cached during normal operation, then served repeatedly to users when the primary tier degrades to cache                                                                                                                                                                                                            | Cache hit rate looks healthy but user complaints spike for a specific query pattern; cached response quality scores are inconsistent with expected quality for the cache tier            | Validate responses before caching (basic sanity checks: non-empty, parseable, within expected length); include a mechanism to invalidate specific cache entries; log cache writes with enough context to audit later                                         |
| **Fallback tier behavioral divergence** — the fallback provider or rule-based tier produces responses that are structurally valid but semantically different from what the primary would return, causing downstream logic to break in unexpected ways                                                                                                                        | Downstream error rates spike during degradation even though the degradation chain itself reports success; task completion rates differ significantly per tier                            | Test fallback tiers against the same evaluation suite used for the primary; document expected behavioral differences per tier; use response metadata to route downstream processing when the tier changes                                                    |
| **Silent degradation: quality tier drift** _(silent)_ — the system is technically "up" but serves an increasing percentage of requests from lower-quality tiers. No alerts fire because the system is returning 200s. Over weeks, the primary tier's health check threshold becomes stale, or a configuration change routes more traffic to fallback without anyone noticing | Quality tier distribution shifts gradually — e.g., Week 1: 95% primary / 5% fallback → Week 12: 60% primary / 40% fallback, but no alert fires because each individual response succeeds | Track quality tier distribution as a time series; alert when primary-tier percentage drops below a baseline (e.g., <85%); weekly automated report of tier distribution; include quality tier in dashboards alongside latency and error rate                  |

## Observability & Operations

- **Key metrics:**

| Metric                            | Description                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `degradation.tier_served`         | Counter per tier name. The primary signal. Track the distribution over time: what percentage of requests are served by each tier? |
| `degradation.quality_score`       | Histogram of quality scores per response. A healthy system clusters near 1.0; a degrading system spreads downward.                |
| `degradation.latency_ms`          | Histogram of total chain execution time (not per-tier). Includes time spent on failed tiers before the successful one.            |
| `degradation.tier_attempt_count`  | How many tiers were attempted per request. Normally 1 (primary succeeded). Rising average means degradation is happening.         |
| `degradation.all_tiers_exhausted` | Counter of `AllTiersExhaustedError` events. This is the "system is fully broken" metric.                                          |
| `degradation.cache_age_seconds`   | Histogram of cache entry age at time of serving. Tracks freshness of cached responses.                                            |
| `degradation.health_check_state`  | Gauge per tier (0 = healthy, 1 = unhealthy). Lets dashboards show which tiers are currently in circuit-open state.                |

- **Alerting:**

| Severity             | Condition                                                                       | What It Means                                                      |
| -------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Warning              | Primary tier percentage drops below 90% over a 5-minute window                  | Something is pushing traffic to fallback tiers                     |
| Warning              | Average cache age exceeds 2x the configured TTL                                 | Stale responses may be in circulation                              |
| Warning (low-side)   | Degradation rate drops to 0% when it was previously >0%                         | Could indicate a monitoring gap or a health check misconfiguration |
| Critical             | Primary tier percentage drops below 70% over a 5-minute window                  | Significant quality impact                                         |
| Critical             | `all_tiers_exhausted` count > 0 in any 1-minute window                          | The system is returning errors                                     |
| Critical (high-side) | Degradation rate spikes to >50% without a corresponding provider incident alert | Possible health check false positive                               |

These thresholds are starting points calibrated for a system serving user-facing traffic with moderate latency sensitivity. Adjust based on baseline tier distribution, SLA requirements, and tolerance for degraded responses.

- **Runbook:**
  1. **Check first:** Is the primary provider actually down? Cross-reference with the provider's status page and external monitoring. If the provider is healthy but `isHealthy()` shows it as down, it's a health check false positive — review the health check threshold.
  2. **If provider is down:** Confirm degradation is working as intended. Check tier distribution — requests should be flowing to fallback/cache/rule-based tiers. If `all_tiers_exhausted` is rising, check whether the static fallback tier is configured correctly.
  3. **If provider is up but degradation is high:** Check per-tier latency. The primary may be responding but too slowly, causing per-tier timeouts. Consider increasing the primary tier's `timeoutMs` or investigating the provider's latency regression.
  4. **If cache age alerts fire:** Check whether the cache is being populated with fresh entries. The cache population logic may have stalled, or the primary tier may have been down long enough that all cached entries are stale.
  5. **If all_tiers_exhausted:** This is a P1 incident. Verify the static tier handler is loaded and doesn't have a code-level bug. The static tier should have zero dependencies — if it's failing, there's likely an application-level issue (OOM, process crash).

## Tuning & Evolution

- **Tuning levers:**

| Parameter               | Safe Range                     | Purpose                                                                                                                | Dangerous Extreme                                                                                                                                            |
| ----------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `timeoutMs` (per-tier)  | 100ms–5000ms                   | Start at 2x the provider's p95 latency and tune down                                                                   | Too low: healthy providers get timed out unnecessarily. Too high: failed tiers eat into the global timeout budget and increase latency for degraded requests |
| `globalTimeoutMs`       | 1000ms–10000ms                 | Hard ceiling on how long a request can take. Set it at or below the user-facing SLA                                    | <500ms risks timing out even healthy primary calls; >15000ms means users are waiting 15+ seconds in worst case                                               |
| `minQuality`            | 0.0–0.5                        | At 0.0, any response is better than none. At 0.5, only cache-or-better tiers are acceptable                            | >0.7 effectively disables most fallback tiers, turning the pattern back into a binary success/fail                                                           |
| `cacheTtlMs`            | 60000–3600000 (1 min – 1 hour) | Depends on how fast the underlying data changes. For static content, longer TTLs are fine. For real-time data, shorter | >24 hours risks serving day-old responses during outages                                                                                                     |
| `healthCheckIntervalMs` | 10000–120000 (10s – 2 min)     | Controls re-check frequency for unhealthy tiers. Start at 30s, adjust based on provider recovery patterns              | Too frequent: unnecessary probe traffic to a recovering provider. Too infrequent: the circuit stays open long after the provider recovers                    |

- **Drift signals (review quarterly):**
  - Primary tier success rate dropping below 95% over a 30-day window — investigate whether provider reliability has changed or thresholds need adjustment
  - Fallback tier latency consistently lower than primary — consider re-ordering tiers or switching primary providers
  - Cache hit rate during degradation declining — the query distribution may have shifted, requiring cache population strategy updates
  - New provider models becoming available — a new GPT-4o-mini variant might be a better fallback tier than the current one
  - Per-tier timeout values significantly different from provider p95 latency — re-benchmark provider latencies and update

- **Silent degradation:**
  - **Month 3:** Quality tier distribution starts shifting. The system was 97% primary / 3% fallback at deploy, and now it's 88% primary / 12% fallback. No alert fires because 88% is above the 70% critical threshold. The shift is caused by the primary provider's p99 latency creeping up (from 800ms to 1200ms), causing occasional per-tier timeouts. Nobody notices because overall latency metrics look normal (the degraded responses are fast).
  - **Month 6:** The health check interval hasn't been re-evaluated. The provider improved their recovery time from ~60s to ~15s, but the health check still re-probes every 30s with a 5-failure threshold. This means the circuit stays open for ~2.5 minutes after recovery, serving degraded responses to ~4% of daily traffic unnecessarily. The cache entries are also aging — popular queries haven't been refreshed because the cache population only happens on primary success.
  - **Proactive checks:** Weekly automated report comparing current tier distribution to the 30-day baseline. Monthly review of per-tier timeout values vs. provider p95 latency. Quarterly review of the full tier configuration against current provider landscape.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed projections, formulas, and per-model breakdowns.

| Scale        | Additional Cost   | ROI vs. No Pattern                                         |
| ------------ | ----------------- | ---------------------------------------------------------- |
| 1K req/day   | -$0.16/day saved  | Modest token savings; real value is availability           |
| 10K req/day  | -$1.63/day saved  | ~$49/month saved from avoided retry waste                  |
| 100K req/day | -$16.25/day saved | ~$488/month saved; spikes to ~$55/day during major outages |

GPT-4o pricing. The dollar savings are modest — the real ROI is measured in availability, not tokens. During a 4-hour outage, 17% of daily requests would otherwise fail.

## Testing

See test files in `src/ts/__tests__/index.test.ts`. Run with `cd src/ts && npm test`.

- **Unit tests (10):** Primary tier response, tier walk-through order, constructor validation, default config values, `minQuality` filtering, unhealthy tier skipping, `onDegradation` callback firing (and non-firing), latency recording in metadata.
- **Failure mode tests (9):** One per failure mode from the table — stale cache (FM1), all tiers exhausted with per-tier details (FM2), health check false positive (FM3), minQuality prevents low-quality serving (FM4), global timeout cascade prevention (FM5), per-tier metrics for ordering review (FM6), cache poisoning detection (FM7), fallback behavioral divergence (FM8), silent quality tier drift (FM9).
- **Integration tests (6):** Full 5-tier chain walkthrough to static, cache hit on primary failure, rule-based pattern matching, concurrent request independence, per-tier timeout fallthrough, mixed healthy/unhealthy tiers with cache.
- **What to regression test:** Any change to `DegradationChain.execute()` flow, timeout logic, tier skipping conditions, or `AllTiersExhaustedError` construction.

## When This Advice Stops Applying

- **Prototyping and iteration** — if uptime isn't a concern yet and the team is still figuring out what the LLM feature does, degradation logic is premature complexity
- **Correctness-critical domains** — medical diagnosis, legal document generation, financial compliance. In these cases, a wrong-but-reasonable response is worse than no response. Failing loudly is the right move
- **Internal tools with tolerant users** — if the user base can retry manually and understands the system is best-effort, the engineering cost of degradation tiers may not be justified
- **Very low traffic** — at 100 req/day, the probability of hitting a provider outage during active use is low enough that the complexity overhead doesn't pay for itself
- **Single-model features with no reasonable fallback** — some capabilities genuinely can't degrade. If the entire value proposition requires GPT-4-level reasoning, a cached response or rule-based fallback isn't a degradation — it's a different product

<!-- ## Companion Content

- Blog post: [Graceful Degradation — Deep Dive](https://prompt-deploy.com/graceful-degradation) (coming soon)
- Related patterns:
  - [Retry with Budget](../retry-with-budget/) (#5, S2) — handles transient failures before degradation kicks in
  - [Circuit Breaker](../circuit-breaker/) (#6, S2) — decides when to stop trying and trigger degradation
  - [Multi-Provider Failover](../multi-provider-failover/) (#9, S3) — an alternative to degradation: try a different provider
  - [Latency Budget](../../performance/latency-budget/) (#14, S4) — time constraints that trigger degradation decisions
  - [Structured Output Validation](../../safety/structured-output-validation/) (#2, S1) — validates responses before caching, preventing cache poisoning -->

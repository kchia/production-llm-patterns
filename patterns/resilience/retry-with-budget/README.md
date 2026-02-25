# Retry with Budget

> **Part of [Production LLM Patterns](../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

Without a retry budget, retries amplify the exact outage they're trying to recover from. Here's what that looks like in practice: a provider returns 503s for two seconds. Every client retries immediately. If each client retries three times, the provider sees 3x its normal load — right when it's already struggling. That two-second blip becomes a 30-second cascading failure.

The [October 2025 AWS US-EAST-1 outage](https://www.infoq.com/news/2025/11/aws-dynamodb-outage-postmortem/) is the textbook example. A DNS resolution failure for DynamoDB's regional endpoint caused SDK clients across millions of EC2 instances and Lambda functions to retry simultaneously. The retry storm overwhelmed AWS's internal resolver infrastructure, making recovery slower and extending the outage to hours.

Each retry is also a paid API call. Without a budget, a single failing endpoint can generate dozens of retries per client before anyone notices. At 1,000 concurrent clients with 3 retries each, that's 3,000 extra API calls — all hitting a provider that's already overloaded. The financial cost compounds: retries against rate-limited LLM APIs waste tokens-per-minute quota on requests that are unlikely to succeed, reducing your effective throughput even after the provider recovers.

## What I Would Not Do

It's tempting to reach for a fixed-delay retry with a max attempt count — something like "retry 3 times with a 1-second delay." It's simple, and it works fine in development. The problem shows up at scale.

With fixed delays, all clients retry at the same interval. A thousand clients that failed at the same time will all retry one second later — simultaneously. The provider sees a wall of requests instead of a trickle. Without any budgeting, retries can amplify load by up to 3x on a per-request basis (the mathematical ceiling when `maxAttempts=3`). [Google's SRE team](https://sre.google/sre-book/handling-overload/) documents the broader principle: uncoordinated retries amplify load on already-overloaded services.

Adding exponential backoff helps — the delays grow longer between retries, which spreads them out over time. But exponential backoff alone doesn't cap the total volume of retries across all clients. During a sustained outage, every client is still retrying independently, and the aggregate load keeps climbing. Backoff without a budget is better than fixed delays, but it's still unbounded.

The other common mistake is retrying errors that aren't transient. A 400 Bad Request means the request itself is broken — retrying it three times just wastes three API calls. A 401 means the credentials are wrong. Only 429 (rate limit), 500 (server error), and 503 (service unavailable) are worth retrying. Failed requests often still count toward your rate limit quota, so retrying non-transient errors actually makes rate limiting worse.

## When You Need This

- Your system makes enough concurrent LLM API calls that uncoordinated retries during a provider incident would multiply the load rather than absorb it — the threshold where this matters is roughly 100+ requests/minute
- You're calling rate-limited APIs where failed requests still count toward your quota (both [OpenAI](https://platform.openai.com/docs/guides/rate-limits) and Anthropic behave this way), so retries need to be budgeted against available capacity
- You've observed retry amplification during a provider incident — the retries made the outage worse, not better
- Your p99 latency spikes during provider degradation and you've traced it to requests waiting through multiple retry cycles (e.g., 3 retries × 10-second timeout = 30 seconds before fallback triggers)
- You're spending enough on API calls that wasted retries have a measurable cost impact — at $10/1M output tokens, 3x retry amplification on 10K daily requests adds up

**Priority by system type** (from the [Navigation Matrix](../../README.md#navigation-matrix)):

- **Streaming → Required.** Users are waiting for tokens in real time. A retry storm that adds 30 seconds of latency before fallback triggers is indistinguishable from an outage. I'd want budgeted retries in place before accepting a page for a streaming system — the alternative is watching retry storms turn partial degradation into complete unavailability.
- **Agents → Required.** Multi-step tool-using loops make dozens of LLM calls per task. Without a retry budget, a single degraded provider turns one slow step into a cascade — each step retries independently, and the aggregate load multiplies. I wouldn't want to get paged without this in place.
- **Batch → Required.** Long-running batch jobs make thousands of calls over hours. Unbounded retries during a provider blip can double or triple the job's API spend without anyone noticing until the invoice arrives. The batch keeps running, the retries keep burning tokens, and the budget is gone.
- **RAG → Recommended.** RAG systems typically make fewer concurrent calls per query (retrieve, then generate), so the retry amplification effect is smaller. I'd still want retries to be budgeted, but the gap between "has this" and "doesn't have this" is less dramatic than for streaming or agents.

## The Pattern

### Architecture

```
                    Request
                       │
                       ▼
              ┌─────────────────┐
              │  Retry Handler  │
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────┐
              │    Provider     │
              └───┬─────────┬───┘
                  │         │
             success      error
                  │         │
    ┌─────────────┘         └──────────────┐
    │                                      │
    ▼                                      ▼
┌────────────┐                    ┌────────────────┐
│ Add +0.1   │                    │ Retryable?     │
│ tokens to  │                    │ (429/500/503)  │
│ bucket     │                    └───┬────────┬───┘
└─────┬──────┘                     yes│        │no
      │                               │        │
      ▼                               │        ▼
┌────────────┐                        │   Throw error
│  Return    │                        │   (immediate)
│ RetryResult│                        ▼
└────────────┘               ┌─────────────────┐
                             │ Token Bucket     │
                             │ has tokens?      │
                             └───┬──────────┬───┘
                              yes│          │no
                                 │          │
                                 ▼          ▼
                          ┌───────────┐  Throw
                          │ Backoff   │  RetriesExhausted
                          │ + Jitter  │
                          │ (wait)    │
                          └─────┬─────┘
                                │
                                └──→ retry (back to Provider)

Metrics emitted at: success, retry, budget check, exhaustion
```

The core abstraction is a `RetryWithBudget` handler that wraps any LLM provider call. It combines three mechanisms:

1. **Per-request retry policy** — Exponential backoff with full jitter, a max attempt cap (default: 3), and error classification that only retries transient failures (429, 500, 503). Honors `Retry-After` headers when present.

2. **Token bucket budget** — A shared token bucket that limits aggregate retries across all callers. Each successful call adds tokens (at a configurable `tokenRatio`, default: 0.1). Each retry attempt consumes one token. When the bucket drops below 50% of `maxTokens`, retries are paused — new requests get at most one attempt until the bucket recovers. This is the mechanism that prevents retry storms: under sustained failure, the budget runs dry and retries stop.

3. **Metrics emission** — Every retry attempt, budget check, and exhaustion event emits a metric. This is what makes the pattern observable — without it, the budget is a black box.

The numerical values in the diagram (ratios, thresholds) are illustrative defaults. Actual values depend on traffic volume, provider error rates, and SLA requirements.

#### Core Interface

```typescript
interface RetryWithBudgetConfig {
  maxAttempts: number; // Per-request cap (default: 3)
  initialDelayMs: number; // Base delay for backoff (default: 200)
  maxDelayMs: number; // Backoff ceiling (default: 30_000)
  backoffMultiplier: number; // Exponential factor (default: 2)
  jitterMode: "full" | "equal" | "none"; // Jitter strategy (default: 'full')
  budgetConfig: {
    maxTokens: number; // Bucket size (default: 100)
    tokenRatio: number; // Tokens added per success (default: 0.1)
    refillIntervalMs: number; // Passive refill interval (default: 1000)
    refillAmount: number; // Tokens added per interval (default: 1)
  };
  retryableStatuses: number[]; // HTTP codes worth retrying (default: [429, 500, 503])
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}
```

#### Configurability

| Parameter                 | Default  | Purpose                | Dangerous Extreme                                                                   |
| ------------------------- | -------- | ---------------------- | ----------------------------------------------------------------------------------- |
| `maxAttempts`             | 3        | Per-request retry cap  | >5 risks amplification; 1 disables retries entirely                                 |
| `initialDelayMs`          | 200      | First backoff delay    | <50ms is effectively no backoff; >5000ms adds latency for transient blips           |
| `maxDelayMs`              | 30,000   | Backoff ceiling        | >60s means requests wait over a minute; <1s defeats the purpose of backoff          |
| `backoffMultiplier`       | 2        | How fast delays grow   | >4 reaches ceiling too quickly; <1.5 barely grows                                   |
| `jitterMode`              | `'full'` | Randomization strategy | `'none'` reintroduces thundering herd                                               |
| `budgetConfig.maxTokens`  | 100      | Bucket capacity        | <10 pauses retries too aggressively; >1000 provides no practical limit              |
| `budgetConfig.tokenRatio` | 0.1      | Tokens per success     | >1.0 means bucket refills faster than it drains; <0.01 means budget barely recovers |

Defaults are starting points. The right values depend on your SLA (tighter SLAs warrant lower `maxDelayMs`), provider characteristics (providers with `Retry-After` headers can use longer initial delays), and traffic volume (higher traffic needs a larger `maxTokens` bucket).

#### Key Design Tradeoffs

1. **Token bucket vs. percentage-based budget.** Google SRE's approach uses a retries-to-requests ratio to cap retry volume (the SRE book describes budget-based approaches in the [handling overload chapter](https://sre.google/sre-book/handling-overload/)). [gRPC](https://github.com/grpc/proposal/blob/master/A6-client-retries.md) and [Linkerd](https://linkerd.io/2019/02/22/how-we-designed-retries-in-linkerd-2-2/) use token buckets. A token bucket is self-contained — it doesn't need to track total request volume, which simplifies the implementation and avoids race conditions in concurrent environments. The tradeoff is that the budget behavior isn't as intuitive: "100 tokens with 0.1 refill per success" is harder to reason about than "10% of traffic can be retries."

2. **Full jitter vs. equal jitter vs. decorrelated jitter.** [AWS's analysis](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/) showed full jitter (random between 0 and the calculated delay) produces the best distribution of retry times. Equal jitter (half fixed + half random) provides a minimum delay guarantee but less spread. I defaulted to full jitter because minimizing correlated retries is the primary goal of this pattern, and full jitter achieves that best.

3. **Error classification at the handler vs. caller.** The handler classifies errors by HTTP status code by default (429, 500, 503 are retryable). This means the caller doesn't need to know retry semantics, but it also means the handler can't distinguish between a 500 that's a transient provider issue and a 500 that's a consistent bug in the request. The `retryableStatuses` config allows callers to override this.

4. **Shared budget vs. per-endpoint budget.** A single token bucket is shared across all callers. This is simpler but means one noisy endpoint can exhaust the budget for all endpoints. The alternative (per-endpoint buckets) adds complexity and memory overhead. For most LLM API setups with 1-3 endpoints, the shared approach is sufficient.

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

| Failure Mode                                                                                                                                                                                                                                                                                                                                                                 | Detection Signal                                                                                                                                                                               | Mitigation                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Budget exhaustion during partial outage** — A subset of requests fail, consuming all budget tokens. Healthy requests that encounter a transient error get zero retries because the budget is empty.                                                                                                                                                                        | `retry_budget_exhausted` counter increasing while `retry_budget_remaining` is at 0. Overall success rate drops below baseline despite provider being partially healthy.                        | Increase `maxTokens` for higher-traffic systems. Consider per-endpoint budgets if one endpoint is significantly noisier than others. Monitor the ratio of budget exhaustion events to total retries.               |
| **Jitter clustering under low traffic** — With few concurrent requests, the randomized jitter can still produce clustered retry times by chance. The thundering herd effect emerges despite jitter.                                                                                                                                                                          | Retry timing histogram shows spikes rather than even distribution. Provider-side rate limit (429) responses cluster in bursts.                                                                 | Increase `initialDelayMs` to spread the retry window wider. At very low traffic (<10 req/min), jitter is less critical — the real risk is budget exhaustion, not thundering herd.                                  |
| **Retry-After header conflict** — The provider returns a `Retry-After: 60` header, but the backoff calculator suggests 2 seconds. Honoring the header means a 60-second wait; ignoring it risks immediate rate limiting.                                                                                                                                                     | Divergence between computed backoff delay and `Retry-After` values in logs. Requests delayed significantly longer than `maxDelayMs`.                                                           | Always honor `Retry-After` when present — the provider has better information about its recovery timeline. Cap the honor at a reasonable maximum (e.g., 120s) to avoid indefinite waits from buggy headers.        |
| **Silent budget drift (silent degradation)** — Over weeks, a gradually increasing provider error rate causes the budget to drain slightly faster than it refills. Retries still happen, but fewer succeed because the budget is chronically low. The system never fully fails — it just gets slowly worse. No alert fires because the retry rate stays within normal bounds. | Week-over-week decrease in `retry_budget_avg_tokens`. Retry success rate declining while first-attempt success rate is stable. The budget hovers near 50% of `maxTokens` instead of near full. | Schedule monthly review of budget utilization metrics. Alert on `retry_budget_avg_tokens` dropping below 60% of `maxTokens` sustained over 24 hours. Compare retry success rate against a 30-day rolling baseline. |
| **Backoff delay exceeding request timeout** — The calculated backoff delay (e.g., 16 seconds on the 4th attempt) plus the request execution time exceeds the caller's overall timeout. The retry never completes — it's abandoned mid-wait.                                                                                                                                  | `retry_timeout_exceeded` events. Retries attempted but never completed. High retry counts with low retry success rates.                                                                        | Set `maxDelayMs` to be less than (caller timeout / maxAttempts). Propagate deadline information from the caller to the retry handler so it can skip retries that can't complete within the remaining time.         |
| **Non-retryable error misclassified as retryable** — A malformed request triggers a 500 instead of the expected 400. The retry handler classifies it as transient and retries it, wasting budget tokens on a request that will never succeed.                                                                                                                                | Specific request IDs appearing in retry logs repeatedly with identical error payloads. Budget consumption rate elevated with no improvement in success rate.                                   | Log the full error response body on retries, not just the status code. Add application-level error classification (e.g., if the error body contains "invalid_request", don't retry regardless of status code).     |

## Observability & Operations

- **Key metrics:**

| Metric                         | Type      | Purpose                                                                                                                           |
| ------------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `retry_attempts_total`         | Counter   | All retry attempts. Segment by status code (429, 500, 503) to see which error types drive the most retries.                       |
| `retry_budget_remaining`       | Gauge     | Current token bucket level. This is the single most important metric for the pattern's health.                                    |
| `retry_budget_exhausted_total` | Counter   | Events where a retry was skipped because the budget was empty. A rising count means the system is under sustained failure.        |
| `retry_success_rate`           | Ratio     | Retries that succeeded vs. total retries attempted. Distinguishes between "retries are helping" and "retries are wasting budget." |
| `retry_delay_ms`               | Histogram | Actual backoff delays. Useful for verifying jitter distribution and detecting Retry-After header influence.                       |
| `first_attempt_success_rate`   | Ratio     | Requests that succeed without any retries. The baseline against which retry value is measured.                                    |

- **Alerting:**

| Level                | Condition                                                                       | Meaning                                                                                          |
| -------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Warning**          | `retry_budget_remaining` below 60% of `maxTokens` sustained for 10 minutes      | Elevated error rates are draining the budget.                                                    |
| **Warning**          | `retry_success_rate` drops below 50% over a 5-minute window                     | Retries are being spent but not recovering requests — the provider may be in a sustained outage. |
| **Critical**         | `retry_budget_exhausted_total` rate exceeds 10/minute                           | The budget is empty and requests are getting zero retries.                                       |
| **Critical**         | `first_attempt_success_rate` drops below 80% sustained for 5 minutes            | The underlying provider is degraded enough to consider circuit breaking.                         |
| **Low-side warning** | `retry_attempts_total` drops to near zero for 30+ minutes during normal traffic | The retry handler may have been bypassed or misconfigured.                                       |

These thresholds are starting points. The right values depend on your baseline error rate, traffic profile, and SLA. Systems with naturally higher error rates (e.g., multi-provider setups) need higher thresholds to avoid alert fatigue.

- **Runbook:**
  - **Budget exhausted alert fires:**
    1. Check `first_attempt_success_rate` — if it's below 70%, the issue is provider-side, not the budget
    2. Check provider status page for active incidents
    3. If provider is healthy, check for a specific endpoint or request pattern causing elevated errors (look at error status code breakdown)
    4. If errors are concentrated on one endpoint, consider per-endpoint budgets or increasing `maxTokens`
    5. If provider is degraded, the budget is working as designed — it's preventing retry amplification. Monitor until provider recovers.
  - **Retry success rate drops below 50%:**
    1. The retries are likely hitting a provider that's still failing. The budget is being spent but not productively.
    2. Check if this is a precursor to full outage — if so, the Circuit Breaker pattern would prevent further waste
    3. Consider temporarily reducing `maxAttempts` to 1 (effectively disabling retries) to reduce wasted API calls
    4. Verify that error classification is correct — are non-retryable errors being retried?

## Tuning & Evolution

- **Tuning levers:**

| Lever                     | Starting Value | When to Adjust                                                                                                                                                                            |
| ------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxAttempts`             | 3              | Increase to 4-5 only if retry success rate is >80% (meaning retries are productive). Decrease to 2 or 1 during sustained incidents to reduce waste.                                       |
| `initialDelayMs`          | 200ms          | Decrease to 100ms if your SLA requires sub-second recovery. Increase to 500ms+ if the provider's recovery time is consistently >1s (check `retry_delay_ms` histogram for patterns).       |
| `maxDelayMs`              | 30,000ms       | Must be less than your caller's timeout divided by `maxAttempts`. If your caller times out at 30s and `maxAttempts` is 3, set this to no more than 10s.                                   |
| `budgetConfig.maxTokens`  | 100            | Scale with traffic. At 100 req/min, 100 tokens is fine. At 10K req/min, consider 1000 tokens.                                                                                             |
| `budgetConfig.tokenRatio` | 0.1            | The refill rate. At 0.1, every 10 successful requests add 1 token. Increase to 0.5+ if you want faster recovery after incidents. Decrease to 0.01 if you want a more conservative budget. |
| `jitterMode`              | `'full'`       | Use `'full'` unless you need guaranteed minimum delays (use `'equal'`). Don't use `'none'` in production.                                                                                 |

- **Drift signals:**
  - Week-over-week increase in `retry_attempts_total` without corresponding traffic growth. Could indicate provider degradation or new error patterns.
  - `retry_budget_remaining` trending downward over days/weeks. The provider's error rate is gradually increasing and the budget is chronically lower than it used to be.
  - Shift in which status codes trigger retries (e.g., more 429s and fewer 503s). Indicates a change in the provider's failure mode — rate limiting instead of server errors.
  - Review every 2-4 weeks. Compare current metrics against the 30-day baseline.

- **Silent degradation:**
  - **Month 3:** The provider has subtly increased their rate limit enforcement. Where you used to see 1% 429s, you're now seeing 3%. The budget is handling it fine — retries still succeed — but the budget is consistently at 70% instead of 95%. No alert fires, but you're spending more budget tokens per day.
  - **Month 6:** A new feature added more LLM calls per user action. Request volume doubled, but `maxTokens` wasn't adjusted. The budget that was sized for 1K req/min is now serving 2K req/min. During the next provider blip, the budget exhausts in half the time, and more requests get zero retries. The fix: increase `maxTokens` proportionally to traffic, or set it as a function of current QPS.
  - **Proactive checks:** Plot `retry_budget_remaining / maxTokens` as a percentage over time. If the 7-day average drops below 80%, investigate. Compare `retry_success_rate` against a 30-day rolling baseline — a 10% drop signals something has changed.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers across GPT-4o, Claude Sonnet, and GPT-4o-mini.

| Scale        | Additional Cost   | ROI vs. No Pattern                                                  |
| ------------ | ----------------- | ------------------------------------------------------------------- |
| 1K req/day   | -$0.13/day saved  | Marginal — savings are real but small (~$4/month on GPT-4o)         |
| 10K req/day  | -$1.23/day saved  | Moderate — ~$37/month on GPT-4o, pays for implementation effort     |
| 100K req/day | -$12.32/day saved | Clear ROI — ~$370/month on GPT-4o, plus incident duration reduction |

## Testing

See test files in `src/ts/__tests__/index.test.ts` and `src/py/tests/test_index.py`.

Run TypeScript tests: `cd src/ts && npm install && npm test`

- **Unit tests:** TokenBucket (capacity, consumption, threshold enforcement, refill, reset), calculateBackoff (jitter modes, exponential growth, max cap), isRetryableError (status code classification, network errors)
- **Failure mode tests:** Budget exhaustion during partial outage, Retry-After header conflict (both honoring and capping), silent budget drift over many requests, non-retryable error classification (400, 401), backoff delay bounded by maxAttempts × maxDelayMs
- **Integration tests:** Full retry flow with 503→success, multi-error sequences (429→503→success), all-retries-exhausted path, onRetry callback verification, budget recovery after drain-then-success cycle

## When This Advice Stops Applying

- **Single-shot scripts or CLI tools** where a human is watching the output and can manually decide whether to retry. The budget mechanism adds complexity that doesn't pay for itself when there's one caller.
- **Extremely low call volumes** (under ~10 requests/minute) where thundering herd is mathematically impossible. If there aren't enough concurrent callers to amplify an outage, a simple retry with backoff is sufficient.
- **Synchronous UIs where the user controls retry timing.** If the user clicks "Retry" manually, they're already acting as the budget — they'll stop retrying when they get frustrated, and they're unlikely to create a coordinated storm.
- **Systems where the provider handles retry coordination server-side.** Some managed LLM gateways ([Portkey](https://portkey.ai/blog/retries-fallbacks-and-circuit-breakers-in-llm-apps/), [LiteLLM](https://docs.litellm.ai/docs/completion/reliable_completions) proxy) implement retry budgets at the gateway layer. If your gateway already caps retries as a percentage of total traffic, adding client-side budgeting creates double-accounting.
- **Idempotent batch jobs where retrying the entire batch is simpler.** If the failure mode is "start over from scratch," per-request retry logic adds complexity without meaningful benefit.
- **When providers become significantly more reliable.** As LLM APIs mature and SLAs tighten, the frequency of transient failures that trigger retries will drop. The budget mechanism still protects against the long tail, but the urgency decreases if your provider's error rate is consistently below 0.01%.

<!-- ## Companion Content

- Blog post: [Retry with Budget — Deep Dive](https://prompt-deploy.com/retry-with-budget) (coming soon)
- Related patterns:
  - [Circuit Breaker](../circuit-breaker/) — stops retries entirely when a provider is confirmed failing. The natural next step after this pattern: retries handle transient failures, circuit breakers handle sustained ones.
  - [Graceful Degradation](../graceful-degradation/) — what to do when retries are exhausted. When the budget is empty and retries can't help, degradation provides the fallback chain.
  - [Token Budget Middleware](../../cost-control/token-budget-middleware/) — caps the financial cost of retries. Complementary: retry budget limits the volume of retries, token budget limits the dollar cost.
  - [Multi-Provider Failover](../multi-provider-failover/) — fails over to a different provider when the primary is down. An alternative to retrying the same provider — sometimes the right answer isn't "try again" but "try somewhere else."
  - [Concurrent Request Management](../../performance/concurrent-request-management/) — manages the concurrency that retry storms disrupt. At high concurrency, unbounded retries compete for connection pool slots. -->

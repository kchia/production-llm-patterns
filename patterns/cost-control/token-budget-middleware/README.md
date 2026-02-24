# Token Budget Middleware

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

Every LLM API call is an open-ended financial commitment. There's no built-in circuit breaker between "code is running" and "money is being spent" — the provider happily processes tokens until the account hits a billing limit or the credit card declines.

The way this actually breaks in production: a POC that costs $500/month during development goes live and the bill rockets to $45,000 by month two. The token math that worked for 50 test users doesn't hold at 5,000 real users with real prompts.

It doesn't take a traffic spike. A single agent stuck in a recursive loop made [47,000 API calls in 6 hours](https://www.aicosts.ai/blog/ai-agent-cost-crisis-budget-disaster-prevention-guide) at $0.03 per call — $1,410 burned on one stuck process. A retry loop without backoff does the same thing faster. And because LLM responses are variable-length, even healthy traffic can produce cost spikes: a prompt that averages 500 output tokens occasionally generates 4,000, and at scale those outliers dominate the bill.

The fundamental issue: without middleware enforcing token budgets, there's nothing between "the code works" and "the invoice arrives." By the time billing alerts fire — if they exist at all — the damage is done. [OpenAI's rate limits](https://platform.openai.com/docs/guides/rate-limits) cap requests per minute, not dollars per day. [Anthropic's usage tiers](https://platform.claude.com/docs/en/about-claude/pricing) cap monthly spend, but at thresholds too high for most teams' budgets. The gap between provider-side limits and application-side budgets is where cost overruns live.

## What I Would Not Do

The first instinct is to set `max_tokens` on every API call and call it done. It's a reasonable starting point — it caps output length per request, which prevents individual responses from ballooning. But it solves maybe 20% of the problem.

`max_tokens` doesn't limit input tokens. A request with a 50,000-token context window still costs what it costs before the model generates a single output token. And it doesn't accumulate — there's no memory between requests. Ten thousand requests each under the `max_tokens` cap can still blow through a daily budget because nothing is tracking the running total. It's a per-request knob, not a budget.

The second attempt is usually a monthly billing alert from the provider. OpenAI and Anthropic both offer spending notifications. The problem: they're lagging indicators. The alert fires after the threshold is crossed, and by the time someone reads the email and takes action, the spend has continued. A runaway loop that burns $500/hour doesn't wait for a human to click "acknowledge" in a dashboard. Daily alerts are better but still reactive — a single runaway job can burn a week's budget overnight.

What's missing in both cases: real-time enforcement at the application layer. Something that knows the running spend, checks it before every request, and rejects or throttles calls that would exceed the budget. Not an alert after the fact — a gate before the spend happens.

## When You Need This

- Monthly LLM spend exceeds $500 and there's no per-request or per-user ceiling enforcing it
- Multiple teams, features, or users share API keys and there's no spend isolation between them
- Agent or RAG workflows chain multiple LLM calls per user action, multiplying cost unpredictably
- There's been at least one surprise bill or near-miss — a spike that nobody caught until the invoice
- The system uses retry logic that could amplify costs during provider errors (retries are invisible spend)
- Batch jobs run unattended overnight and a stuck loop could burn through a day's budget before anyone notices

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **RAG → Required.** Each query typically chains retrieval + generation, sometimes with re-ranking or follow-up calls. The cost per user action is 2-5x what a single LLM call would suggest, and it's hard to estimate upfront because context size varies per query. I wouldn't want to get paged over a cost spike I could've capped with middleware.
- **Agents → Required.** Agents are the worst case for uncontrolled spend. Each reasoning step is an LLM call, tool calls trigger more, and the number of steps isn't fixed. A stuck agent loop is an open-ended billing event. I'd want per-task budget caps before letting any agent run in production.
- **Batch → Required.** Batch jobs process thousands of items unattended. The total cost is items × tokens-per-item, and both can be larger than expected. Without per-job and per-item budgets, a batch run that hits unexpected input sizes or retry storms can burn through a week's budget in a single overnight run.
- **Streaming → Recommended.** Streaming token counts are harder to predict because the output arrives incrementally and can't be pre-validated. But streaming is typically user-initiated and self-limiting — a user waiting for a response naturally caps how many concurrent requests exist. I'd notice the gap over months, not on day one.

## The Pattern

### Architecture

The core idea: a middleware layer that sits between the application and the LLM provider, tracking cumulative token spend across configurable budget windows and rejecting requests that would exceed limits. Every request passes through the budget check before reaching the provider, and every response updates the running total.

```
                    ┌──────────────────┐
                    │  Application     │
                    │  (makes LLM call)│
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │  Token Budget    │
                    │  Middleware       │
                    │                  │
                    │  1. Estimate     │──── over budget? ──→ reject / throttle
                    │     input tokens │
                    │  2. Check budget │
                    │  3. Forward call │
                    │  4. Record usage │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │  Budget Store    │
                    │  (in-memory or   │
                    │   Redis/external)│
                    │                  │
                    │  • window totals │
                    │  • per-key spend │
                    │  • alert state   │
                    └──────────────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │  LLM Provider    │
                    │  (OpenAI, Claude,│
                    │   etc.)          │
                    └──────────────────┘
```

_Thresholds shown (warning at 80%, hard limit at 100%) are starting points — actual values depend on traffic patterns and how much headroom the team wants before enforcement kicks in._

**Core abstraction:** `TokenBudgetMiddleware` — wraps any LLM provider call. Exposes:

- `execute(request, context)` — estimates input tokens, checks budget, forwards if allowed, records actual usage from response
- `getUsage(budgetKey)` — returns current spend for a given budget window
- `getRemainingBudget(budgetKey)` — returns tokens remaining in the current window
- `resetBudget(budgetKey)` — manual reset for operational needs

**Budget keys** support hierarchical enforcement: global → team → user → request. A request can be checked against multiple budget levels, and the most restrictive one wins.

**Configurability:**

| Parameter          | Default            | Description                                              |
| ------------------ | ------------------ | -------------------------------------------------------- |
| `maxTokens`        | 1,000,000          | Maximum tokens per budget window                         |
| `windowDuration`   | `"1d"` (24 hours)  | Budget reset interval                                    |
| `budgetScope`      | `"global"`         | Granularity: `"global"`, `"team"`, `"user"`, `"request"` |
| `warningThreshold` | `0.8` (80%)        | Fraction of budget that triggers warning callbacks       |
| `estimateTokens`   | built-in estimator | Function to estimate input token count before the call   |
| `onBudgetExceeded` | reject with error  | Strategy: `"reject"`, `"throttle"`, `"warn-only"`        |
| `onWarning`        | no-op              | Callback when `warningThreshold` is crossed              |

_These defaults are starting points. SLA requirements, provider pricing, and traffic volume would shift them — a high-volume batch system might want hourly windows, while a low-traffic internal tool might use monthly._

**Key design tradeoffs:**

- **Pre-call estimation vs. post-call accounting only.** Estimating input tokens before the call adds latency (~1ms for character-based estimation) but prevents the "last request that breaks the budget" problem. Post-call-only accounting is simpler but the budget is always exceeded by one request before enforcement kicks in. I'd lean toward pre-call estimation — the extra millisecond is worth the tighter enforcement.
- **In-memory vs. external store.** In-memory is faster (~0.01ms lookups) but doesn't survive restarts and can't coordinate across multiple instances. Redis adds ~1-2ms per check but gives durability and multi-instance consistency. For single-instance deployments, in-memory with periodic snapshots is a reasonable middle ground.
- **Reject vs. throttle on budget exceeded.** Hard rejection is simplest and most predictable — the caller gets a clear error and decides what to do. Throttling (queuing requests until the next window) adds complexity but avoids dropping requests entirely. The default is reject because it's easier to reason about and harder to misconfigure.
- **Token estimation accuracy.** Character-based estimation ([~4 characters per token](https://help.openai.com/en/articles/4936856-what-are-tokens-and-how-to-count-them) for English) is fast but approximate — it can be off by 10-20% for non-English text or code. Provider-specific tokenizers ([tiktoken](https://github.com/openai/tiktoken) for OpenAI, Anthropic's [count_tokens API](https://docs.anthropic.com/en/api/messages-count-tokens)) are accurate but add latency or require network calls. The middleware accepts a custom estimator function so teams can choose their accuracy/speed tradeoff.

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

How this pattern itself can fail. Every solution creates new failure modes.

| Failure Mode                                                                                                                                                                                                                                                                                                                   | Detection Signal                                                                                                                                                                                        | Mitigation                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Token estimation drift** — the estimator under-counts tokens, allowing requests through that actually exceed the budget. Real spend exceeds tracked spend by 15-30%.                                                                                                                                                         | Compare middleware-tracked token counts against provider-reported `usage.total_tokens` in API responses. Alert when the delta exceeds 10% consistently.                                                 | Calibrate the estimator against real provider token counts weekly. Use the provider's tokenizer for high-value requests. Add a safety margin (e.g., 90% of budget as the effective limit).                                                        |
| **Budget store failure** — the in-memory store crashes or Redis becomes unreachable. Budget state is lost, and the middleware either blocks everything (fail-closed) or allows everything (fail-open).                                                                                                                         | Monitor budget store health checks and response latency. Alert on store connection failures or latency spikes above 50ms.                                                                               | Default to fail-open with aggressive alerting — blocking all LLM calls is usually worse than temporarily losing budget enforcement. Persist snapshots periodically so recovery starts from a recent state, not zero.                              |
| **Window boundary race** — multiple requests arrive simultaneously at the moment a budget window resets. Concurrent requests see the old (near-limit) budget, then the window resets and they all proceed, effectively doubling the budget for that boundary period.                                                           | Monitor token usage per window. Alert when any window's total exceeds 110% of the configured limit.                                                                                                     | Use atomic increment operations (or Redis MULTI/EXEC) for budget checks. Accept that a small overshoot (~1 request worth) is unavoidable at window boundaries — size the budget with this margin in mind.                                         |
| **Budget key misattribution** — requests are tagged with the wrong user/team ID, causing one entity's spend to count against another's budget. The wronged team gets blocked while the actual spender continues unchecked.                                                                                                     | Log every budget check with the request's budget key. Alert on budget keys that appear in logs but aren't in the configured key registry.                                                               | Validate budget keys at the middleware boundary. Reject requests with missing or unrecognized keys rather than falling back to a default bucket.                                                                                                  |
| **Silent budget erosion (slow drift)** — token costs change over time as prompts evolve (longer system prompts, more tool schemas, richer context). The budget that was comfortable at launch becomes tight at month three and insufficient at month six. Nobody notices because there's no single spike — just steady growth. | Track average tokens-per-request as a time series. Alert when the 7-day rolling average exceeds the 30-day average by more than 15%.                                                                    | Review token-per-request trends monthly. Set up automated drift alerts. When average request size grows, either increase the budget or optimize prompts — don't wait for the budget to start rejecting legitimate traffic.                        |
| **Over-aggressive rejection** — budget is set too low or estimation overestimates, causing legitimate requests to be rejected when there's actually headroom remaining. Users experience availability problems that look like outages.                                                                                         | Track rejection rate as a percentage of total requests. Alert when rejection rate exceeds 5% in any 5-minute window. Compare rejection rate against actual provider-reported spend to verify alignment. | Start with warn-only mode in production before switching to enforcement. Use the `warningThreshold` callback to catch configuration issues before hard limits trigger. Review rejected requests in logs to confirm they're genuinely over-budget. |

## Observability & Operations

- **Key metrics:**
  - `token_budget.utilization` — current window utilization per budget key (0.0–1.0). The single most important metric. Collect every 60 seconds.
  - `token_budget.tokens_used` — cumulative tokens consumed in the current window, per key. Useful for absolute tracking.
  - `token_budget.rejection_rate` — percentage of requests rejected due to budget exceeded, per 5-minute window.
  - `token_budget.estimation_drift` — ratio of estimated input tokens to actual provider-reported tokens. Track as a time series to catch estimator degradation.
  - `token_budget.window_resets` — count of budget window resets. Should match expected cadence (1/day for daily windows).

- **Alerting:**

  | Level    | Condition                                                                  | Action                                                                            |
  | -------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
  | Warning  | Utilization crosses 80% for any budget key                                 | Review recent traffic, check for unexpected callers or prompt changes             |
  | Warning  | Estimation drift exceeds 15% consistently over 1 hour                      | Recalibrate estimator or switch to provider tokenizer                             |
  | Critical | Rejection rate exceeds 5% in any 5-minute window                           | Either the budget is too tight or there's unexpected traffic — check both         |
  | Critical | Utilization exceeds 100% (overshoot)                                       | Investigate window boundary race or warn-only mode leaking over-budget requests   |
  | Low-side | Utilization suspiciously low (<5% at end of day for a normally active key) | Check if requests are being routed elsewhere or if the budget key mapping changed |

  _These thresholds are starting points. Baseline traffic patterns, SLA tolerance for rejection, and how quickly the team can respond to alerts would shift them._

- **Runbook:**
  - **Budget exceeded alert fires:**
    1. Check which budget key triggered: `getUsage(key)` for current state
    2. Check if it's a legitimate traffic spike or a runaway loop (look at request rate over the last hour)
    3. If runaway: identify the source (user ID, feature, endpoint) and kill the source
    4. If legitimate traffic growth: increase the budget or add per-user limits to spread the load
    5. If budget was misconfigured: adjust and reset with `resetBudget(key)`
  - **Estimation drift alert fires:**
    1. Pull the last hour of estimated vs. actual token counts
    2. Check if the drift is systematic (estimator is consistently 20% low) or sporadic
    3. If systematic: prompts have changed (longer system prompts, more tool schemas). Recalibrate the estimator.
    4. If sporadic: check for unusual input patterns (code, non-English text, very long prompts)
  - **High rejection rate alert fires:**
    1. Check: is the budget genuinely exhausted, or is the estimator overestimating?
    2. Compare `estimation_drift` — if the estimator is 20% high, rejections may be false positives
    3. If genuine: check if traffic volume or per-request token sizes have increased
    4. Short-term fix: switch to warn-only mode while investigating. Long-term: adjust budget.

## Tuning & Evolution

- **Tuning levers:**

  | Parameter          | Effect                                                                                                                                                                                       | Safe Range                         | Dangerous Extreme                                                                                                       |
  | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
  | `maxTokens`        | The primary lever. Start with 2x expected daily usage as headroom. Tighten once traffic patterns stabilize.                                                                                  | 1.5-3x expected daily usage        | <1.1x expected (legitimate traffic gets rejected) or >10x expected (budget doesn't protect against anything meaningful) |
  | `windowDuration`   | Shorter windows (1 hour) catch runaway loops faster but create more frequent resets and boundary artifacts. Longer windows (1 week) smooth out daily variance but react slower to incidents. | 1 hour to 7 days                   | <15 minutes (too many resets, confusing utilization metrics) or >30 days (no protection against multi-day incidents)    |
  | `warningThreshold` | Lower thresholds (0.5) give more advance notice but may cause alert fatigue. Higher thresholds (0.95) give less time to react.                                                               | 0.6–0.9                            | >0.95 (warning fires too close to the limit to act on)                                                                  |
  | `onBudgetExceeded` | Start with `warn-only` in production to measure the budget's accuracy before switching to `reject`. Moving to `reject` without a burn-in period risks blocking legitimate traffic.           | `warn-only` → `reject` (graduated) | `reject` from day one without burn-in                                                                                   |

- **Drift signals:**
  - Average tokens-per-request increasing month-over-month (prompt growth, richer context)
  - Rejection rate climbing gradually without traffic growth (budget too tight for evolving usage)
  - Estimation drift widening (prompt structure has changed, estimator needs recalibration)
  - New budget keys appearing that weren't in the original configuration (new features, new teams)
  - Review cadence: monthly for the first quarter, then quarterly once patterns stabilize.

- **Silent degradation:**
  - **Month 3:** Prompts have grown 20-30% as teams add context, tool schemas, and few-shot examples. The budget that was 2x headroom is now 1.5x. Warning alerts fire occasionally but get dismissed as "normal." Estimation drift has crept to 12% because the estimator was calibrated against simpler prompts.
  - **Month 6:** New features have been added with their own LLM calls but nobody updated the budget allocations. Three teams share a single budget key. The warning threshold fires daily and has been muted. One team's burst traffic regularly pushes another team into rejection territory. The budget middleware is now a source of availability incidents rather than a protection.
  - **What catches it:** Monthly review of tokens-per-request trends, per-key utilization heatmaps, and estimation drift metrics. If any budget key's average utilization exceeds 60% at the monthly review, it's time to either increase the budget or add per-team isolation.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed projections across GPT-4o, Claude Sonnet 4.5, and GPT-4o-mini.

| Scale        | Additional Cost | ROI vs. No Pattern                                                |
| ------------ | --------------- | ----------------------------------------------------------------- |
| 1K req/day   | ~$0/day         | Saves ~$475/mo in prevented runaway incidents                     |
| 10K req/day  | ~$0/day         | Saves ~$475/mo; higher at scale due to larger incidents           |
| 100K req/day | ~$0/day         | Saves ~$3,800/mo; runaway incidents cost $1K+/hour at this volume |

## Testing

See [`src/ts/__tests__/index.test.ts`](src/ts/__tests__/index.test.ts) for the full test suite. Run with `cd src/ts && npm install && npm test`.

- **Unit tests (8):** Token tracking across requests, remaining budget calculation, budget reset, default and custom token estimators, per-user budget isolation, hierarchical parent key tracking, window expiration and reset.
- **Failure mode tests (6):** Budget exceeded rejection (with error details), warn-only strategy passthrough, token estimation drift detection, window boundary reset, warning threshold callback (fires once per window), silent budget erosion (increasing tokens-per-request detection), over-aggressive rejection guard.
- **Integration tests (3):** Full request flow until budget exhaustion (verifies rejection count matches), concurrent user isolation (one user blocked, another works), variable-length response tracking (variance produces different token counts, total matches sum).

## When This Advice Stops Applying

- **Fixed-cost or committed-use contracts.** Some providers offer flat-rate pricing or provisioned throughput where token counts don't affect the bill. Budget middleware adds complexity for no cost benefit — the spend is fixed regardless.
- **Extremely low volume (<100 req/day).** When monthly LLM spend is under $50, the engineering effort of implementing and maintaining budget middleware isn't justified. A monthly billing alert is enough.
- **Self-hosted models with no per-token cost.** If the model runs on owned infrastructure, the marginal cost per token is effectively zero (compute is already paid for). Budget middleware would be solving a problem that doesn't exist — though rate limiting for compute fairness might still matter.
- **Early prototyping and R&D.** When the goal is iteration speed and budget flexibility is expected, adding enforcement gates slows down exploration. The right time to add budget middleware is when the system moves toward production traffic, not during the experimentation phase.
- **Provider-side limits are sufficient.** If the provider's built-in spending caps (like [OpenAI's usage limits](https://platform.openai.com/docs/guides/rate-limits) or [Anthropic's tier ceilings](https://docs.anthropic.com/en/api/rate-limits)) align closely with the team's budget, adding another layer of enforcement may be redundant. This stops being true as soon as the team needs per-user, per-feature, or per-team granularity that the provider doesn't offer.

<!-- ## Companion Content

- Blog post: [Token Budget Middleware — Deep Dive](https://prompt-deploy.com/token-budget-middleware) (coming soon)
- Related patterns:
  - [Graceful Degradation](../../resilience/graceful-degradation/) — when budget is exceeded, degradation tiers provide fallback behavior instead of hard rejection
  - [Cost Dashboard](../cost-dashboard/) (#32, S9) — visualizes the spend data that token budgets generate
  - [Model Routing](../model-routing/) (#13, S4) — routes to cheaper models to stay within budget; often combined with token budgets as a mitigation strategy
  - [Semantic Caching](../semantic-caching/) (#12, S4) — reduces spend by avoiding redundant API calls; lowers effective token consumption per budget window
  - [Latency Budget](../../performance/latency-budget/) (#14, S4) — the performance counterpart to cost budgets, often in tension (cheaper models may be slower) -->

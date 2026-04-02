# Cost Dashboard

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

You're spending money on LLM APIs but can't answer basic questions: Which feature costs the most? Which model is most cost-effective for which task? Is spending trending up or down? Who or what is driving the increase?

The way I think about it: provider dashboards show you aggregate spend by model and day — they tell you *that* GPT-4o spend spiked on Tuesday, not *which* feature, deploy, or user cohort caused it. Without attribution metadata flowing through every LLM call, you're managing costs reactively — panicking at month-end invoices instead of making informed allocation decisions.

The gap becomes acute fast. A mid-size team's LLM bill can reach $47K/month, spread across a support chatbot, document analysis, code generation, and a RAG pipeline — but a single shared API key makes all of it look like one undifferentiated pool of tokens. One undetected prompt regression adding 800 tokens per request, or a retry strategy routing failures to a 16x more expensive model, compounds silently for weeks before anything surfaces. In a real 2025 incident, a developer was billed $67 in two days (against a normal run-rate of under a dollar) because an unvalidated URL parameter let external parties select premium models — discovered only when the OpenAI invoice landed, not when it started.

[Token Budget Middleware](../token-budget-middleware/) enforces limits. This pattern tells you where the money actually goes.

## What I Would Not Do

The naive approach is watching the provider's dashboard and logging token counts in application logs.

Provider dashboards are useful for detecting that something spiked, but they can't tell you *why*. When you have a $47K bill and four features sharing a key, you can identify the model, not the feature. The attribution gap is unbridgeable without instrumentation on your side.

Logging token counts in app logs is slightly better — at least you have raw data — but correlating logs manually is work you'll skip under pressure. No alerting, no trending, no cross-request aggregation. By the time you notice the anomaly, it's been compounding for days.

The specific failure I'd want to avoid: a prompt version ships with an additional 800-token system prompt. Every request gets more expensive immediately, but because token counts are just log lines, nobody notices until the billing cycle ends. The cost-per-version comparison that would catch this in hours requires structured attribution at write time, not log parsing after the fact.

A single API key per environment makes all of this worse — you literally cannot answer "how much does document analysis cost per user?" because the spend data has no owner.

## When You Need This

- Multiple features, models, or user segments share your LLM spend and you can't answer "which feature is driving the increase?"
- You've implemented token budget controls but can't measure whether they're working
- Cost controls reduced your bill — you need to attribute the savings to justify the engineering investment
- You're approaching the threshold where cost optimization decisions (model routing, caching, prompt compression) need data to prioritize
- Leadership or finance needs per-feature or per-team cost attribution for budget allocation
- You've had a billing surprise and want to detect the next one before the invoice arrives

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **RAG → Recommended.** I'd want this once the RAG pipeline is stable — chunking strategies, embedding refresh, and index maintenance all have cost implications (embedding API calls, reprocessing costs) that a dashboard makes visible. Not blocking, but the first time a nightly re-embed job accidentally runs hourly, you'll wish you had it.
- **Agents → Recommended.** Agents generate highly variable token usage — tool call overhead, multi-turn context accumulation, recursive subagent calls. I wouldn't want to run an agent system in production without knowing per-agent-type cost distribution. Undetected agent loops are the canonical "bill went to $47 in two days" scenario.
- **Streaming → Recommended.** Streaming systems tend to be user-facing with predictable per-request patterns, so cost is easier to reason about without a dashboard. Still worth having once you're tuning model selection or adding fallback chains.
- **Batch → Recommended.** Batch jobs are where I'd feel cost dashboards most acutely — long-running jobs at high concurrency with no user waiting to provide feedback if something goes wrong. Per-job cost attribution makes it possible to compare runs, detect regressions, and plan capacity.

## The Pattern

### Architecture

The dashboard sits in two places: a **collection layer** that attaches cost metadata to every LLM response at the call site, and an **aggregation layer** that stores, queries, and surfaces that data.

```
LLM Call Site
     │
     ▼
┌──────────────────────────────────────┐
│         CostTrackingMiddleware       │
│  1. Validate required tags           │
│     (missing? → log + emit to        │
│      "unknown" dimension)            │
│  2. Execute provider request         │
│  3. Compute cost: tokens × price     │
│     table (refreshed hourly)         │
│  4. Emit CostEvent                   │
└────────────────┬─────────────────────┘
                 │ CostEvent
      ┌──────────┴──────────┐
      │                     │
      ▼                     ▼ (side-channel)
┌──────────────┐     ┌──────────────────┐
│  SpendStore  │     │   AlertEngine    │
│  raw events  │     │  spike detect /  │
│  + rollups   │     │  concentration / │
│  + indexes   │     │  threshold check │
└──────┬───────┘     └────────┬─────────┘
       │                      │
       ▼                      ▼
┌──────────────┐     ┌──────────────────┐
│   QueryAPI   │     │  Notifications   │
│  group_by:   │     │  (alert channel) │
│  feature /   │     └──────────────────┘
│  model /     │
│  user /      │
│  version     │
└──────────────┘
```

> Numeric thresholds shown in the diagram (spike multipliers, alert percentages) are illustrative. Actual values depend on your baseline spend, SLA, and traffic profile.

### Core Abstraction

```typescript
interface CostEvent {
  timestamp: Date;
  requestId: string;
  feature: string;           // mandatory — attribution breaks without this
  model: string;
  promptVersion: string;
  userId?: string;
  teamId?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  tags: Record<string, string>;  // extensible for future dimensions
}

interface CostDashboard {
  // Record a completed LLM request
  record(event: CostEvent): Promise<void>;

  // Query spend aggregated by dimension
  query(params: {
    groupBy: 'feature' | 'model' | 'user' | 'promptVersion' | 'team';
    startTime: Date;
    endTime: Date;
    filters?: Partial<Pick<CostEvent, 'feature' | 'model' | 'userId'>>;
  }): Promise<SpendSummary[]>;

  // Compute cost from token counts using current price table
  computeCost(model: string, inputTokens: number, outputTokens: number): number;

  // Detect spend anomalies (spike, concentration risk)
  checkAlerts(config: AlertConfig): Promise<Alert[]>;
}
```

### Configurability

| Parameter | Default | What It Affects |
|---|---|---|
| `priceRefreshIntervalMs` | `3_600_000` (1h) | How often model prices are fetched from source. Staleness leads to cost miscalculation. |
| `spikeSensitivity` | `2.5` | Multiplier over rolling baseline before a spike alert fires. Lower = more alerts. |
| `concentrationRiskThreshold` | `0.40` | Fraction of total spend from one dimension before a concentration alert fires. |
| `retentionDays` | `90` | How long raw cost events are kept before rollup/deletion. Longer = more storage cost. |
| `requiredTags` | `['feature']` | Tags that must be present on every event. Missing tags fail loudly rather than silently polluting dimensions. |
| `rollupIntervalMinutes` | `60` | Granularity of pre-aggregated time buckets. Finer = more storage, faster queries. |

> These are starting points. The right spike sensitivity depends on your baseline variance — a system with noisy traffic needs a higher threshold than one with stable daily patterns.

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

| Failure Mode | Detection Signal | Mitigation |
|---|---|---|
| **Missing attribution tags** — requests recorded with no `feature` or `userId`, polluting `unknown` dimension | `unknown` dimension grows as a share of total spend; alertable if `unknown` > X% | Enforce required tags at middleware level — fail loudly (log + counter-increment) on missing tags rather than silently recording to `unknown` |
| **Stale price table** — model prices changed but dashboard still uses old values; cost calculations diverge from actual bill | Dashboard total vs. provider invoice diverges by >5% at month-end reconciliation | Refresh prices periodically from a versioned source; alert on refresh failures; show "price last updated" timestamp prominently in UI |
| **Spike alert fatigue** — threshold set too low for actual traffic variance, generating constant noise | Alert channel floods; on-call starts ignoring cost alerts | Tune sensitivity per-dimension rather than globally; use rolling baseline (7d) rather than fixed absolute threshold |
| **Test traffic contaminating production metrics** — dev/staging requests recorded to the same store | Dashboard shows inflated spend; per-user metrics are meaningless | Tag requests with `environment` at middleware level; partition storage or filter at query time; make test traffic opt-out impossible by default |
| **Shared credentials destroying attribution** — multiple services use one API key; no way to separate spend | All spend appears under single undifferentiated pool in provider dashboard | One API key per service/team; enforce at infrastructure level, not application level |
| **Silent price drift** (the 6-month failure) — model prices drop or provider introduces a cheaper alias, but the dashboard uses hardcoded prices; teams optimize away cheap usage and leave expensive usage untouched | Dashboard cost totals diverge from invoice by an increasing percentage over months; optimization decisions based on stale data are wrong | Automate price table refresh and alert on stale data; reconcile dashboard totals against provider invoice monthly |
| **Rollup gap on restart** — service restarts during rollup window; events in the gap are counted in raw store but missed by pre-aggregation | Dashboard totals < raw event sum for a window around the restart | Make rollup idempotent — reprocess windows on startup; use an at-least-once event pipeline |
| **Dimension explosion** — high-cardinality tags (e.g., per-request IDs as `userId`) cause storage and query performance to degrade | Query latency increases; storage costs climb month-over-month | Validate tag cardinality at ingestion; cap unique values per dimension; document that `userId` should be a real user ID, not a session ID |

## Observability & Operations

**Key metrics:**

| Metric | Unit | What It Signals |
|---|---|---|
| `cost_dashboard.events_recorded_total` | count | Volume of requests being tracked — drop signals middleware bypass |
| `cost_dashboard.missing_tag_total{tag}` | count | Attribution quality — should trend to zero after instrumentation is complete |
| `cost_dashboard.price_table_age_seconds` | seconds | Data freshness — alert if > 2h (refresh failed) |
| `cost_dashboard.rollup_lag_seconds` | seconds | Aggregation health — should be < 5min in normal operation |
| `cost_dashboard.spend_usd_total{feature,model}` | USD | Primary business metric — watch for unexpected jumps |
| `cost_dashboard.alert_fired_total{type}` | count | Alert system health — sustained zero may indicate thresholds too high |
| `cost_dashboard.query_latency_p99_ms` | ms | Query API health — alert if > 500ms (index degradation or data volume issue) |

**Alerting:**

| Alert | Warning | Critical | First Check |
|---|---|---|---|
| Spend spike | >2x rolling 7d baseline for any dimension | >5x baseline | Check if new feature shipped, prompt version changed, or retry strategy changed |
| Price table stale | Last refresh > 1h ago | Last refresh > 6h ago | Check price fetch job logs; verify external price source is reachable |
| Missing tags | `unknown` dimension > 10% of total spend | `unknown` > 25% | Find call sites not passing required tags; check recent deploys |
| Rollup lag | Lag > 10min | Lag > 30min | Check store write throughput; look for lock contention on rollup job |
| Concentration risk | One dimension > 40% of spend | One dimension > 60% | Expected if one feature dominates — verify it's intentional and budgeted |

> These thresholds are starting points. A system where one feature legitimately dominates spend (e.g., a product with one primary use case) needs higher concentration thresholds.

**Runbook:**

1. **Spend spike fires**: Check `cost_dashboard.spend_usd_total` broken by `feature`, then `model`, then `promptVersion`. Identify the dimension that spiked. Cross-reference with recent deploys (prompt version registry) and traffic volume. If spend/request went up (not just request count), suspect a prompt regression. If request count went up, suspect a traffic or retry issue.
2. **Price table stale**: Check logs for price fetch errors. Manually trigger a refresh if the fetch job is healthy. If external source is unreachable, the dashboard continues with stale prices — add a banner to the UI flagging data may be inaccurate.
3. **Missing tags alert**: Pull a sample of recent events with `feature = unknown`. Identify the call site from `requestId` + application logs. Add the required tag to that call site and deploy.
4. **Dashboard vs. invoice diverges**: Run the monthly reconciliation query (total `costUsd` from raw events vs. provider invoice). If the gap is >5%, check price table version history for the billing period. Recalculate with correct prices for the affected window.

## Tuning & Evolution

**Tuning levers:**

| Lever | Safe Range | Dangerous Extreme | Effect |
|---|---|---|---|
| `spikeSensitivity` | 2.0–4.0 | < 1.5 | Below 1.5, every natural traffic variance triggers an alert — on-call fatigue within a week |
| `concentrationRiskThreshold` | 0.30–0.60 | < 0.20 | Below 0.20, fires constantly in single-dominant-feature products |
| `rollupIntervalMinutes` | 15–60 | < 5 | Sub-5-minute rollups with high event volume cause lock contention and write amplification |
| `retentionDays` | 30–180 | > 365 | Long retention requires archival strategy; raw event storage grows linearly with traffic |
| `priceRefreshIntervalMs` | 1h–24h | > 72h | Beyond 72h, cost calculations diverge from actual bills during periods of provider pricing changes |

**Drift signals:**

- Dashboard totals diverge from provider invoice by > 3% — price table is stale or model aliases have changed
- `unknown` dimension grows month-over-month — new call sites added without attribution
- Query latency increases without traffic growth — index fragmentation or dimension explosion
- Alert volume drops to near-zero without spend dropping — thresholds have drifted above actual variance

Review configuration quarterly, or after any: provider price change, major feature launch, or model change.

**Silent degradation:**

At Month 3, the price table is still using prices from the launch configuration. Two models were repriced by the provider — one 40% cheaper, one 15% more expensive. The dashboard shows the wrong relative costs for both, so model routing decisions based on dashboard data are suboptimal. Nobody notices because the dashboard numbers *look* plausible and no alert threshold is tied to invoice reconciliation.

At Month 6, three new features shipped without `feature` attribution tags. The `unknown` dimension now accounts for 22% of spend. Reports to leadership on per-feature cost attribution are understating actual costs for those features by 22%. No alert fires because the missing-tag threshold was set at 25%.

The proactive check: monthly, run a reconciliation comparing dashboard totals to the provider invoice, and check the `unknown` dimension share. Both should be near zero and drifting toward zero over time, not away from it.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers.

| Scale | Additional Cost | ROI vs. No Pattern |
|---|---|---|
| 1K req/day | +$0.09/day | Dashboard infrastructure exceeds LLM spend for most workloads at this scale — defer until spend justifies it |
| 10K req/day | +$0.15/day | Marginal infrastructure cost; optimization decisions enabled by the dashboard (model routing, caching) deliver 2–10x payback |
| 100K req/day | +$0.25/day | Infrastructure cost is <0.1% of LLM spend at this scale; cost visibility is table stakes for any optimization initiative |

## Testing

See test files in `src/ts/__tests__/` and `src/py/tests/`.

- **Unit tests:** `computeCost()` with known token counts and price tables; tag validation (required tags present/absent); rollup aggregation correctness; `groupBy` query returns correct dimension sums
- **Failure mode tests:** Missing tag emits to `unknown` and increments counter; stale price table detected and flagged; spike alert fires at configured threshold; test-traffic tag prevents contamination of production rollups
- **Integration tests:** Full flow — middleware records event → store persists → query API returns correct aggregation → alert engine evaluates threshold; concurrent write test (10 goroutines/workers, verify totals are consistent)

Run tests: `cd src/ts && npm test` / `cd src/py && python -m pytest`

## When This Advice Stops Applying

- Single-feature systems with one model where cost is fully predictable from request volume — a dashboard adds infrastructure complexity without insight
- Pre-production systems with no real spend — instrument the attribution code now, but defer the aggregation/dashboard infrastructure until you have real data to show
- Budgets under ~$100/month — the engineering time to build and maintain this pattern costs more than the visibility is worth at that scale; use provider dashboard + a weekly manual check
- Organizations already running comprehensive cloud cost management platforms that natively track LLM API spend at feature/team granularity — check whether the platform already provides what you'd build here before adding another system

## Companion Content

- Blog post: [Cost Dashboard — Deep Dive](https://prompt-deploy.com/cost-dashboard) (coming soon)
- Related patterns:
  - [Token Budget Middleware](../token-budget-middleware/) — generates the per-request token counts the dashboard records; implement this first
  - [Model Routing](../model-routing/) — dashboard surfaces per-model cost-effectiveness, informing routing decisions
  - [Semantic Caching](../semantic-caching/) — dashboard shows cache hit savings vs. cache miss costs
  - [Structured Tracing](../../observability/structured-tracing/) — traces carry the cost metadata the dashboard aggregates; cost events and trace spans share the same `requestId`

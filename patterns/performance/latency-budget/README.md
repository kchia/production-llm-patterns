# Latency Budget

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

LLM calls are slow — typically 1–10 seconds each for popular models, depending on model size, prompt length, and provider load. In a multi-step pipeline, those latencies compound unpredictably. A RAG pipeline with retrieval (~100–500ms), re-ranking (~200ms), generation (~2–8s), and guardrail validation (~100–300ms) can easily blow past a 3-second SLA — and without a budget, there's no mechanism to know _which_ step to cut or when to switch strategies mid-request.

The real damage isn't a single slow request. It's what happens at scale: if your p50 is 500ms but your p99 is 4 seconds, 1 in 100 users experiences terrible performance. Users lose their sense of uninterrupted flow after [1 second, and attention drops significantly by 10 seconds](https://www.nngroup.com/articles/response-times-3-important-limits/). Without a latency budget propagating through the pipeline, every step runs to completion even when the overall deadline is already blown — wasting compute, burning API spend, and returning responses to users who've already left.

[gRPC](https://grpc.io/blog/deadlines/) solved this years ago with deadline propagation: an absolute timestamp attached at the edge and decremented through each downstream hop. LLM pipelines face the same problem but rarely apply the same discipline. The result is pipelines that work fine at p50 and silently violate SLAs at p99.

## What I Would Not Do

The first instinct is per-step timeouts — set a 2-second timeout on the retrieval step, a 5-second timeout on generation, and so on. It's simple and feels safe.

It breaks for two reasons. First, static timeouts don't account for variability between steps. If retrieval finishes in 50ms, that surplus should be available to generation — but with static timeouts, it's wasted. Second, per-step timeouts don't compose: five steps each with a "reasonable" 2-second timeout gives you a 10-second worst case, which might be 3x your actual SLA.

The subtler failure is that static timeouts can't make tradeoff decisions. When you're 2.5 seconds into a 3-second budget, the right move might be to skip re-ranking and go straight to generation with a faster model. Per-step timeouts have no concept of "remaining budget" — each step operates in isolation, unaware of how much time the overall request has already consumed.

At 10K+ requests/day, this isolation creates a pattern where tail latency creeps up without any single step appearing slow. Every step is "within its timeout," but the aggregate consistently misses the SLA.

## When You Need This

- Your pipeline has 3+ sequential steps and a user-facing latency SLA
- p99 latency exceeds your SLA even though individual step p50s look fine
- Tradeoff decisions mid-request (skip re-ranking, use a faster model, truncate context) depend on knowing how much time budget remains
- Provider latency variance is high — the same model call takes 800ms at p50 but 4s at p99
- Cost is climbing because slow requests still run expensive steps that produce results nobody waits for

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **Streaming → Critical.** Users are watching tokens arrive in real time. If the pipeline can't start streaming within ~1 second, the experience feels broken. I'd want a latency budget enforcing that the generation step starts within a hard ceiling, even if that means skipping earlier enrichment steps.
- **RAG → Required.** Multi-step retrieval chains (embed → search → rerank → generate → validate) are the classic case for budget propagation. I wouldn't be comfortable getting paged for SLA violations without knowing which step consumed the time.
- **Agents → Recommended.** Agent loops are inherently variable — tool calls, reasoning steps, retries. A latency budget helps cap total execution time, though loop guards (pattern #17) handle the runaway case more directly.
- **Batch → Optional.** No user is waiting. Throughput and cost matter more than wall-clock time per request. A latency budget adds overhead without meaningful benefit unless individual items have downstream time constraints.

## When This Advice Stops Applying

- Batch processing where latency isn't user-facing and throughput matters more than wall-clock time per request
- Async workflows where responses are delivered later (email, notifications, queued processing) — the "deadline" is hours, not seconds
- Internal tools with no SLA where users accept variable response times and the cost of adding budget tracking outweighs the benefit
- Single-step LLM calls where there's no pipeline to budget across — a simple prompt → response has nothing to propagate
- Systems where every step is already fast and stable (sub-100ms variance) — the budget machinery adds complexity without changing outcomes
- Early-stage systems with <100 req/day where tail latency isn't yet a meaningful problem — instrument first, budget later

## The Pattern

### Architecture

The core idea is borrowed from [gRPC's deadline propagation](https://grpc.io/docs/guides/deadlines/): attach an absolute deadline to the request at the edge, then pass the remaining budget into each pipeline step. Each step can query how much time remains and make decisions accordingly — skip optional work, switch to a faster model, or abort early.

```
 Request
   │
   ▼
 ┌──────────────────────────────────────────┐
 │  1. Budget Init                          │
 │  deadline = now + totalBudgetMs          │
 └────────────────────┬─────────────────────┘
                      │
                      ▼
 ┌──────────────────────────────────────────┐
 │  2. Retrieval         remaining: 2800ms  │
 │  execute (required)                      │
 └────────────────────┬─────────────────────┘
                      │ elapsed: 200ms
                      ▼
 ┌──────────────────────────────────────────┐
 │  3. Re-ranking        remaining: 2600ms  │
 │  budget < threshold? ──→ SKIP            │
 └────────────────────┬─────────────────────┘
                      │ elapsed: 400ms
                      ▼
 ┌──────────────────────────────────────────┐
 │  4. Generation        remaining: 2400ms  │
 │  select model by remaining budget        │
 └────────────────────┬─────────────────────┘
                      │ elapsed: 2200ms
                      ▼
 ┌──────────────────────────────────────────┐
 │  5. Validation        remaining: 600ms   │
 │  budget < minBudgetMs? ──→ SKIP          │
 └────────────────────┬─────────────────────┘
                      │
                      ▼
 Response
   │
   ▼
 [Metrics: per-step timing, budget %, skips]
```

_Numerical values in the diagram are illustrative — actual timings depend on your provider, model, and pipeline configuration._

**Core abstraction:**

```typescript
interface LatencyBudget {
  /** Absolute deadline timestamp (ms since epoch) */
  readonly deadline: number;

  /** Milliseconds remaining until deadline */
  remaining(): number;

  /** Milliseconds elapsed since budget creation */
  elapsed(): number;

  /** Whether the deadline has passed */
  isExpired(): boolean;

  /** Create a child budget with a tighter deadline (capped at parent's) */
  child(maxMs: number): LatencyBudget;
}

interface PipelineStep<TInput, TOutput> {
  /** Execute the step, receiving the remaining budget */
  execute(input: TInput, budget: LatencyBudget): Promise<TOutput>;

  /** Minimum budget (ms) this step needs to produce useful output */
  minBudgetMs: number;

  /** Whether this step can be skipped under budget pressure */
  optional: boolean;
}
```

**Configurability:**

| Parameter             | Default           | Description                                                                     |
| --------------------- | ----------------- | ------------------------------------------------------------------------------- |
| `totalBudgetMs`       | 3000              | Total request deadline in milliseconds                                          |
| `reserveMs`           | 200               | Time reserved for response serialization and network                            |
| `steps[].minBudgetMs` | 100               | Minimum budget a step needs to run                                              |
| `steps[].optional`    | false             | Whether the step can be skipped under pressure                                  |
| `steps[].timeoutMs`   | none              | Per-step hard ceiling (capped at remaining budget)                              |
| `onBudgetExhausted`   | `'skip-optional'` | Strategy when budget runs low: `'skip-optional'`, `'abort'`, or `'best-effort'` |
| `adaptiveModel`       | none              | Map of budget thresholds to model selections for generation steps               |

_These defaults are starting points. The right values depend on your SLA, provider latency characteristics, and how many pipeline steps you're running._

**Key design tradeoffs:**

1. **Absolute deadline vs. per-step budgets.** I'd use an absolute deadline (like gRPC) rather than allocating fixed budgets per step. Absolute deadlines let fast steps donate surplus time to slow steps. The tradeoff: steps can't plan ahead without querying the budget, so every step needs budget awareness.

2. **Skip vs. abort vs. degrade.** When budget runs low, there are three options: skip optional steps, abort the entire request, or degrade quality (faster model, shorter context). Skipping is safest but loses enrichment. Aborting is cleanest but wastes all prior compute. Degrading is most user-friendly but adds implementation complexity. The default (`skip-optional`) balances simplicity with utility.

3. **Budget checking granularity.** Checking budget only at step boundaries is simple but can't interrupt a slow LLM call mid-stream. Checking within steps (e.g., watching for timeout during generation) adds complexity but catches the biggest latency contributor. I'd start with step-boundary checks and add intra-step timeout wrapping only for the generation step.

4. **Clock source.** Monotonic clocks (`performance.now()` / `process.hrtime()`) prevent issues from system clock adjustments but can't be compared across machines. For single-process pipelines this is fine; for distributed pipelines, you'd propagate a timeout duration (like gRPC does) rather than an absolute timestamp.

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

Every solution creates new failure modes. Here's what the latency budget pattern introduces:

| Failure Mode                                                                                                                                                                                                                                                                                                     | Detection Signal                                                                                                                                        | Mitigation                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Budget too tight** — legitimate requests consistently exhaust budget and skip important steps, degrading output quality                                                                                                                                                                                        | High skip rate (>20% of requests skip non-optional steps); rising `budget_exhausted` metric with low actual SLA violations                              | Increase `totalBudgetMs` or reclassify steps. Track skip rate per step to identify which steps are being starved. Review whether the SLA itself is realistic for the pipeline depth.                                  |
| **Budget too loose** — deadline is so generous it never triggers, making the pattern dead weight that adds overhead without value                                                                                                                                                                                | Budget utilization consistently <50%; zero skip events over weeks; p99 latency well below budget                                                        | Tighten `totalBudgetMs` to ~1.2x your current p95. The budget should be an active constraint, not a theoretical ceiling.                                                                                              |
| **Cascading skips** — one slow step consumes most of the budget, causing all downstream optional steps to be skipped, even though those steps are what make the output useful                                                                                                                                    | Multiple consecutive steps skipped in the same request; output quality metrics drop while SLA compliance looks healthy                                  | Add per-step hard ceilings (`timeoutMs`) to prevent any single step from consuming the entire budget. Cap the generation step specifically — it's the most variable.                                                  |
| **Budget check overhead** — in very high-throughput systems (>10K req/s), the per-step budget checking and metrics emission adds measurable latency                                                                                                                                                              | p99 latency increases after adding budget tracking; profiler shows budget-related code in hot path                                                      | Use monotonic clock reads (cheap, ~ns) not Date.now(). Batch metrics emission. Budget overhead should be <0.1ms per step — if it's more, something's wrong.                                                           |
| **Silent quality degradation (6-month failure)** — provider latency slowly increases over months, causing the budget to skip optional steps more frequently. SLA compliance stays green, but output quality silently drops because enrichment steps are being skipped 40% of the time instead of the original 5% | No alert fires because SLA is met. Skip rate drifts upward so gradually that weekly reviews miss it. Quality metrics (if they exist) show slow decline. | Track skip rate as a first-class metric with its own alert threshold. Review monthly: if skip rate has doubled from baseline, either the provider got slower or traffic patterns changed. Both warrant investigation. |
| **Stale budget after retry** — a retry budget pattern retries a failed step, but the latency budget wasn't updated to account for the time already spent. The retry runs with a budget that's already expired or nearly expired.                                                                                 | Retried requests have unusually high `DEADLINE_EXCEEDED` rates; retry success rate drops over time while non-retry success rate stays stable            | Integrate with retry budget: pass the _current_ remaining budget to retries, not the original. If remaining budget is below the step's `minBudgetMs`, don't retry — fail fast.                                        |

## Observability & Operations

**Key metrics:**

| Metric                                   | Description                                                                                                             | Healthy Range                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `latency_budget.utilization`             | Fraction of budget consumed per request (histogram)                                                                     | 0.5–0.9. Below 0.5 means budget is too loose; above 1.0 means deadline exceeded. |
| `latency_budget.step_skip_rate`          | Fraction of requests where each step was skipped (per step name). Track as a time series to catch drift.                | <15% for optional steps; 0% for required steps                                   |
| `latency_budget.deadline_exceeded_rate`  | Fraction of requests where the overall deadline was blown despite the budget pattern. This is the SLA violation metric. | <5%                                                                              |
| `latency_budget.step_elapsed_ms`         | Per-step latency histogram (p50/p95/p99). Identify which step is consuming the most budget.                             | Within step's `minBudgetMs`–`timeoutMs` range                                    |
| `latency_budget.remaining_at_step_start` | Budget remaining when each step begins. Shows how budget flows through the pipeline.                                    | Decreasing but >0 at each step                                                   |

**Alerting:**

| Severity | Condition                                     | Action                                                                                                                           |
| -------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Warning  | skip rate > 15% (sustained 5 min)             | Optional steps are being skipped more than expected. Investigate whether provider latency increased or traffic patterns shifted. |
| Warning  | budget utilization < 0.3 (sustained 1 hr)     | Budget is too loose to be useful. Tighten `totalBudgetMs`.                                                                       |
| Critical | deadline_exceeded_rate > 5% (sustained 5 min) | SLA is being violated. Check per-step timings to find the bottleneck.                                                            |
| Warning  | skip rate doubled from 7-day baseline         | Silent quality degradation in progress. Compare current provider latency to historical.                                          |

_These thresholds are starting points. The right values depend on your baseline skip rate, SLA strictness, and traffic profile._

- **Runbook:**
  - **deadline_exceeded alert fires:** Check `step_elapsed_ms` per step. Identify the step consuming the most time. If it's the generation step, check provider status page. If it's retrieval, check vector DB latency. If multiple steps are slow, check for system-wide issues (CPU, memory, network).
  - **skip_rate alert fires:** Pull `remaining_at_step_start` for the skipped step. If remaining budget is consistently <50ms when that step starts, either the upstream step got slower or the overall budget needs increasing. Cross-reference with provider latency dashboards.
  - **utilization too low:** No immediate action needed, but schedule a config review. Tighten `totalBudgetMs` to ~1.2x your current p95 to make the budget an active constraint.

## Tuning & Evolution

**Tuning levers:**

| Parameter             | Safe Range                                | Dangerous Extreme                                                                 | Description                                                                                                                                 |
| --------------------- | ----------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `totalBudgetMs`       | 1.1x–2.0x your p95 latency                | Below p50 (everything skips) or above 10x p95 (never activates)                   | The primary knob. Set to your SLA minus a safety margin.                                                                                    |
| `reserveMs`           | 50–500ms                                  | Too low and the response doesn't make it back; too high and you're wasting budget | Time reserved for serialization and network.                                                                                                |
| `steps[].minBudgetMs` | 0.5x–1.0x the step's p50                  | Below 0.5x and the step will fail most times it runs                              | Per-step floor. Set based on the step's p50 latency.                                                                                        |
| `steps[].optional`    | Start conservative (fewer optional steps) | All steps optional (nothing is guaranteed in output)                              | Which steps can be skipped. Expand as you understand the quality impact of skipping each step.                                              |
| `onBudgetExhausted`   | `'skip-optional'` for most systems        | `'best-effort'` without quality monitoring                                        | Strategy selection. `'abort'` for latency-critical streaming; `'best-effort'` only if you'd rather have a slow response than a partial one. |

- **Drift signals:**
  - Skip rate trending upward over weeks → provider latency is increasing or traffic patterns changed
  - Budget utilization trending toward 1.0 → pipeline is getting slower; review step-level metrics
  - New pipeline steps added without updating `totalBudgetMs` → budget becomes artificially tight
  - Review configuration quarterly or after any pipeline change (new step, model change, provider switch)

- **Silent degradation:**
  - **Month 3:** Provider latency has crept up 20% since deployment. Skip rate for the re-ranking step has gone from 5% to 15%. No alert fires because the SLA is still met. Output quality is subtly worse — users aren't complaining yet, but relevance metrics show a slow decline.
  - **Month 6:** A new pipeline step was added (guardrail check) without adjusting `totalBudgetMs`. The budget is now effectively 500ms tighter. Skip rate jumps to 30% but it's "working as designed" — the budget is protecting the SLA. Meanwhile, the team wonders why output quality dropped. The fix: increase `totalBudgetMs` to account for the new step, and set an alert on skip rate drift.
  - **Proactive check:** Monthly, compare current skip rate to the first-week baseline. If it's 2x or higher, investigate. Also compare per-step p50 latency to the values used when setting `minBudgetMs` — if the step got slower, the threshold needs updating.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed projections across three models.

| Scale        | Additional Cost | ROI vs. No Pattern                                                        |
| ------------ | --------------- | ------------------------------------------------------------------------- |
| 1K req/day   | −$0.17/day      | Saves ~$5/mo by skipping wasted LLM calls on tail-latency requests        |
| 10K req/day  | −$1.70/day      | Saves ~$51/mo; covers integration effort within first month               |
| 100K req/day | −$17.00/day     | Saves ~$510/mo; significant at scale from avoided abandoned-request spend |

## Testing

See test files in `src/ts/__tests__/index.test.ts`. Run with `cd src/ts && npm test`.

- **Unit tests (10):** LatencyBudget time tracking, expiration, utilization, child budget capping. PipelineStep execution, skip-on-low-budget, child budget with timeoutMs, optional error handling, required error propagation. Pipeline config defaults, step chaining, metrics callback.
- **Failure mode tests (6):** Budget too tight (optional steps skipped), budget too loose (zero skips, low utilization), cascading skips (one slow step starves downstream), budget check overhead (<0.01ms per operation), silent quality degradation (skip rate rises with provider latency drift), stale budget after retry (remaining budget reflects elapsed time).
- **Integration tests (3):** Full 4-step RAG pipeline end-to-end with mock provider, abort strategy, concurrent pipeline executions with independent budgets.
- **What to regression test:** Skip rate changes when modifying step thresholds; budget propagation through child budgets; metrics accuracy under concurrent load.

## Companion Content

- Blog post: [Latency Budget — Deep Dive](https://prompt-deploy.com/latency-budget) (coming soon)
- Related patterns:
  - [Token Budget Middleware](../../cost-control/token-budget-middleware/) — the cost counterpart to latency budgets; often in tension (cheaper models are slower)
  - [Concurrent Request Management](../concurrent-request-management/) — parallelism is a tool for staying within latency budgets
  - [Streaming Backpressure](../streaming-backpressure/) — manages latency at the response delivery layer
  - [Multi-Provider Failover](../../resilience/multi-provider-failover/) — failover latency counts against the budget
  - [Semantic Caching](../../cost-control/semantic-caching/) — cache hits dramatically improve latency
  - [Circuit Breaker](../../resilience/circuit-breaker/) — interacts with budgets by fast-failing when a provider is down

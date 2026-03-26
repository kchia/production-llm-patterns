# State Checkpointing

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

Long-running LLM workflows fail partway through — API timeouts, rate limits, provider outages, process crashes. Without checkpointing, you restart from scratch, re-running every LLM call you already paid for. For a 10-step agent workflow, a failure at step 8 means paying for steps 1–7 again on the retry.

The cost spiral can be severe. One [documented case from ZenML's survey of 1,200 production deployments](https://www.zenml.io/blog/what-1200-production-deployments-reveal-about-llmops-in-2025) showed weekly API costs escalating from `$127` to `$47,000` over four weeks — driven by an infinite conversation loop between agents that ran undetected for 11 days. That was an infinite loop rather than a restart-on-failure scenario, but the root cause is the same: no durable state meant no recovery boundary. The agents just kept going.

On batch pipelines the math is starker. [Alibaba's analysis of large-scale LLM training infrastructure](https://arxiv.org/abs/2401.00134) documented a 43.4% failure rate on the top 5% most resource-intensive jobs — with hardware faults driving 37% of those failures. Without per-step checkpointing, nearly half your jobs pay for their own funeral twice.

The subtler version shows up in agent systems during network hiccups. A multi-minute agent execution gets interrupted mid-way by a dropped connection. Without persistent state, the only option is full restart — which re-runs the completed steps, potentially produces different outputs (non-deterministic LLM calls), and fails again at the same connection boundary if the underlying cause isn't fixed. This pattern [shows up repeatedly in production agent systems](https://www.zenml.io/blog/the-agent-deployment-gap-why-your-llm-loop-isnt-production-ready-and-what-to-do-about-it) — agents can't recover from connection drops because no state exists to resume from.

## What I Would Not Do

The first instinct is to reach for: write completed step outputs to a database inside the workflow function. Something like:

```
result_1 = await llm.complete(step_1_prompt)
await db.save("step_1", result_1)
result_2 = await llm.complete(step_2_prompt)
await db.save("step_2", result_2)
```

This looks like checkpointing but breaks in three important ways:

**It doesn't handle the failure case.** When the workflow crashes at step 8, the retry logic still starts at step 1. The saves are in the database, but nothing reads them back. Adding "check if step N result exists before running" to each step turns a 10-step workflow into 10 bespoke if-else branches — and that logic diverges from the actual workflow logic over time.

**It conflates storage with resumption.** Knowing what completed is different from knowing _how to continue_. Step 3's output might depend on step 1 and step 2 both being complete. If step 2 wrote successfully but step 3 was mid-execution when the crash happened, you need to know step 3's pre-conditions, not just step 2's output. Ad-hoc saves don't capture this.

**It doesn't handle partial step failures.** If an LLM call times out after 25 seconds with no response, you don't have an output to save. The step didn't complete. You have no signal to distinguish "step 3 timed out" from "step 3 never ran." Retrying the workflow hits the same ambiguity.

The production-viable version needs a unified concept: a checkpoint is the full execution state at a point in time, and resumption means loading that state and continuing — not re-running selectively based on heuristics.

## When You Need This

- Your workflows have 5+ sequential LLM calls where restarting from scratch on failure is expensive
- Individual workflow runs take longer than a few minutes (network timeouts become probable above this threshold)
- You've had production incidents where a failure at step N re-ran steps 1 through N-1 unnecessarily
- Your batch pipeline has a meaningful failure rate (if even 5% of jobs fail at the halfway point, you're paying ~2.5% extra tokens for nothing)
- Workflows fan out into parallel branches where some branches completing doesn't mean all branches completing

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **Batch → Critical.** Batch jobs are where the cost argument is clearest. Long-running, high-volume, and statistically certain to encounter failures at scale. I wouldn't run a batch LLM pipeline at meaningful volume without per-step checkpointing — the compounding cost of restarts from scratch can easily exceed the cost of the checkpointing infrastructure itself. The test: could this system break in production without it? Yes, not from a correctness standpoint, but from a cost and reliability standpoint definitively.
- **Agents → Required.** Multi-step agents are stateful by nature. Without checkpointing, any transient failure — a provider timeout, a rate limit hit, a process restart — means full replay. I wouldn't be comfortable getting paged for an agent failure if I knew the agent had no recovery boundary. The retry would just burn more tokens on work already done.
- **RAG → Optional.** Most RAG pipelines are single-pass: retrieve, augment, generate. There's nothing to checkpoint in a stateless request-response flow. It's worth asking whether your RAG system has multi-step processing (re-ranking, multi-hop retrieval, iterative refinement) — if it does, it's effectively an agent and should be treated as one.
- **Streaming → N/A.** Streaming state is inherently transient and coupled to the connection. There's no meaningful recovery point to resume from after a broken stream — the client reconnects and requests fresh output.

## The Pattern

### Architecture

```
Workflow Request
       │
       ▼
┌───────────────────────┐
│   Checkpoint Manager  │  ← Load existing checkpoint (if any)
│                       │  ← Resolve resume point from last saved step
└──────────┬────────────┘
           │ resume_from: step N (or 0 if new)
           ▼
┌──────────────────────────────────────────┐
│  Workflow Executor                        │
│                                          │
│  ┌───────────────────────────────────┐   │
│  │  for each step (from resume_from) │◄──┼─┐
│  └───────────────┬───────────────────┘   │ │
│                  ▼                       │ │
│      ┌───────────────────────┐           │ │
│      │  Step already done?   │           │ │
│      └──────┬──────────┬─────┘           │ │
│           Yes │        │ No              │ │
│              ▼         ▼                 │ │
│         Load saved   Execute step        │ │
│         output       (LLM call)          │ │
│              │         │                 │ │
│              │       Save checkpoint     │ │
│              │         │                 │ │
│              └────┬────┘                 │ │
│                   │ more steps? ─────────┘ │ (loop back)
│                   │ done                   │
└───────────────────┼────────────────────────┘
                    │
                    ▼
         ┌──────────────────────┐
         │   Checkpoint Store   │  ← Atomic write per step
         │                      │  ← Backends: Redis, PostgreSQL, S3
         └──────────┬───────────┘
                    │
                    ▼
             Final Output   ← Assembled from all step outputs

────────────────────────────────────────────
On retry:
  Checkpoint Manager loads last successful step
  Executor skips completed steps (returns saved outputs)
  Resumes from first incomplete step
```

_All token counts, latencies, and step counts shown in the implementation are illustrative defaults. Tune based on your workflow's actual profile._

### Core Abstraction

```typescript
interface CheckpointStore {
  save(workflowId: string, step: StepCheckpoint): Promise<void>;
  load(workflowId: string): Promise<WorkflowCheckpoint | null>;
  clear(workflowId: string): Promise<void>;
}

interface CheckpointedWorkflow<TContext, TResult> {
  execute(workflowId: string, context: TContext): Promise<TResult>;
  resume(workflowId: string): Promise<TResult>;
  getCheckpoint(workflowId: string): Promise<WorkflowCheckpoint | null>;
}
```

### Configurability

| Parameter         | Default        | Effect                                                                                                               |
| ----------------- | -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `checkpointStore` | In-memory      | Backend for state persistence. In-memory doesn't survive process restarts — use Redis or PostgreSQL for production.  |
| `stepTtl`         | 24 hours       | How long checkpoint data is retained. Steps older than this are treated as missing.                                  |
| `maxRetries`      | 3              | How many times to retry a failed step before marking the workflow as failed.                                         |
| `retryDelay`      | 1s exponential | Delay between step retries.                                                                                          |
| `checksumSteps`   | false          | Whether to hash step inputs and verify on resume — catches cases where the workflow definition changed between runs. |

_These are starting points. `stepTtl` in particular depends on your workflow's typical duration and your tolerance for stale state — a workflow that takes hours needs a TTL measured in days._

### Key Design Tradeoffs

**Atomic vs. transactional saves.** Each step save is atomic (all-or-nothing), but the workflow isn't transactional across steps. This is intentional: workflows are not database transactions. A step completing successfully is a fact, and we want to record it as such — not roll it back if a later step fails. The tradeoff is that you need idempotent step execution: if a step's output is recorded but the workflow crashes before the next step starts, the retry should use the saved output, not re-run the step.

**Output storage vs. re-execution.** We store step outputs in the checkpoint, not just step status. This makes resume fast (no re-execution of completed steps) but increases storage size, especially for steps with large outputs. For workflows with megabyte-scale outputs per step, consider storing outputs externally (S3) and checkpointing only references.

**Checkpoint granularity.** Checkpointing after every step maximizes recovery granularity but adds per-step I/O overhead. For very fast steps (< 100ms), checkpointing every N steps may be appropriate. For slow steps (multi-second LLM calls), per-step checkpointing is almost always worth it.

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

How this pattern itself can fail. Every solution creates new failure modes.

| Failure Mode                                                                                                                                                                                   | Detection Signal                                                                                                                                | Mitigation                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Checkpoint write fails mid-step** — the LLM call succeeds but the checkpoint save fails, so the step re-runs on retry producing a duplicate or divergent output                              | Log spike in checkpoint write errors; duplicate outputs in final assembly; non-idempotent side effects appearing twice                          | Make steps idempotent where possible; use write-ahead logging (save intent before execution, mark complete after); deduplicate outputs in final assembly              |
| **Stale checkpoint from schema change** — workflow logic changes after a checkpoint is saved; resume loads old step outputs that don't match the new step interface                            | Type errors or assertion failures during resume; outputs from old schema silently passed to new step logic                                      | Include a workflow version in every checkpoint; reject (don't silently use) checkpoints from incompatible versions; use `checksumSteps` to detect definition drift    |
| **Checkpoint store becomes unavailable** — Redis or database is down; checkpoint reads fail on resume                                                                                          | Checkpoint load errors at workflow start; workflows restart from step 0 despite prior progress                                                  | Fail fast on checkpoint store unavailability rather than silently falling back to step-0 restart; alert on checkpoint read failures separately from LLM errors        |
| **Unbounded checkpoint accumulation (silent degradation)** — completed workflows never clean up their checkpoints; storage grows indefinitely; eventually impacts checkpoint store performance | Storage growth trending up with no corresponding TTL cleanup; checkpoint store latency increasing month-over-month                              | Set explicit TTL on all checkpoints; run periodic cleanup jobs; alert when checkpoint store size exceeds a threshold; `clear()` explicitly on workflow completion     |
| **Resume with wrong context** — a workflow is resumed with a different input context than it was started with (e.g., user data changed between runs)                                           | Incorrect final outputs; inconsistency between early-step outputs (computed from old context) and late-step outputs (computed from new context) | Hash and store the initial context as part of the checkpoint; reject resumes where context hash mismatches; or design workflows to be context-invariant across steps  |
| **Partial fan-out completion** — in parallel branches, some branches checkpoint successfully but others don't; the aggregation step runs with incomplete data                                  | Missing keys in aggregated output; aggregation step errors on None/undefined values                                                             | Track branch completion status explicitly; don't aggregate until all branches are marked complete; implement per-branch checkpoints with a parent workflow checkpoint |

## Observability & Operations

### Key Metrics

| Metric                                          | What It Means                                                                                                                  | Collection                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `checkpoint_write_latency_ms` (p50, p95, p99)   | Store I/O overhead per step. P99 > 200ms suggests store pressure.                                                              | Instrument around each `store.save()` call                |
| `checkpoint_write_errors_total`                 | Failed checkpoint saves. Any non-zero rate is worth investigating.                                                             | Counter on store write failure                            |
| `workflow_resume_rate` (resumes / total starts) | How often workflows are recovering from a prior checkpoint. Baseline establishes normal; spikes indicate upstream instability. | Count workflows where `resume_from > 0` at start          |
| `steps_skipped_on_resume_total`                 | Total steps avoided via checkpointing. Quantifies the cost savings from checkpointing in production.                           | Counter per skipped step                                  |
| `checkpoint_store_size_bytes`                   | Total checkpoint storage in use. Should plateau if TTL is working correctly.                                                   | Gauge from store introspection or storage backend metrics |
| `workflow_completion_rate`                      | Fraction of workflows that reach the final step. Sustained drops indicate a failing step.                                      | Counter: completed / started                              |

### Alerting

| Alert                        | Threshold                                  | Severity | What To Do                                                              |
| ---------------------------- | ------------------------------------------ | -------- | ----------------------------------------------------------------------- |
| Checkpoint write error rate  | > 1% of saves fail                         | Warning  | Check store connectivity; verify disk space / memory headroom           |
| Checkpoint write error rate  | > 5% of saves fail                         | Critical | Workflows will lose progress on failure; escalate store incident        |
| Checkpoint write p99 latency | > 500ms                                    | Warning  | Store under pressure; consider connection pool tuning or read replicas  |
| Checkpoint store size growth | > 20% week-over-week with no volume change | Warning  | TTL may not be firing; verify cleanup job health                        |
| Workflow resume rate         | > 50% of starts are resumes                | Warning  | High upstream failure rate driving retries; investigate provider health |
| Workflow completion rate     | Drops > 10% from 7-day baseline            | Critical | A workflow step is failing consistently; check step error logs          |

_Starting thresholds. Adjust based on your workflow's baseline resume rate and your checkpoint store's performance characteristics. High-volume pipelines with intentional retry strategies will have naturally higher resume rates._

### Runbook

**Checkpoint write errors spiking:**

1. Check checkpoint store connectivity: `redis-cli ping` or equivalent DB health check
2. Verify store memory/disk isn't full: check eviction policy and usage percentage
3. Check application logs for specific error types (timeout vs. auth vs. serialization)
4. If store is degraded: workflows will still complete but lose progress-save capability — monitor workflow completion rate for impact
5. If store is fully down: consider temporarily disabling checkpoint persistence (fail fast) rather than silently losing all saves

**Checkpoint store size growing unboundedly:**

1. Verify TTL is set on all checkpoint writes: `redis-cli ttl <key>` for a sample
2. Check if cleanup job ran recently: look for `clear()` calls in workflow completion logs
3. Run manual cleanup for orphaned checkpoints older than 2× your `stepTtl`
4. If growth is from active workflows: increase store capacity short-term; investigate if workflow volume increased

**Workflows restarting from step 0 despite prior progress:**

1. Check if checkpoint store was restarted without persistence (in-memory store flushed)
2. Look for schema version mismatches: logs for "checkpoint version mismatch" or similar
3. Verify workflow IDs are stable across retries (not regenerated on each attempt)
4. Check if checkpoint TTL is shorter than the time between failure and retry

## Tuning & Evolution

### Tuning Levers

| Parameter                 | Safe Range                     | Dangerous Extreme                | Effect                                                                                                                 |
| ------------------------- | ------------------------------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `stepTtl`                 | 2× expected workflow duration  | < workflow duration              | Too short: checkpoints expire before retry; workflows restart from scratch. Too long: orphaned checkpoints accumulate. |
| `maxRetries` per step     | 2–5                            | > 10                             | High retry counts mask systematic step failures and delay surfacing real errors                                        |
| `retryDelay`              | 1–30s with exponential backoff | No backoff                       | Flat retry with no backoff can hammer a recovering provider                                                            |
| Checkpoint granularity    | Every step for steps > 1s      | Every step for sub-100ms steps   | Checkpointing sub-100ms steps adds more I/O overhead than it saves; checkpoint every N steps instead                   |
| Output serialization size | < 100KB per step               | Megabytes per step stored inline | Large inline outputs slow down checkpoint reads; store externally and checkpoint references                            |

### Drift Signals

- **Resume rate climbing without volume change:** Upstream provider reliability may be degrading. Check provider status pages and error logs. Review monthly.
- **`steps_skipped_on_resume_total` staying near zero:** Either workflows are completing without failures (good) or checkpoints aren't loading on retry (check). Validate with a synthetic failure test quarterly.
- **Checkpoint write latency trending up:** Store growth, connection pool exhaustion, or index fragmentation (for SQL backends). Review weekly at steady state.

### Silent Degradation

The failure nobody notices until month 3: workflows are creating checkpoints, but the resume logic has a bug that causes it to always start from step 0. `steps_skipped_on_resume_total` stays at zero. Resume rate is high (lots of retries). But you're paying for full restarts anyway.

This is indistinguishable from "no checkpointing" in terms of cost impact, but the system looks healthy because workflows complete.

Catch it with: a synthetic test that creates a checkpoint at step N, then forces a "resume" and verifies `steps_skipped_on_resume_total` increments. Run this test in CI and in production on a schedule (monthly at minimum). The [Agent Loop Guards](../agent-loop-guards/) pattern can help bound the retry behavior that would otherwise obscure this.

At month 6, the symptom is: API costs are higher than they should be for the workflow volume, and there's no obvious explanation. The checkpoint metrics look fine. The fix is making `steps_skipped_on_resume_total` a first-class KPI that gets graphed and reviewed alongside workflow costs.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers.

| Scale        | Additional Cost | ROI vs. No Pattern                                                       |
| ------------ | --------------- | ------------------------------------------------------------------------ |
| 1K req/day   | −$2.83/day      | Saves ~$85/month; store costs $5/month. Pays for itself in days.         |
| 10K req/day  | −$28.33/day     | Saves ~$850/month. Infrastructure overhead is negligible at this volume. |
| 100K req/day | −$283.33/day    | Saves ~$8,500/month. Checkpointing is mandatory at this scale.           |

## Testing

How to verify this pattern works correctly. See test files in `src/ts/` and `src/py/`.

- **Unit tests:** CheckpointStore read/write/clear; step completion detection; resume-point resolution from checkpoint state; TTL expiration behavior
- **Failure mode tests:** One test per failure mode — checkpoint write failure mid-step; stale checkpoint from schema version mismatch; resume with mismatched workflow ID; unbounded accumulation without TTL; partial fan-out completion tracking
- **Integration tests:** Full workflow execution with mock provider; verify steps are skipped on resume; verify outputs are assembled correctly from mixed checkpoint + fresh execution; concurrent workflow execution with separate checkpoint namespaces
- **How to run:** `cd src/ts && npm test`

## When This Advice Stops Applying

- Single-step LLM calls — nothing to checkpoint in a request-response that completes atomically
- Short workflows where restart cost is negligible (< 3 steps, cheap model, completes in seconds)
- Workflows where every step is idempotent and cheap enough that full restart is acceptable
- Stateless request-response patterns where each request is fully independent
- Streaming systems where state is inherently tied to the connection lifetime
- Workflows where determinism is critical and you can't tolerate the possibility of mixing outputs from different execution runs (early steps from one attempt, late steps from another)

<!-- ## Companion Content

- Blog post: [State Checkpointing — Deep Dive](https://prompt-deploy.com/state-checkpointing) (coming soon)
- Related patterns:
  - [Agent Loop Guards](../agent-loop-guards/) (#17, S5) — loop detection triggers checkpoint-based recovery instead of full restart
  - [Multi-Agent Routing](../multi-agent-routing/) (#31, S8) — multi-agent systems need per-agent checkpointing to recover individual agents without resetting the whole graph
  - [Retry with Budget](../../resilience/retry-with-budget/) (#5, S2) — retries resume from checkpoint instead of restarting; combines to cap the total cost of a failure
  - [Token Budget Middleware](../../cost-control/token-budget-middleware/) (#3, S1) — checkpointing prevents re-spending tokens on completed steps; together they bound both per-request and per-workflow costs -->

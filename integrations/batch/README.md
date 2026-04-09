# Integration Guide: Batch Systems

> **Part of [Production LLM Patterns](../../README.md).** This guide shows which patterns to combine for batch LLM systems, in what order to adopt them, and how they wire together in practice.

A batch system is an offline pipeline: the user isn't waiting, the job runs on a schedule or trigger, and the work is measured in thousands to millions of items rather than individual requests. Document classification runs, nightly embedding refreshes, bulk content generation, large-scale moderation queues — these are batch systems.

The way I think about batch in production: the defining constraints are recovery and throughput, not latency. Because jobs run without a user watching, you can tolerate a 24-hour processing window for a 50% API cost reduction via managed batch APIs. But that same "no user waiting" characteristic means failures accumulate silently — a job that fails at item 8,000 of 10,000 with no checkpointing has just wasted 80% of its API spend. At meaningful scale, failures aren't edge cases: [Alibaba's analysis of large-scale LLM infrastructure](https://arxiv.org/abs/2401.00134) documented a 43.4% failure rate on the top 5% most resource-intensive jobs. A nightly job with no recovery boundary isn't a question of if it will fail; it's a question of how much it costs when it does.

What that means for pattern selection: batch systems have three Critical-rated patterns — fewer than agents, and they're concentrated in recovery and throughput rather than safety and control. Get those three right and the system is recoverable and cost-efficient. The Required tier adds the quality and observability patterns that turn a recoverable batch job into a production-grade pipeline.

---

## Pattern Priority for Batch

These designations come from the [Navigation Matrix](../../README.md#navigation-matrix). The way I'd read this: **Critical** goes in before you run at real scale, **Required** should be in place before the job is part of a production workflow, **High ROI** often pays back quickly once the foundation is solid.

### Critical — absence risks unrecoverable cost or throughput failure

| Pattern | Why for Batch |
|---------|---------------|
| [State Checkpointing](../../patterns/orchestration/state-checkpointing/) | A job processing 50,000 documents that fails at item 40,000 with no checkpointing restarts from item 1 — paying for 40,000 items twice. At standard GPT-4o pricing, a 50K-item job with 500 input + 200 output tokens averages ~$35 per run; a crash-and-restart at 80% completion costs $28 in wasted tokens. Checkpointing creates recovery boundaries so retries start from the last good state. |
| [Request Batching](../../patterns/performance/request-batching/) | Both [Anthropic](https://www.anthropic.com/news/message-batches-api) and [OpenAI](https://developers.openai.com/api/docs/guides/batch) offer 50% cost reductions through their managed batch APIs. A nightly classification job that costs $22.50/run at standard rates drops to $11.25 with batching — $337.50 saved over a month of daily runs. Beyond the managed API discount, batching also smooths rate limit pressure by grouping requests rather than flooding the provider with simultaneous calls. |
| [Concurrent Request Management](../../patterns/performance/concurrent-request-management/) | Batch jobs launch many tasks in parallel by design. Without concurrency management, a job processing 1,000 documents fires all requests at once, saturates provider rate limits in the first second, and every subsequent retry extends total runtime unpredictably. [OpenAI's rate limits](https://developers.openai.com/api/docs/guides/rate-limits) and [Anthropic's standard API limits](https://platform.claude.com/docs/en/api/rate-limits) are enforced per-second, not per-minute in bursts — simultaneous floods trigger 429s even when aggregate RPM stays within limits. |

### Required — the job runs without it, but it's not production-grade

| Pattern | Why for Batch |
|---------|---------------|
| [Retry with Budget](../../patterns/resilience/retry-with-budget/) | Transient 429s and 5xx errors are unavoidable in long-running batch jobs. Without bounded retry, a rate limit wave at item 500 can exhaust the retry budget for the entire job. Budget retries at the item level, not the job level — a single item that consumes all retry budget shouldn't block the remaining 9,999. |
| [Structured Output Validation](../../patterns/safety/structured-output-validation/) | Batch jobs process LLM outputs programmatically — structured classification labels, extracted fields, generated data ready for downstream ingestion. A malformed output at item 7,000 that doesn't get validated can corrupt downstream databases, indexes, or reports silently. Validate and repair at the item level; track parse failure rates as a job health signal. |
| [PII Detection](../../patterns/safety/pii-detection/) | Batch pipelines process large volumes of potentially sensitive source data — user documents, customer records, internal communications. PII can appear in the source, in the LLM output, or in both. At batch scale, a single misconfigured privacy filter becomes a bulk exposure event rather than an isolated one. |
| [Output Quality Monitoring](../../patterns/observability/output-quality-monitoring/) | Batch jobs produce outputs in bulk, and quality degradation doesn't trigger errors — it just produces wrong results at scale. A classification model that silently shifts accuracy from 94% to 78% between two job runs has produced 160,000 wrong labels before anyone notices. Score a sample of each run and compare against the previous run's baseline. |
| [Drift Detection](../../patterns/observability/drift-detection/) | Batch jobs often run on a schedule against evolving input distributions. The same prompt and model that classified customer feedback accurately in Q1 may drift as the feedback vocabulary shifts in Q2. Drift detection surfaces distribution changes before they cause bulk quality failures. |
| [Prompt Version Registry](../../patterns/observability/prompt-version-registry/) | A batch job that produces different output distributions between two runs is useless without knowing whether the prompt changed. Version every prompt used in every job run. This is also essential for reproducibility — if you need to re-run a job from two weeks ago with the exact same prompt, you need the registry. |
| [Online Eval Monitoring](../../patterns/observability/online-eval-monitoring/) | Scripted eval sets don't cover the tail of real batch inputs. Online monitoring samples live job outputs against quality criteria, catching the long-tail inputs where the prompt underperforms. At 50,000 items per run, sampling 1% gives 500 quality measurements per job. |
| [Eval Harness](../../patterns/testing/eval-harness/) | Batch job quality can't be verified with unit tests on code. An eval harness with curated examples covering your classification/extraction/generation cases is the baseline for detecting regressions between job versions. |
| [Regression Testing](../../patterns/testing/regression-testing/) | Every prompt change, model version update, or temperature adjustment is a regression risk. Run the eval harness before deploying a new job version. Batch jobs often have downstream consumers (reports, indexes, training data) — a quality regression at scale is expensive to remediate after the fact. |
| [Embedding Refresh](../../patterns/data-pipeline/embedding-refresh/) | Batch systems frequently include embedding generation — building or refreshing vector indexes at scale. Stale embeddings degrade retrieval quality; batch processing is typically where the refresh happens. An embedding job that runs without freshness tracking produces an index that looks correct but silently serves degraded results. |
| [Token Budget Middleware](../../patterns/cost-control/token-budget-middleware/) | Batch jobs run without a user to notice runaway token consumption. A prompt that accidentally includes full document context when it should use a 500-token summary will quietly consume 10× the expected cost per item. Set per-item budgets and fail items that exceed them — that's a far cheaper signal than a billing alert. |

### High ROI — strong return on investment once the foundation is solid

| Pattern | Why for Batch |
|---------|---------------|
| [Semantic Caching](../../patterns/cost-control/semantic-caching/) | Batch jobs often process overlapping inputs — similar documents, repeated queries, items that match previous runs. Cache hit rates of 20–40% are achievable on recurring jobs processing similar corpora. At 50K items per run, 30% caching reduces the billable items to 35K — a meaningful cost reduction on any recurring job. |
| [Model Routing](../../patterns/cost-control/model-routing/) | Batch workloads mix task complexity — some items need a frontier model's reasoning; most don't. A classification pipeline that routes obvious-label items to a lightweight model can reduce per-item cost by 60–80% on the easy tier. The hard part is knowing what "obvious" means — use the eval harness to calibrate routing thresholds before deploying at scale. |
| [Prompt Rollout Testing](../../patterns/testing/prompt-rollout-testing/) | Batch prompt changes affect all items in the next job run simultaneously. A canary run on 5% of the corpus — or one job run on a smaller representative sample — catches surprises before they propagate to the full dataset. |

### Recommended — solid practice once the core is in place

| Pattern | Why for Batch |
|---------|---------------|
| [Structured Tracing](../../patterns/observability/structured-tracing/) | Job-level and item-level spans are essential for debugging. "The job produced wrong results" is unsolvable without knowing which items failed, which prompt version ran, and what the intermediate outputs were at each stage. |
| [Graceful Degradation](../../patterns/resilience/graceful-degradation/) | Some items will fail permanently — the input is malformed, the model consistently refuses, the output can't be parsed. Define a per-item fallback (skip with logging, write a sentinel value, retry later) rather than halting the whole job. |
| [Multi-Provider Failover](../../patterns/resilience/multi-provider-failover/) | For long-running batch jobs, a provider outage mid-job means stalling until the provider recovers. Failover to a secondary provider keeps the job moving. Worth adding after experiencing a provider outage that disrupted a time-sensitive batch run. |
| [Chunking Strategies](../../patterns/data-pipeline/chunking-strategies/) | Most batch jobs process documents — and how you chunk those documents determines the quality ceiling. This is especially relevant for batch pipelines that feed downstream RAG indexes. |
| [Index Maintenance](../../patterns/data-pipeline/index-maintenance/) | Batch systems are often the place where vector indexes get built and maintained. Stale index entries, orphaned vectors, and dimension mismatches are batch-side problems that surface as retrieval quality issues. |
| [Agent Loop Guards](../../patterns/orchestration/agent-loop-guards/) | For batch workflows that use agentic sub-tasks (multi-step extraction, iterative refinement), loop guards prevent runaway sub-tasks from consuming unbounded tokens per item. An uncapped agent sub-task in a 10,000-item job is a cost disaster. |
| [Tool Call Reliability](../../patterns/orchestration/tool-call-reliability/) | For batch jobs where each item involves LLM tool calls (structured extraction, database writes, API calls), tool call validation ensures malformed calls fail fast at the item level rather than silently producing wrong results. |
| [Prompt Diffing](../../patterns/observability/prompt-diffing/) | When a batch job produces a different output distribution between runs, the first question is always "what changed in the prompt?" Diffing gives you the answer quickly. |
| [Snapshot Testing](../../patterns/testing/snapshot-testing/) | Batch outputs often feed downstream consumers with strict format expectations. Snapshot tests catch unexpected format changes across prompt or model version upgrades before they break downstream pipelines. |
| [Cost Dashboard](../../patterns/cost-control/cost-dashboard/) | Per-job and per-item cost visibility. Once token budgets are in place, a dashboard makes it obvious when a new job version is consuming 2× the expected tokens before the billing statement arrives. |
| [Multi-Agent Routing](../../patterns/orchestration/multi-agent-routing/) | For batch systems that dispatch to multiple specialized agents (e.g., different processors for different document types), routing logic with confidence scoring prevents silent misclassification at scale. |

### Optional — context-dependent

| Pattern | Why for Batch |
|---------|---------------|
| [Circuit Breaker](../../patterns/resilience/circuit-breaker/) | Useful when the batch pipeline calls downstream services that can degrade (external APIs, vector databases). Less critical than in real-time systems since batch jobs can tolerate pausing and retrying. |
| [Prompt Injection Defense](../../patterns/safety/prompt-injection-defense/) | Relevant when the batch source data is untrusted (user-submitted documents, scraped web content). If the corpus is internal and controlled, the attack surface is narrow. |
| [Human-in-the-Loop](../../patterns/safety/human-in-the-loop/) | For batch outputs that have high-stakes downstream consequences (legal documents, medical records, high-value financial classifications), routing low-confidence items to human review before committing results is the right tradeoff. |
| [Context Management](../../patterns/data-pipeline/context-management/) | Most batch items are independent and stateless. Context management is relevant when items have multi-turn processing (iterative refinement, multi-step extraction pipelines). |
| [Latency Budget](../../patterns/performance/latency-budget/) | Batch jobs typically optimize for throughput, not latency. A per-item latency budget is worth setting only if the job has an overall SLA (e.g., "all items must be processed within 4 hours"). |
| [Adversarial Inputs](../../patterns/testing/adversarial-inputs/) | Relevant when the batch corpus includes untrusted or adversarial content. For internal document processing pipelines with controlled inputs, the adversarial surface is small. |

---

## System Architecture

A batch system has two loops: the **job execution loop** (per-run) and the **item processing loop** (per-item). Recovery and throughput control operate at both levels — job-level checkpointing tracks overall progress; item-level concurrency management controls the rate.

```
   Item Source (S3 / DB / Queue)
           │
           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  A. Job Initialization                                               │
│     State Checkpointing — load resume point (if restart)           │
│       → new job: resume_from = 0                                    │
│       → restart: resume_from = last committed checkpoint            │
│     Token Budget — initialize per-job budget ceiling                │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ cursor + budget
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  B. Item Queue (sliding window)                                      │
│     Fetch next batch of items from cursor position                  │
│     Semantic Caching — check cache before submitting to provider   │
│       → hit: use cached result, advance cursor                      │
│       → miss: continue to processing layer                          │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ items to process
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  C. Throughput Control Layer                                         │
│     Concurrent Request Management — semaphore + token bucket        │
│       → bound in-flight requests (RPM + TPM)                        │
│     Request Batching — collect items into provider batches          │
│       → managed batch API (50% cost) when latency tolerates 24h    │
│       → dynamic batching (group by size, flush on interval/count)  │
│         when latency SLA is tighter                                  │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ batched items
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  D. Provider Layer                                                   │
│     Model Routing — route by task complexity                        │
│       → complex items → frontier model                              │
│       → simple items → lightweight model                            │
│     Retry with Budget — transient errors                            │
│       → bounded per-item retries with jitter                        │
│     Graceful Degradation — permanent failures                       │
│       → write sentinel / skip with log / defer to human review      │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ LLM responses
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  E. Output Processing                                                │
│     Structured Output Validation — parse + validate + repair        │
│     PII Detection — scan output before writing to destination       │
│     State Checkpointing — commit progress after each batch          │
│       → write checkpoint: cursor, item count, cost so far           │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ validated outputs
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  F. Observability (Side Channel)                                    │
│     Structured Tracing — job span + per-item spans                 │
│     Output Quality Monitoring — score sampled items (1–5%)         │
│     Token Budget — record actual spend; alert at threshold          │
│     Drift Detection — compare item distribution to prior run        │
└──────────────────────────────────────────────────────────────────────┘
```

> Concurrency values (RPM, TPM, batch size) and quality sampling rates are illustrative — optimal values depend on your provider tier, model, and job SLA.

---

## Adoption Sequence

The way I'd sequence these: start with what makes the job recoverable (recovery layer), then add what ensures output quality (validation and quality layer), then visibility (observability), then resilience against provider failures, then quality measurement over time, and finally optimization. Recovery comes first because at meaningful volume, jobs will fail — the question is whether that failure costs 80% of the job's budget.

### Phase 1 — Recovery Foundation (Before First Production Run)

These three patterns are the difference between a batch script and a recoverable batch job. None of them are optional once the job processes more than a few hundred items or runs in a context where restarts are expensive.

1. **[State Checkpointing](../../patterns/orchestration/state-checkpointing/)** — Persist progress after every committed batch before you run anything. Decide checkpoint granularity upfront: once per item is safe but I/O-heavy; once per 100 items is a reasonable starting point. Use a checkpoint key that uniquely identifies the job run so restarts skip already-completed items rather than re-processing them.

2. **[Concurrent Request Management](../../patterns/performance/concurrent-request-management/)** — Set a semaphore (in-flight request count) and a dual token bucket (RPM + TPM) before the job touches the provider. Start conservative: half your provider tier's RPM limit. You can tune up after measuring actual throughput. Without this, the job fires all requests in its first batch simultaneously and triggers rate limit errors that extend total runtime.

3. **[Request Batching](../../patterns/performance/request-batching/)** — Use the provider's managed batch API when the job can tolerate asynchronous processing (up to 24 hours). If the job needs same-day completion, use dynamic batching — collect items into windows, send in groups, collect results. Either way, batching is where the cost reduction comes from.

**What you have:** The job can be interrupted and resumed from where it stopped. Rate limits don't cause cascading 429 failures. The job uses batch pricing where applicable.

### Phase 2 — Output Quality & Safety (Before the Job Feeds Downstream Systems)

4. **[Structured Output Validation](../../patterns/safety/structured-output-validation/)** — Wrap every LLM output in parse + validate + repair logic at the item level. Define what constitutes a valid output for your job (classification label from a fixed set, extracted JSON with required fields, etc.) and reject items that can't be repaired into valid form. Track per-job parse failure rates — an uptick signals a prompt or model regression.

5. **[PII Detection](../../patterns/safety/pii-detection/)** — Scan source documents before they enter LLM context if the corpus is potentially sensitive. Scan outputs before writing to the destination. At batch scale, a PII handling misconfiguration produces bulk exposure rather than isolated incidents.

6. **[Token Budget Middleware](../../patterns/cost-control/token-budget-middleware/)** — Set a per-item token ceiling before the job runs. A classification item that should use 300 input tokens shouldn't be consuming 3,000. Set the per-item budget at 2–3× the expected average; fail items that exceed it with a log entry rather than paying for them silently.

**What you have:** The job produces valid, structured outputs. PII doesn't leak through the pipeline. Per-item costs are bounded so a misconfigured prompt doesn't silently inflate the bill.

### Phase 3 — Observability (First Production Run)

7. **[Structured Tracing](../../patterns/observability/structured-tracing/)** — Instrument at two levels: a job span tracking total items, elapsed time, costs, and checkpoint state; and per-item spans tracking input tokens, output tokens, parse outcome, and retry count. The first job that produces unexpected results will require these spans to debug — "the job produced wrong outputs on 2,000 items" is unsolvable without item-level traces.

8. **[Prompt Version Registry](../../patterns/observability/prompt-version-registry/)** — Record the prompt version used in every job run as a job attribute in the trace (or as metadata in the checkpoint). When two runs produce different output distributions, the first question is always whether the prompt changed. Make that answer available without digging through deployment logs.

9. **[Output Quality Monitoring](../../patterns/observability/output-quality-monitoring/)** — Sample 1–5% of each job's outputs and score them against quality criteria. Run the scoring asynchronously, not on the critical path. Compare each run's quality distribution against the previous run. A quality drop that doesn't trigger errors is the normal failure mode in batch systems — monitoring is what surfaces it.

**What you have:** Every job run is fully traceable. Prompt changes are tracked. Quality degradation surfaces through monitoring rather than downstream complaints.

### Phase 4 — Resilience Against Provider Failures (Month 1)

10. **[Retry with Budget](../../patterns/resilience/retry-with-budget/)** — Add bounded, jittered retries on individual item failures. Budget retries at the item level: 3 attempts per item with exponential backoff and ±25% jitter is a reasonable starting point. Don't let a single item's retry storm consume the whole job's rate limit headroom. Items that exhaust their retry budget should go to a dead-letter queue, not halt the job.

11. **[Graceful Degradation](../../patterns/resilience/graceful-degradation/)** — Define what happens to permanently failed items: write a sentinel value (e.g., `{"status": "failed", "reason": "parse_error"}`), skip with structured logging for later review, or route to a human review queue. "The item failed" is a valid output if it's recorded consistently — downstream consumers need to handle it, and you need to measure the failure rate.

12. **[Multi-Provider Failover](../../patterns/resilience/multi-provider-failover/)** — Add a secondary provider once you've experienced a provider outage that disrupted a time-sensitive job. The complexity (secondary provider contract, prompt compatibility testing) isn't worth it on day one. After one outage that stalled a batch run for four hours, the calculus changes.

**What you have:** Transient per-item failures retry with bounded budget. Permanent failures produce structured records rather than job halts. Provider outages can be survived if failover is wired.

### Phase 5 — Quality Measurement Over Time (Month 1–2)

13. **[Eval Harness](../../patterns/testing/eval-harness/)** — Build a curated item set representing your job's core cases: 50–200 representative inputs with known-correct outputs and scoring criteria. This is the baseline for detecting prompt and model regressions before they reach production. For classification jobs, include edge cases and ambiguous examples — those are where regressions show first.

14. **[Regression Testing](../../patterns/testing/regression-testing/)** — Run the eval harness on every prompt change and model update before deploying the new job version. Batch quality regressions are expensive: a quality drop from 94% to 78% in a 10,000-item classification job produces 1,600 wrong labels per run.

15. **[Drift Detection](../../patterns/observability/drift-detection/)** — Add distribution monitoring for input characteristics (document length distribution, vocabulary shift, category distribution). Compare each run's distribution against the prior run baseline. A drift signal on input distributions is an early warning that the job's quality may be changing — before the quality metrics confirm it.

16. **[Online Eval Monitoring](../../patterns/observability/online-eval-monitoring/)** — Score a sample of each run's live outputs (separate from the curated eval set). The eval harness covers scripted cases; online monitoring catches the tail of real inputs where the prompt underperforms. At 50K items per run, sampling 500 gives statistically meaningful quality measurements.

**What you have:** Behavioral changes are detectable before they corrupt downstream consumers. The eval harness provides a quality baseline; production monitoring tracks drift from that baseline across job runs.

### Phase 6 — Cost Optimization (Quarter 1+)

17. **[Semantic Caching](../../patterns/cost-control/semantic-caching/)** — Once the job is stable and the eval harness validates quality, add semantic caching to eliminate redundant API calls for similar inputs. Measure actual cache hit rates on a sample of recent runs before deciding on cache TTL and similarity thresholds — the expected hit rate varies significantly by job type.

18. **[Model Routing](../../patterns/cost-control/model-routing/)** — Route items by task complexity once quality monitoring is in place to validate routing decisions. A classification pipeline with a bimodal difficulty distribution (clearly-labeled items vs. ambiguous items) benefits most from routing. Start with a conservative threshold and expand the lightweight-model tier only after measuring quality on the routed items.

19. **[Prompt Rollout Testing](../../patterns/testing/prompt-rollout-testing/)** — Canary prompt changes on a representative subset before full deployment. For batch jobs, this means running the new prompt on a small sample (5–10% of a typical run's volume) and comparing output distributions against the current prompt before switching. A prompt change that affects all 50,000 items in the next run is expensive to roll back after the fact.

---

## Wiring Guide

These snippets show how the core patterns compose for a batch processing pipeline. They use the actual implementations from this repo.

### TypeScript: Per-Item Processing Loop

```typescript
import { CheckpointManager } from '../../patterns/orchestration/state-checkpointing/src/ts/index.js';
import { ConcurrencyManager } from '../../patterns/performance/concurrent-request-management/src/ts/index.js';
import { BatchScheduler } from '../../patterns/performance/request-batching/src/ts/index.js';
import { OutputValidator } from '../../patterns/safety/structured-output-validation/src/ts/index.js';
import { PiiDetector } from '../../patterns/safety/pii-detection/src/ts/index.js';
import { RetryBudget } from '../../patterns/resilience/retry-with-budget/src/ts/index.js';
import { GracefulDegradation } from '../../patterns/resilience/graceful-degradation/src/ts/index.js';
import { TokenBudget } from '../../patterns/cost-control/token-budget-middleware/src/ts/index.js';
import { Tracer } from '../../patterns/observability/structured-tracing/src/ts/index.js';

// Wire up once at job initialization
const checkpoints = new CheckpointManager(db, {
  ttl: 24 * 3600,        // 24h — covers next-day restart on failure
  granularity: 100,      // checkpoint every 100 items
});

const concurrencyMgr = new ConcurrencyManager({
  maxConcurrent: 25,     // in-flight request ceiling
  rpm: 500,              // requests per minute (match your provider tier)
  tpm: 100_000,          // tokens per minute
});

const batchScheduler = new BatchScheduler({
  maxBatchSize: 50,
  flushIntervalMs: 5_000, // flush every 5s even if batch isn't full
});

const outputValidator = new OutputValidator({ maxRetries: 2 });
const piiDetector = new PiiDetector({ mode: 'redact' });
const retryBudget = new RetryBudget({ maxAttempts: 3, budgetTokens: 2_000 });
const degradation = new GracefulDegradation({
  fallback: (item, err) => ({
    status: 'failed',
    item_id: item.id,
    reason: err.message,
    retry_eligible: err.retryable ?? false,
  }),
});
const tracer = new Tracer({ serviceName: 'batch-job' });

async function runBatchJob(jobId: string, items: Item[]): Promise<JobResult> {
  const jobSpan = tracer.startSpan('batch.job', { jobId, total: items.length });

  // 1. Load checkpoint — resume from last committed position
  const checkpoint = await checkpoints.load(jobId);
  const cursor = checkpoint?.cursor ?? 0;
  jobSpan.setAttributes({ 'job.resume_from': cursor });

  const results: ProcessedItem[] = checkpoint?.results ?? [];
  const failed: FailedItem[] = checkpoint?.failed ?? [];

  try {
    const pendingItems = items.slice(cursor);

    for await (const batch of batchScheduler.collect(pendingItems)) {
      // 2. Process each item in the batch with concurrency management
      const batchResults = await Promise.allSettled(
        batch.map(item => concurrencyMgr.execute(async () => {
          const itemSpan = tracer.startSpan('batch.item', { item_id: item.id }, jobSpan);
          const tokenBudget = new TokenBudget({ maxTokens: 1_500 }); // per-item ceiling

          try {
            // 3. Scan source content for PII before sending to LLM
            const cleanContent = await piiDetector.scanInput(item.content);

            // 4. LLM call with retry budget
            const raw = await retryBudget.execute(() =>
              tokenBudget.wrap(() =>
                llmProvider.classify(cleanContent, PROMPT_VERSION)
              )
            );

            // 5. Validate and parse output
            const validated = await outputValidator.validate(raw, ClassificationSchema);
            itemSpan.setAttributes({
              'item.tokens_used': tokenBudget.used,
              'item.parse_attempts': validated.attempts,
            });

            return { item_id: item.id, result: validated.data, status: 'success' };

          } catch (err) {
            itemSpan.recordError(err);
            // 6. Graceful degradation for permanent failures
            return await degradation.execute(item, err);
          } finally {
            itemSpan.end();
          }
        }))
      );

      // 7. Collect results and checkpoint progress
      for (const r of batchResults) {
        if (r.status === 'fulfilled') {
          r.value.status === 'success' ? results.push(r.value) : failed.push(r.value);
        }
      }

      const newCursor = cursor + results.length + failed.length;
      await checkpoints.save(jobId, { cursor: newCursor, results, failed });
      jobSpan.setAttributes({ 'job.cursor': newCursor });
    }

  } finally {
    jobSpan.setAttributes({
      'job.completed': results.length,
      'job.failed': failed.length,
    });
    jobSpan.end();
  }

  return { results, failed, jobId };
}
```

### TypeScript: Managed Batch API Submission (50% Cost Reduction)

```typescript
import { BatchScheduler } from '../../patterns/performance/request-batching/src/ts/index.js';
import { CheckpointManager } from '../../patterns/orchestration/state-checkpointing/src/ts/index.js';

// For jobs that tolerate up to 24-hour processing windows,
// use the provider's managed batch API for 50% cost reduction.
async function submitManagedBatch(jobId: string, items: Item[]): Promise<string> {
  const checkpoints = new CheckpointManager(db, { ttl: 48 * 3600 });

  // 1. Check if a batch was already submitted for this job
  const existing = await checkpoints.load(jobId);
  if (existing?.batchId) {
    return existing.batchId; // idempotent — don't resubmit
  }

  // 2. Format requests for the managed batch API
  const requests = items.map(item => ({
    custom_id: item.id,
    method: 'POST',
    url: '/v1/messages',
    body: {
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: buildPrompt(item) }],
    },
  }));

  // 3. Submit the batch
  const batch = await anthropic.beta.messages.batches.create({ requests });

  // 4. Checkpoint the batch ID so polling can resume after interruption
  await checkpoints.save(jobId, { batchId: batch.id, submittedAt: Date.now() });

  return batch.id;
}

async function pollManagedBatch(jobId: string): Promise<BatchResults> {
  const checkpoints = new CheckpointManager(db, { ttl: 48 * 3600 });
  const state = await checkpoints.load(jobId);
  if (!state?.batchId) throw new Error(`No batch ID for job ${jobId}`);

  // Poll until processing_status is 'ended'
  while (true) {
    const batch = await anthropic.beta.messages.batches.retrieve(state.batchId);
    if (batch.processing_status === 'ended') break;
    await sleep(60_000); // poll every minute
  }

  // Collect results and validate outputs
  const results = [];
  for await (const result of anthropic.beta.messages.batches.results(state.batchId)) {
    results.push(result);
  }

  return results;
}
```

### Python: Per-Item Processing Loop

```python
import asyncio
from patterns.orchestration.state_checkpointing.src.py import CheckpointManager
from patterns.performance.concurrent_request_management.src.py import ConcurrencyManager
from patterns.performance.request_batching.src.py import BatchScheduler
from patterns.safety.structured_output_validation.src.py import OutputValidator
from patterns.safety.pii_detection.src.py import PiiDetector
from patterns.resilience.retry_with_budget.src.py import RetryBudget, RetryConfig
from patterns.resilience.graceful_degradation.src.py import GracefulDegradation
from patterns.cost_control.token_budget_middleware.src.py import TokenBudget
from patterns.observability.structured_tracing.src.py import Tracer

# Wire up at job initialization
checkpoints = CheckpointManager(db, ttl=24 * 3600, granularity=100)
concurrency_mgr = ConcurrencyManager(max_concurrent=25, rpm=500, tpm=100_000)
batch_scheduler = BatchScheduler(max_batch_size=50, flush_interval_ms=5_000)
output_validator = OutputValidator(max_retries=2)
pii_detector = PiiDetector(mode="redact")
retry_budget = RetryBudget(RetryConfig(max_attempts=3, budget_tokens=2_000))
degradation = GracefulDegradation(
    fallback=lambda item, err: {
        "item_id": item.id,
        "status": "failed",
        "reason": str(err),
        "retry_eligible": getattr(err, "retryable", False),
    }
)
tracer = Tracer(service_name="batch-job")


async def run_batch_job(job_id: str, items: list[Item]) -> JobResult:
    with tracer.span("batch.job", job_id=job_id, total=len(items)) as job_span:
        # 1. Load checkpoint — resume from last committed position
        checkpoint = await checkpoints.load(job_id)
        cursor = checkpoint.cursor if checkpoint else 0
        results = checkpoint.results if checkpoint else []
        failed = checkpoint.failed if checkpoint else []

        job_span.set_attributes({"job.resume_from": cursor})
        pending_items = items[cursor:]

        async for batch in batch_scheduler.collect(pending_items):
            # 2. Process each item with concurrency management
            async def process_item(item):
                with tracer.span("batch.item", item_id=item.id, parent=job_span) as item_span:
                    token_budget = TokenBudget(max_tokens=1_500)
                    try:
                        # 3. Scan for PII before sending to LLM
                        clean_content = await pii_detector.scan_input(item.content)

                        # 4. LLM call with retry budget
                        raw = await retry_budget.execute(
                            lambda: token_budget.wrap(
                                lambda: llm_provider.classify(clean_content, PROMPT_VERSION)
                            )
                        )

                        # 5. Validate output
                        validated = await output_validator.validate(raw, ClassificationSchema)
                        item_span.set_attributes({
                            "item.tokens_used": token_budget.used,
                            "item.parse_attempts": validated.attempts,
                        })
                        return {"item_id": item.id, "result": validated.data, "status": "success"}

                    except Exception as err:
                        item_span.record_error(err)
                        # 6. Graceful degradation for permanent failures
                        return await degradation.execute(item, err)

            batch_results = await asyncio.gather(
                *[concurrency_mgr.execute(lambda: process_item(item)) for item in batch],
                return_exceptions=True,
            )

            # 7. Collect results and checkpoint progress
            for r in batch_results:
                if isinstance(r, Exception):
                    failed.append({"status": "error", "reason": str(r)})
                elif r["status"] == "success":
                    results.append(r)
                else:
                    failed.append(r)

            new_cursor = cursor + len(results) + len(failed)
            await checkpoints.save(job_id, {"cursor": new_cursor, "results": results, "failed": failed})

        job_span.set_attributes({"job.completed": len(results), "job.failed": len(failed)})
        return JobResult(results=results, failed=failed, job_id=job_id)
```

### Wiring Checkpointing + Concurrency + Batching

These three patterns have a specific interaction that matters for batch jobs:

```
State Checkpointing → Concurrent Request Management → Request Batching
```

- **State Checkpointing** determines which items still need processing. The cursor it loads is the starting position for the batch scheduler — skipping already-completed items is what makes restarts cheap. Checkpoint after each committed batch, not after each item — the I/O cost of checkpointing every item at scale is higher than the cost of re-running the last partial batch.

- **Concurrent Request Management** controls the rate at which the batch submits items to the provider. The semaphore and token bucket must be initialized before the first batch fires — not per-batch. Rate limit state needs to be shared across all concurrent item processors, not scoped to each batch window.

- **Request Batching** determines how items are grouped before submission. If using the managed batch API (asynchronous, 24h window), items are submitted once and polled later — concurrency management is less relevant here since the provider handles the parallelism. If using dynamic batching (synchronous, real-time), concurrency management sits inside the batch executor.

The common mistake is treating these as independent: checkpointing the item list without considering batch boundaries means a restart re-runs the last partial batch; initializing the concurrency manager per-batch means rate limit state resets between batches and the job runs hotter than intended.

---

## Tradeoffs

### What to skip early

**Semantic Caching** — worth profiling actual cache hit rates on your specific corpus before investing in the infrastructure. Jobs processing unique documents (user uploads, freshly scraped content) have near-zero cache hit rates; jobs re-processing the same corpus with different prompts can hit 40%+. Measure first.

**Model Routing** — routing decisions require quality signal to calibrate. Without output quality monitoring already running, you can't verify that simple items are being handled well by the cheaper model. Add this after quality monitoring has been in place for a few job runs.

**Multi-Provider Failover** — the added complexity (secondary provider contracts, prompt compatibility testing across providers, cost of maintaining two integrations) isn't justified until you've experienced a provider outage that disrupted a time-sensitive run. The first outage will change the calculus.

**Circuit Breaker** — batch jobs can tolerate pausing and retrying on provider degradation in a way real-time systems can't. The circuit breaker pattern is more impactful in streaming and agent systems where every second of degradation is user-visible. For batch, bounded retry with exponential backoff typically suffices.

### What to add at scale

**Checkpoint granularity** — at low volumes (hundreds of items), checkpointing every item is fine. At 100K+ items per run, the I/O cost of per-item checkpointing becomes significant. Profile the checkpoint I/O overhead and choose granularity (every 100, 500, or 1,000 items) based on the cost-vs-recovery-cost tradeoff for your job's failure rate.

**Per-job cost projections** — once token budget middleware is in place, add pre-run cost estimation: based on the item count and sampled token counts from recent runs, what will this job cost? An estimate before submission prevents expensive surprises on jobs that are larger or more token-intensive than expected.

**Dead-letter queue depth monitoring** — failed items accumulate in the dead-letter queue. At scale, the DLQ depth is a leading indicator of systematic prompt or model problems before they show up in quality monitoring. Alert when DLQ depth exceeds a threshold relative to total items processed.

### Where patterns create tension

**State Checkpointing vs. Idempotency.** Resuming from a checkpoint assumes that re-processing items already partially done is safe. If items produce writes to external systems (database updates, index modifications, sent notifications), re-running a partially-committed batch can produce duplicates. The mitigation is idempotency keys per item — pass a deterministic key to downstream writes so they can deduplicate. This needs to be built in from the start, not retrofitted.

**Request Batching (managed API) vs. State Checkpointing.** Managed batch APIs process items asynchronously — you submit a batch and poll for results. If the polling process crashes, you need to resume polling without resubmitting the batch. The checkpoint for managed batch jobs needs to store the batch ID, not item positions — a restart should poll the existing batch, not submit a new one.

**Concurrent Request Management vs. Retry with Budget.** At high concurrency, retry storms can form even with per-item retry budgets — if 100 items all fail simultaneously and all retry at similar intervals, the retry wave saturates the rate limiter again. The ±25% jitter is mandatory, not optional. Without it, exponential backoff is synchronized across items and the thundering herd just repeats at each backoff interval.

**Model Routing vs. Output Quality Monitoring.** Routing items to a cheaper model reduces cost but introduces a quality risk. Quality monitoring needs to break down scores by model tier (frontier vs. lightweight) to detect when the lightweight model's quality is degrading. Without this breakdown, a quality regression on routed items is invisible until it's large enough to drag down the overall job score.

**Drift Detection vs. Long Job Runs.** Drift detection compares the current run's input distribution against a baseline from prior runs. For very long-running jobs (12+ hours), the input distribution at the end of the job may have already drifted from the beginning — especially for jobs that process live-updated data sources. Consider sampling distribution at job start, mid-point, and end rather than treating the full run as a single distribution snapshot.

---

## Related Guides

- [RAG Systems Integration Guide](../rag/) — batch jobs frequently build and maintain the RAG data layer (embedding generation, index updates). If the batch pipeline feeds a RAG system, the RAG guide covers the retrieval-side patterns that complement the batch-side patterns here.
- [Agent Systems Integration Guide](../agents/) — for batch workflows where each item involves multi-step agentic processing (iterative extraction, tool-using sub-tasks), the Agent guide covers the orchestration patterns for keeping those sub-tasks bounded and recoverable.
- [Multi-Agent Systems Integration Guide](../multi-agent/) — for batch systems that dispatch to multiple specialized agents in parallel (different processors for different item types), the Multi-Agent guide covers routing and coordination patterns at the job level.

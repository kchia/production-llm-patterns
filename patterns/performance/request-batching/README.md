# Request Batching

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

Processing items one-at-a-time through an LLM API wastes the hardware underneath it. During single-request inference, the GPU's memory bandwidth is the bottleneck — not compute. The model's weights must load from memory for every token generated, and with only one request running at a time, GPU cores sit idle waiting for memory fetches. [NVIDIA's inference optimization guide](https://developer.nvidia.com/blog/mastering-llm-techniques-inference-optimization/) puts this plainly: GPU utilization under single-request serving typically hovers around 15–40%, depending on model size and hardware configuration.

The failure at the API layer is more immediate. Teams running bulk jobs — nightly evals, content pipelines, moderation queues — tend to fire requests serially or with a naive `asyncio.gather()` flood. The serial approach processes one item at a time and finishes in hours when it could finish in minutes. The async flood hits rate limits immediately: [OpenAI Tier 1](https://developers.openai.com/api/docs/guides/rate-limits) is 500 RPM for GPT-4, [Anthropic's standard API](https://platform.claude.com/docs/en/api/rate-limits) is ~50 RPM. When a cron job, a retry wave, and a webhook burst coincide, the API starts returning 429s in bulk. The retry logic adds backpressure that amplifies the spike, not dampens it.

The dollar cost compounds. Without batching, every item in a 100,000-document pipeline pays full standard API pricing per individual request. [Anthropic](https://claude.com/blog/message-batches-api) and [OpenAI](https://platform.openai.com/docs/guides/batch) both offer 50% cost reductions through their managed batch APIs (as of early 2025) — but only for workloads that can tolerate async, non-real-time delivery.

## What I Would Not Do

The first instinct is to fire all requests simultaneously with `asyncio.gather()` or `Promise.all()`. This looks like parallelism, but it isn't batching. Each request still runs independently at the server. The only thing that changed is the timing — all the requests arrive at once, which means all the rate limit errors also arrive at once. At 10,000 documents, this produces a 429 storm that exhausts the retry budget faster than sequential processing would have.

The second instinct is [static batching](https://www.anyscale.com/blog/continuous-batching-llm-inference): group N items together, send them in one request, repeat. This helps throughput, but it has a specific failure mode at the server level. Shorter sequences in the batch get padded to match the longest one. If one prompt finishes early, the GPU keeps computing wasted tokens until the longest prompt completes. At batch size 8 with varied sequence lengths, the padding waste grows as `(n−1)(B−1)` extra tokens. More practically: static batching pre-allocates contiguous memory for a maximum sequence length assumption, and KV cache memory scales as `batch_size × sequence_length × 2 × num_layers × hidden_size × FP16` — it overflows before you reach the batch sizes you expected.

Neither approach is wrong for small-scale use. Both break down in ways that are hard to debug once a job has been running for an hour and starts returning partial results.

## When You Need This

- You're running bulk inference jobs — evals, document processing, content generation, moderation queues — and each job processes more than a few hundred items
- Your per-item API costs are adding up because every item incurs a full standard-rate request
- You're hitting provider rate limits (RPM or TPM) during burst periods, even with retry logic in place
- Job completion time matters but users aren't waiting in real time — you can tolerate the latency tradeoff
- You're running on self-hosted serving infrastructure ([vLLM](https://vllm.ai/), [TGI](https://huggingface.co/docs/text-generation-inference/en/index), [TensorRT-LLM](https://github.com/NVIDIA/TensorRT-LLM)) and want to maximize GPU utilization

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **Batch → Critical.** Batch systems are defined by high-volume offline processing, and that's exactly the scenario where batching delivers the most impact. Without it, a 10,000-item job that could finish in 20 minutes takes hours. Long-running jobs also accumulate cost at full standard pricing when 50% batch pricing is available. I wouldn't run a batch processing system at any real scale without this.
- **RAG → High ROI.** RAG pipelines often have an offline component — embedding generation, index building, bulk re-ranking — where batching pays off substantially. The real-time retrieval path doesn't benefit, but the data preparation side does. The ROI is high enough that I'd want it in any RAG system processing more than a few thousand documents.
- **Agents → Optional.** Most agent invocations are interactive and sequential — each step depends on the last response. There's no natural batch to form. The exception is fan-out scenarios where an agent spawns many parallel sub-tasks that can be batched before aggregation. Worth considering for that case, not generally.
- **Streaming → N/A.** Streaming systems need responses to start immediately. Managed batch APIs introduce minutes-to-hours of latency by design. Not applicable.

## The Pattern

### Architecture

```
Items[]
  │
  ▼
┌──────────────────────────────────┐
│  1. BatchScheduler               │
│     Collect items into windows   │
│     Trigger: maxBatchSize hit    │
│            OR flushInterval      │
└────────────────┬─────────────────┘
                 │ Batch[]
                 ▼
┌──────────────────────────────────┐
│  2. BatchExecutor                │
│     Concurrency-limited pool     │  ──► [BatchMetrics]
│     ┌──────────────────────┐     │
│     │  send batch to API   │     │
│     │   ↓ success   ↓ fail │     │
│     │ Results[]  retry (n) │     │
│     │           → fail[] ──┼──► FailedItems[]
│     └──────────────────────┘     │
└────────────────┬─────────────────┘
                 │ Results[]
                 ▼
┌──────────────────────────────────┐
│  3. ResultCollector              │
│     Map results → original items │
│     Track failures at item level │
└────────────────┬─────────────────┘
                 │
                 ▼
          Output[]
          + FailedItems[]
          + BatchMetrics
```

> Numeric values in configuration (batch sizes, concurrency, intervals) are illustrative starting points — optimal values depend on provider rate limits, model, and payload size distribution.

**Core abstraction:**

```typescript
interface BatchProcessor<TInput, TOutput> {
  process(items: TInput[]): Promise<BatchResult<TOutput>>;
}

interface BatchResult<T> {
  results: Array<{ item: unknown; result: T }>;
  failed: Array<{ item: unknown; error: Error }>;
  metrics: BatchMetrics;
}

interface BatchMetrics {
  totalItems: number;
  totalBatches: number;
  successfulBatches: number;
  failedBatches: number;
  avgBatchSize: number;
  durationMs: number;
}
```

**Configurability:**

| Parameter              | Default | Effect                                                | Dangerous Extreme                                  |
| ---------------------- | ------- | ----------------------------------------------------- | -------------------------------------------------- |
| `maxBatchSize`         | 20      | Items per batch sent to provider                      | Too large → memory pressure, timeout on slow items |
| `maxConcurrentBatches` | 3       | Batches running simultaneously                        | Too high → rate limit 429s                         |
| `flushIntervalMs`      | 100     | Max wait before flushing partial batch                | Too long → idle waiting for items that never come  |
| `retryAttempts`        | 3       | Retries per failed batch                              | Too high → amplifies rate limit backpressure       |
| `retryDelayMs`         | 1000    | Base delay between retries (with exponential backoff) | Too low → retry storm under 429 conditions         |
| `itemTimeoutMs`        | 30000   | Per-item processing timeout                           | Too short → false failures on slow model responses |

> These defaults are starting points. The right values depend on your provider's rate limits, model latency characteristics, and payload size distribution. A provider with 500 RPM and 1M TPM tolerates very different settings than one at 50 RPM / 50K TPM.

**Key design tradeoffs:**

- **Item-level vs. batch-level failure tracking**: When a batch fails, the naive approach marks all items in it as failed. This forces re-processing entire batches on partial failures. I track failures at the item level — a failed batch gets its items individually retried or reported, not the batch itself.
- **Fixed batches vs. dynamic windowing**: Fixed-size batches are simple but waste time waiting for a batch to fill when items arrive at uneven rates. The flush interval ensures partial batches don't wait indefinitely — a batch fires when `maxBatchSize` is hit OR `flushIntervalMs` elapses.
- **Concurrency at the batch level**: Limiting concurrency at the batch level (not item level) is easier to reason about for rate limit budgeting. 3 concurrent batches × 20 items/batch = 60 items in flight at once, not 60 individual concurrent API calls.
- **Managed batch APIs vs. real-time batching**: This implementation covers real-time client-side batching (group items into multi-prompt requests or parallel calls). Managed batch APIs (Anthropic Message Batches, OpenAI Batch API) offer 50% cost savings but introduce hours of latency — a separate use case covered in the Tuning section.

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

| Failure Mode                                                                                                                                                                                                                      | Detection Signal                                                                                             | Mitigation                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rate limit cascade** — concurrent batches all hit 429 at once; retry waves overlap and amplify the spike                                                                                                                        | Spike in 429 response codes; retry queue depth growing; batch throughput drops to near zero                  | Exponential backoff with jitter per batch; reduce `maxConcurrentBatches` on 429 detection; use a token bucket or leaky bucket rate limiter upstream of batch dispatch |
| **Batch timeout skew** — one slow item in a batch causes the entire batch to time out, losing results for the other items that completed                                                                                          | p99 batch latency >> p50 batch latency; items with `itemTimeoutMs` exceeded cluster in specific batches      | Set per-item timeout independently of batch timeout; on batch timeout, report completed items as successful and only retry the slow items                             |
| **Memory pressure from large batches** — accumulating items for a large batch fills heap before the batch dispatches                                                                                                              | Process memory growing monotonically during job; OOM errors on batch assembly                                | Cap `maxBatchSize` and enforce memory-based flush triggers (not just count-based); validate total token count before dispatching                                      |
| **Silent throughput degradation** _(silent degradation)_ — as average payload size grows over months (longer prompts, more context), effective batch throughput drops without any error signal; job durations creep upward 20-30% | Job duration dashboards trending upward slowly; tokens-per-batch increasing in metrics; no error rate change | Monitor avg tokens per batch, not just avg items per batch; add token-count based auto-scaling for `maxBatchSize`                                                     |
| **Partial batch loss on process crash** — in-flight batches are lost when the process restarts; no record of which items were sent but not yet received                                                                           | Job counts don't match input counts; downstream consumers see gaps                                           | Persist batch state before dispatch; use [State Checkpointing](../../orchestration/state-checkpointing/) pattern for long-running jobs                                |
| **Backpressure stall** — `maxConcurrentBatches` is hit and new items accumulate in the input queue faster than batches complete; queue grows unbounded                                                                            | Input queue depth growing; worker utilization at 100%; items older than expected completion time             | Implement bounded input queue with backpressure to callers; shed load with explicit error rather than accepting unbounded queue growth                                |

## Observability & Operations

**Key metrics:**

| Metric                              | Unit      | What It Tells You                                                           |
| ----------------------------------- | --------- | --------------------------------------------------------------------------- |
| `batch.items_per_batch` (p50, p95)  | items     | Whether batches are filling efficiently; low p50 means sparse arrival rate  |
| `batch.throughput`                  | items/sec | Overall job throughput; primary health indicator                            |
| `batch.latency` (p50, p95, p99)     | ms        | Per-batch processing time; skew between p50 and p99 signals timeout issues  |
| `batch.error_rate`                  | %         | Fraction of batches failing; distinguish 429 vs. timeout vs. provider error |
| `batch.retry_count` (p50, p95)      | retries   | High values indicate rate pressure or provider instability                  |
| `batch.tokens_per_batch` (p50, p95) | tokens    | Leading indicator for memory pressure and provider token limits             |
| `batch.queue_depth`                 | items     | Current input queue size; growing depth signals backpressure stall          |
| `batch.concurrent_batches`          | count     | Real-time concurrency vs. configured maximum                                |

**Alerting:**

| Alert                  | Condition                                                | Severity | Check First                                                              |
| ---------------------- | -------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| Throughput collapse    | `batch.throughput` drops >50% vs. 5-min baseline         | Critical | Check error_rate for 429 spike; reduce maxConcurrentBatches              |
| High error rate        | `batch.error_rate` > 10% over 5 min                      | Warning  | Distinguish 429 (rate limit) vs. 5xx (provider down) vs. timeout         |
| Queue depth growing    | `batch.queue_depth` > 10× avg batch size for >2 min      | Warning  | Check concurrent_batches at ceiling; check provider latency              |
| Retry storm            | `batch.retry_count` p95 > 5                              | Warning  | Check for 429 cascades; add jitter if not present; check provider status |
| Token budget proximity | `batch.tokens_per_batch` p95 > 80% of provider TPM limit | Warning  | Reduce maxBatchSize or maxConcurrentBatches to stay within TPM           |

> These thresholds are starting points. A batch job running against a high-tier provider with generous rate limits will tolerate very different values than one on a free or low-tier plan. Calibrate against your baseline throughput and provider limits.

**Runbook:**

_429 storm (throughput collapse + high error rate):_

1. Immediately reduce `maxConcurrentBatches` to 1
2. Confirm provider rate limit tier and current usage in provider dashboard
3. Check for overlapping jobs (multiple processes hitting same API key)
4. Re-enable concurrency gradually with 30s intervals between increases
5. If job must complete urgently, rotate to a secondary API key with fresh rate limit budget

_Queue backpressure stall (queue_depth growing):_

1. Check `batch.concurrent_batches` — if at max, provider latency has increased
2. Check provider status page for degradation
3. If provider is healthy, consider increasing `maxConcurrentBatches` by 1 increment
4. If provider is degraded, apply backpressure to input source (pause feeder process)

_Job completion count mismatch (items lost):_

1. Check for mid-job process restarts (check process logs for OOM or unhandled exceptions)
2. Cross-reference input item count vs. result count
3. If gap exists, identify missing item IDs and resubmit as a recovery batch
4. Add [State Checkpointing](../../orchestration/state-checkpointing/) for future jobs

## Tuning & Evolution

**Tuning levers:**

| Parameter              | Safe Range | Effect of Increasing                                | Effect of Decreasing                   | Dangerous Extreme                                     |
| ---------------------- | ---------- | --------------------------------------------------- | -------------------------------------- | ----------------------------------------------------- |
| `maxBatchSize`         | 5–50 items | Higher throughput per batch, more memory use        | Lower latency per item, easier to fill | >100: memory pressure, single slow item poisons batch |
| `maxConcurrentBatches` | 1–10       | Higher overall throughput, more rate limit pressure | Safer rate budgeting, lower throughput | >20: guaranteed 429 cascades on most providers        |
| `flushIntervalMs`      | 50–500 ms  | Fewer partial batches, higher per-item latency      | More partial batches, lower latency    | >5000: jobs stall waiting for stragglers              |
| `retryAttempts`        | 2–5        | Higher success rate on transient failures           | Lower retry amplification under 429    | >10: retry storms extend job duration dramatically    |

**Drift signals (review every 4–6 weeks for active batch workloads):**

- **Avg payload size is growing**: If prompts are getting longer (added context, longer documents), `maxBatchSize` may need to decrease to avoid token limit hits. Track `tokens_per_batch` trend, not just `items_per_batch`.
- **Provider rate limit tier changed**: If you upgraded (or downgraded) your API tier, `maxConcurrentBatches` needs recalibration. A Tier 4 account tolerates 4× the concurrency of a Tier 1.
- **Job duration creeping up without error increase**: The silent degradation signal. Root cause is usually payload growth or a new prompt template that's significantly longer. Check `tokens_per_batch` history.
- **Managed batch API pricing changed**: Both Anthropic and OpenAI occasionally adjust batch pricing. For workloads where latency tolerance is high (>1 hour), it's worth re-evaluating whether managed batch APIs offer better economics than real-time batching.

**Silent degradation:**

The failure mode that nobody notices for months: average payload size grows as the system evolves — longer prompts, added context, new fields — while `maxBatchSize` stays fixed. Batches start hitting provider token limits before they hit the item count limit. The provider silently truncates or rejects some items in a batch. Result counts drift below input counts by a fraction that's easy to miss (99.2% success looks fine until you're losing 8,000 items per million). Check job completion rates against input counts, not just error rates.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers.

| Scale        | Additional Cost  | ROI vs. No Pattern                                             |
| ------------ | ---------------- | -------------------------------------------------------------- |
| 1K req/day   | ~$0 (in-process) | Managed batch API saves `~$1.63/day` ($49/mo) with GPT-4o      |
| 10K req/day  | ~$0 (in-process) | Managed batch API saves `~$16.25/day` ($488/mo) with GPT-4o    |
| 100K req/day | ~$0 (in-process) | Managed batch API saves `~$162.50/day` ($4,875/mo) with GPT-4o |

## Testing

Both implementations have mirrored test suites. See `src/ts/__tests__/index.test.ts` and `src/py/tests/test_index.py`.

- **Unit tests:** I'd want to see coverage of batch splitting logic (even division, remainder batches, single-item input, empty input), partial-flush behavior (items below `maxBatchSize` aren't stranded), and metrics accuracy (totalItems, totalBatches, successCount, failureCount, avgBatchSize, durationMs all reflect actual processing). Both suites cover these.
- **Failure mode tests:** The suites verify retry with exponential backoff on transient errors (succeed on second attempt, exhaust retries after N failures), per-item timeout (hanging providers don't block forever, timeout scales with batch size), rate limit (429) recovery via retry, partial batch failure where successful items are preserved and missing items get descriptive errors, and non-retryable errors like "context length exceeded" or invalid input that skip retries entirely.
- **Integration tests:** End-to-end tests feed 35-100 items through a `MockLLMProvider`, verify every result maps back to its input, and confirm the mock response format. Concurrency tests assert that `maxConcurrentBatches` is never exceeded under load. A sequential-vs-concurrent timing test verifies that parallelism actually reduces wall-clock time. High-concurrency rate-limit tests confirm the system recovers when initial batches get throttled.
- **What to regression test:** I'd keep an eye on batch boundary edge cases (off-by-one in splitting, empty input, `maxBatchSize: 1`), retry timing under backoff (the exponential delay assertions use a 1.3x tolerance — tightening that can flake on slow CI), and the concurrency cap (the peak-concurrent tracking test is timing-sensitive with short sleep values).

## When This Advice Stops Applying

- Real-time user-facing requests where batching adds latency users notice (chatbots, streaming interfaces, live search)
- Interactive agent loops where each step requires the previous response before the next can be formed
- Very low volume workloads (under ~500 items/job) where batch overhead — wait time, complexity, error handling — isn't justified by throughput gains
- Streaming systems where responses must start immediately — managed batch APIs are explicitly incompatible
- Workloads requiring Zero Data Retention — Anthropic's [Message Batches API excludes ZDR](https://platform.claude.com/docs/en/build-with-claude/zero-data-retention); for those use cases, real-time API with client-side concurrency control is the only option
- Single-item processing pipelines where there's nothing to aggregate — the complexity has no payoff

<!-- ## Companion Content

- Blog post: [Request Batching — Deep Dive](https://prompt-deploy.com/request-batching) (coming soon)
- Related patterns:
  - [Concurrent Request Management](../concurrent-request-management/) (#23, S7) — manages how many batches run in parallel; the two patterns layer together
  - [Latency Budget](../latency-budget/) (#14, S4) — batching trades per-item latency for throughput; the budget determines the acceptable tradeoff
  - [Token Budget Middleware](../../cost-control/token-budget-middleware/) (#3, S1) — batching affects token spend per request; token budgets prevent runaway costs during batch jobs
  - [State Checkpointing](../../orchestration/state-checkpointing/) (#25, S7) — checkpoints batch progress so long-running jobs can recover after failure without reprocessing everything -->

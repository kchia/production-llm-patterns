# Output Quality Monitoring

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

Your LLM returns 200 OK and the response looks like JSON. The logs are clean. Latency is fine. But the answers are wrong — or worse, they're subtly worse than they were last month, and nobody's noticed yet.

A [Stanford/UC Berkeley study](https://arxiv.org/abs/2307.09009) tracked GPT-4's behavior across just three months in 2023 and reported that accuracy on a prime number identification task dropped from 97.6% to 2.4% between the March and June versions of the same model. Code generation executability fell from 52% to 10%. These weren't announced changes — they happened silently behind the same API endpoint.

[Anthropic's August 2025 postmortem](https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues) described the same pattern from a different angle: infrastructure bugs in the model serving path caused subtle quality degradation across multiple Claude models. Users reported inconsistent outputs and character corruption for weeks before the root cause was identified. The bug traced back to a bf16/fp32 precision mismatch in the XLA compiler's optimization path — an infrastructure issue, not a model issue, that traditional monitoring couldn't catch.

The failure mode isn't dramatic. It's a slow erosion — responses get slightly less relevant, summaries miss key points more often, classifications drift toward the wrong categories. Without quality baselines and continuous scoring, teams discover these problems when customers complain, often weeks after the degradation started. By then, multiple overlapping changes (prompt updates, model version bumps, shifting input distributions) make root-cause analysis nearly impossible.

## What I Would Not Do

The first instinct is spot-checking: pull a few production responses, eyeball them, declare things "look fine." This works when you're handling 50 requests a day. At 10K requests/day across multiple prompt templates and model versions, spot-checking covers maybe 0.1% of traffic. Quality problems that affect 5% of responses — enough to drive user complaints — slip through entirely.

The second instinct is relying on traditional APM metrics: latency, error rates, token counts. These tell you the system is running. They tell you nothing about whether the answers are any good. A model that hallucinating 30% more than last week still returns 200 OK with perfectly normal latency.

The third instinct is running evals only in CI/CD. Offline evaluation catches regressions against curated test sets, but production traffic is messier, more diverse, and changes over time. An eval suite that covers 95% of your test cases might miss the long-tail inputs that represent 20% of real production traffic. The gap between "passes evals" and "works well in production" is where quality problems hide.

## When You Need This

- Your system's been in production for more than a few weeks and you've had at least one "when did that start happening?" conversation about output quality
- A model provider updated their model behind the same API endpoint, and you had no way to measure the impact on your specific use case
- Your p50 user satisfaction or task completion rate is drifting down but you can't correlate it to any specific change
- You're running multiple prompt templates or model versions and can't compare quality across them
- Manual review of outputs is no longer feasible — you're past ~500 requests/day
- You've built an eval harness (see [Eval Harness](../../testing/eval-harness/)) and want to extend quality measurement from CI into production

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

| System Type   | Designation | Reasoning                                                                                                                                                                                                                                                                                                                                 |
| ------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RAG**       | Required    | Retrieval quality and generation quality are two separate failure surfaces. I wouldn't want to get paged because answer relevance degraded — especially when the root cause might be in the retrieval layer, the generation layer, or the interaction between them. Quality scoring on production traffic is how I'd tell the difference. |
| **Agents**    | Required    | Agents make multi-step decisions where each step's quality compounds. A 5% drop in tool-call accuracy at step 1 can become a 20% failure rate by step 4. I'd want per-step quality scoring to catch degradation before it cascades through the loop.                                                                                      |
| **Batch**     | Required    | Batch jobs process thousands of items without a user watching. Quality problems in batch are invisible until the results are consumed downstream — by which point you've wasted the entire run. I'd want quality sampling during execution, not just a pass/fail at the end.                                                              |
| **Streaming** | Recommended | Streaming systems have tighter latency constraints that limit how much evaluation you can do inline. Quality monitoring still matters, but I'd lean toward async scoring of completed responses rather than blocking the stream. The latency budget matters more here.                                                                    |

## The Pattern

### Architecture

```
 1. Record             LLM Interaction (input + output + metadata)
                               │
                               ▼
 2. Sample      ┌─────────────────────────┐
                │        Sampler          │
                │  rate-based / strategic │
                └────────┬────────────────┘
                    keep │        │ discard
                         │        └──────── (no-op)
                         ▼
 3. Score       ┌─────────────────────────┐
                │    Scorer Registry      │
                │                         │
                │  deterministic scorers  │
                │  + heuristic scorers    │
                └────────┬────────────────┘
                         │ ScoreResult[]
                         ▼
 4. Store       ┌─────────────────────────┐
                │      Score Store        │
                │  scores + metadata      │
                └────────┬────────────────┘
                         │
                         ▼
 5. Aggregate   ┌─────────────────────────┐
                │      Aggregator         │
                │  window-based rollups   │
                │  per dimension          │
                └────────┬────────────────┘
                         │
                ┌────────┴────────┐
                ▼                 ▼
 6. Evaluate  ┌───────────┐  ┌───────────┐
              │ Baseline  │  │ Alerting  │
              │ Tracker   │  │ Engine    │
              │           │  │           │
              │ rolling   │  │ threshold │
              │ baselines │──▶ + trend   │
              │ per dim   │  │ checks    │
              └───────────┘  └─────┬─────┘
                                   │
                              alert / ok
```

_Numerical thresholds shown in configurability table below are illustrative starting points — actual values depend on your SLA, traffic patterns, and quality requirements._

**Core abstraction: `QualityMonitor`**

The central interface wraps the async scoring pipeline. It accepts completed LLM interactions (input + output + metadata), decides whether to score them, runs applicable scorers, and feeds results to the aggregator.

```typescript
interface QualityMonitor {
  // Record a completed LLM interaction for potential scoring
  record(interaction: LLMInteraction): Promise<void>;

  // Get current quality scores for a dimension (prompt template, model, etc.)
  getScores(dimension: string, window?: TimeWindow): QualitySnapshot;

  // Register a custom scorer
  registerScorer(scorer: Scorer): void;

  // Check if quality is within acceptable bounds
  checkHealth(dimension?: string): HealthStatus;
}

interface Scorer {
  name: string;
  // Score a single interaction. Returns 0.0-1.0.
  score(interaction: LLMInteraction): Promise<ScoreResult>;
}
```

**Key components:**

- **Sampler**: Decides which interactions to score. Rate-based sampling (e.g., 10% of traffic) for steady-state, with strategic oversampling of new prompt versions, model changes, or error-adjacent requests.
- **Scorer Registry**: Holds registered scorers. Deterministic scorers (regex checks, format validation, length bounds) run on every sample. Heuristic scorers (embedding similarity, keyword overlap) run on configurable subsets.
- **Aggregator**: Rolls up individual scores into time-windowed summaries per dimension (prompt template, model version, input category). Computes p50/p95/mean and tracks score distributions.
- **Score Store**: Persists individual scores with full metadata for debugging. In-memory for the reference implementation, pluggable for production (Redis, Postgres, etc.).
- **Baseline Tracker**: Maintains rolling baselines per dimension. New scores are compared against the baseline to detect drift. Baselines update slowly (configurable decay) to avoid chasing noise.
- **Alerting Engine**: Fires alerts when scores breach thresholds or when trend detection identifies sustained degradation. Supports both absolute thresholds and relative-to-baseline checks.

**Configurability:**

| Parameter            | Default                       | Description                                                                 |
| -------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| `sampleRate`         | `0.1` (10%)                   | Fraction of traffic to score                                                |
| `windowSize`         | `1h`                          | Aggregation window for score rollups                                        |
| `baselineDecay`      | `0.95`                        | Exponential decay factor for rolling baselines (higher = slower adaptation) |
| `absoluteThreshold`  | `0.7`                         | Minimum acceptable quality score (0.0-1.0)                                  |
| `relativeThreshold`  | `0.1`                         | Maximum acceptable drop from baseline before alerting                       |
| `minSamplesForAlert` | `30`                          | Minimum samples in a window before alerts can fire                          |
| `dimensions`         | `['promptTemplate', 'model']` | Metadata fields to aggregate scores by                                      |
| `scorerTimeout`      | `5000ms`                      | Maximum time for a single scorer to complete                                |

_These defaults are starting points. Your SLA, provider characteristics, and data freshness requirements will shift them — a system with a strict quality SLA might need a higher `absoluteThreshold`, while a high-traffic system might lower `sampleRate` to manage scoring costs._

**Key design tradeoffs:**

1. **Async scoring vs. inline scoring.** Scoring happens after the response is sent, not in the critical path. This means quality alerts are delayed by the scoring pipeline's latency (seconds to minutes), but production latency is unaffected. For most use cases, knowing about a quality problem 60 seconds later is fine — the alternative (adding 200-500ms to every response for inline scoring) isn't worth the latency cost.

2. **Deterministic + heuristic scorers, no LLM-as-judge in the core loop.** The reference implementation deliberately avoids using an LLM to judge another LLM's output. LLM-as-judge adds significant cost, latency, and its own failure mode (what happens when the judge model degrades?). Deterministic scorers (format validation, length checks, keyword presence) and heuristic scorers (embedding similarity to reference answers, structural checks) catch most quality issues at near-zero marginal cost. LLM-as-judge can be added as a custom scorer for specific use cases, but it's not the default.

3. **Per-dimension aggregation vs. global scores.** Quality is tracked per dimension (prompt template, model version, input category) rather than as a single global number. A global average hides localized problems — one prompt template degrading 30% while others improve slightly can result in a flat global score. Per-dimension tracking catches these immediately.

4. **Rolling baselines vs. fixed baselines.** Baselines decay slowly toward current performance rather than being fixed at a point-in-time snapshot. This handles legitimate quality improvements (you don't want to alert on getting better) while still catching sustained degradation. The tradeoff: very slow degradation (1% per week) might update the baseline faster than it triggers an alert. The silent degradation failure mode section addresses this.

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

How this pattern itself can fail. Every solution creates new failure modes.

| Failure Mode                                                          | Detection Signal                                                                                                                                                             | Mitigation                                                                                                                                                                                                         |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scorer returns stale or wrong scores due to bug                       | Quality scores remain flat or show implausible values (e.g., 1.0 for all samples) while user complaints increase                                                             | Run a known-bad sample through scorers periodically as a canary. If the canary scores above threshold, the scorer is broken.                                                                                       |
| Sample rate too low to detect localized degradation                   | Alert fires late or not at all. Quality drop visible in user feedback but not in scores.                                                                                     | Set `minSamplesForAlert` relative to traffic volume. For low-traffic dimensions, increase sample rate or use strategic sampling for those dimensions specifically.                                                 |
| Aggregation window too wide masks sharp drops                         | Quality dips and recovers within a single window, never breaching the threshold                                                                                              | Use multiple window sizes (5m, 1h, 24h). Short windows catch spikes; long windows catch trends. Alert on either.                                                                                                   |
| Scorer timeout causes silent drops                                    | Scoring throughput drops, `scorer_timeout_count` metric increases, score coverage falls below expected sample rate                                                           | Monitor scorer completion rate. If >5% of scoring attempts timeout, investigate scorer performance. Fall back to deterministic-only scoring if heuristic scorers are failing.                                      |
| Baseline drift masks slow degradation (silent degradation)            | Quality scores are "normal" relative to baseline, but absolute scores have dropped 15-20% over 3-6 months. No alerts fire because the baseline decayed with the degradation. | Track absolute scores alongside baseline-relative scores. Set a hard floor (`absoluteThreshold`) that doesn't decay. Run monthly baseline audits comparing current baselines against the original launch baseline. |
| Dimensional explosion: too many dimensions create sparse aggregations | Most dimensions have fewer than `minSamplesForAlert` samples, alerts never fire for rare dimensions                                                                          | Limit dimension cardinality. Use hierarchical dimensions (aggregate rare prompt templates into a "long tail" bucket). Monitor the percentage of dimensions with sufficient samples.                                |
| Scoring pipeline backpressure under load                              | Score store write latency increases, scoring queue depth grows, samples are dropped                                                                                          | Implement backpressure: when queue depth exceeds a threshold, temporarily reduce sample rate rather than dropping samples silently. Monitor queue depth and processing lag.                                        |

## Observability & Operations

### Key Metrics

| Metric                                   | Unit    | Collection                   | What It Tells You                                                                    |
| ---------------------------------------- | ------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| `quality_score_mean` (per dimension)     | 0.0-1.0 | Aggregator rollup per window | Current output quality level for each prompt template / model                        |
| `quality_score_p95` (per dimension)      | 0.0-1.0 | Aggregator rollup per window | Tail quality — catches dimensions with mostly-good but occasionally-terrible outputs |
| `quality_baseline_value` (per dimension) | 0.0-1.0 | Baseline tracker             | Rolling baseline — compare against absolute threshold to detect slow drift           |
| `scorer_timeout_rate`                    | %       | `scorer_timeouts / sampled`  | Health of the scoring pipeline itself                                                |
| `sample_coverage`                        | %       | `sampled / recorded`         | Actual vs. expected sample rate — drops indicate backpressure                        |
| `queue_drop_rate`                        | %       | `queueDropped / recorded`    | Backpressure — nonzero means the scoring pipeline can't keep up                      |
| `scoring_latency_p95`                    | ms      | Per-scorer timing            | Individual scorer performance — catch degrading scorers early                        |
| `dimensions_below_min_samples`           | count   | Per-window check             | Number of dimensions without enough samples to alert — measures dimensional sparsity |

### Alerting

| Severity | Condition                                                                            | Action                                                                                                               |
| -------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Warning  | `quality_score_mean` < `absoluteThreshold` for any dimension with sufficient samples | Check which dimension and which scorer triggered it. Often a single prompt template or model version is the culprit. |
| Warning  | `quality_score_mean` dropped > `relativeThreshold` from baseline                     | Something changed recently — correlate with deployment timestamps, model version updates, and prompt changes.        |
| Critical | `quality_score_mean` < 50% of `absoluteThreshold` for any dimension                  | Quality has dropped well below acceptable levels. This is a customer-impacting issue.                                |
| Warning  | `scorer_timeout_rate` > 5%                                                           | A scorer is failing. The pipeline continues without it, but you're losing visibility.                                |
| Warning  | `queue_drop_rate` > 1%                                                               | Scoring can't keep up with traffic. Increase `maxQueueDepth` or reduce `sampleRate`.                                 |
| Low-side | `sample_coverage` suspiciously high (>95% at 10% configured rate)                    | Possible bug in sampling logic, or traffic has dropped dramatically.                                                 |

_These thresholds are starting points. Your baseline score distribution, SLA requirements, and traffic profile will shift them. A system where quality scores normally cluster at 0.95 should alert on smaller drops than one where scores normally range 0.7-0.9._

### Runbook

**Quality score below threshold:**

1. Check which dimension(s) triggered the alert — is it one prompt template or all of them?
2. Check which scorer(s) show the drop — is it length, format, keyword, or all scorers?
3. If localized to one dimension: check for recent prompt changes, model version updates, or input distribution shifts on that dimension specifically
4. If broad across dimensions: check for provider-side changes (model updates, infrastructure issues). Compare against other customers' reports if available.
5. Pull raw scored interactions from the score store for the affected dimension and manually review a sample
6. If root cause is a model update: consider pinning to a previous model version while investigating
7. If root cause is prompt drift: roll back the prompt change or adjust scoring thresholds

**Scorer timeout alert:**

1. Identify which scorer is timing out (`scoring_latency_p95` per scorer)
2. Check if the scorer depends on external resources (network, disk, external API)
3. If the scorer is heuristic: consider increasing `scorerTimeoutMs` or removing the scorer temporarily
4. Verify remaining scorers are still running — the pipeline should degrade gracefully

**Queue drop alert:**

1. Check traffic volume — has it spiked?
2. Check scorer latency — has a scorer gotten slower?
3. Short-term: increase `maxQueueDepth` or decrease `sampleRate`
4. Long-term: optimize slow scorers or move to a dedicated scoring worker

## Tuning & Evolution

### Tuning Levers

| Lever                | Safe Range | Dangerous Extreme                                                                 | Effect                                                                 |
| -------------------- | ---------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `sampleRate`         | 0.05-0.20  | <0.01 (misses localized degradation), >0.5 (unnecessary cost for LLM judges)      | Controls scoring volume. Lower = cheaper but slower detection.         |
| `baselineDecay`      | 0.90-0.99  | <0.8 (chases noise), >0.995 (never adapts to legitimate changes)                  | How fast baselines track toward current scores.                        |
| `absoluteThreshold`  | 0.5-0.9    | <0.3 (never alerts), >0.95 (alert fatigue)                                        | Hard floor that doesn't decay. Primary defense against baseline drift. |
| `relativeThreshold`  | 0.05-0.20  | <0.02 (alert fatigue), >0.3 (misses moderate degradation)                         | Maximum acceptable drop from baseline.                                 |
| `minSamplesForAlert` | 10-100     | <5 (noisy alerts from outliers), >500 (slow detection for low-traffic dimensions) | Minimum statistical confidence before alerting.                        |
| `windowSizeMs`       | 15min-4h   | <5min (noisy), >24h (misses intra-day patterns)                                   | Aggregation window for score rollups.                                  |

### Drift Signals

| Signal                                                  | Meaning                                                                                                                                                   | Review Cadence |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Baseline values trending down across all dimensions     | Quality is degrading globally — likely a provider-side change                                                                                             | Monthly        |
| Score variance increasing within a dimension            | Output consistency is dropping — the model is becoming less predictable. Could indicate training data shifts or temperature changes on the provider side. | Monthly        |
| Alert frequency increasing over time                    | Either quality is genuinely degrading or thresholds need recalibration                                                                                    | Quarterly      |
| Scorer timeout rate creeping up                         | A heuristic scorer may be degrading (e.g., an embedding model it depends on is getting slower)                                                            | Monthly        |
| New prompt templates appearing without quality coverage | Teams are shipping new prompts without registering them with quality monitoring                                                                           | Weekly         |

### Silent Degradation

**Month 3:** The baseline has quietly adapted to lower quality scores. The system started at a mean quality of 0.92, but it's now 0.85. No alerts fired because `baselineDecay=0.95` tracked the decline. The `absoluteThreshold` of 0.7 hasn't been breached yet.

**How to catch it:** Compare current baseline values against the launch-day baselines you stored separately. If the gap exceeds 10%, investigate. Run this comparison monthly as a scheduled job.

**Month 6:** Input distribution has shifted. A new category of user queries that the model handles poorly now represents 15% of traffic. Per-dimension scores for the original dimensions still look fine — the new queries are spread across existing prompt templates, diluting their signal.

**How to catch it:** Add input-category dimensions (even coarse ones — topic, complexity tier, user segment). Monitor for new dimension values appearing. Set up a weekly report of "dimensions with fewest samples" to spot under-monitored categories.

**Proactive checks:**

| Cadence   | Check                                                                     |
| --------- | ------------------------------------------------------------------------- |
| Monthly   | Compare current baselines to launch baselines                             |
| Monthly   | Review scorer timeout rates and scoring pipeline health                   |
| Quarterly | Audit dimension coverage — are all active prompt templates being scored?  |
| Quarterly | Review whether scoring criteria still match business quality requirements |

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers.

| Scale        | Additional Cost                                            | ROI vs. No Pattern                                             |
| ------------ | ---------------------------------------------------------- | -------------------------------------------------------------- |
| 1K req/day   | +$0.01/day (deterministic) to +$0.70/day (with LLM judge)  | Catches quality degradation before users notice                |
| 10K req/day  | +$0.10/day (deterministic) to +$7.00/day (with LLM judge)  | ~22% overhead with same-tier judge; ~7% with mini model        |
| 100K req/day | +$1.00/day (deterministic) to +$70.00/day (with LLM judge) | One prevented quality incident saves weeks of engineering time |

## Testing

See test files in `src/ts/__tests__/index.test.ts`. Run with `cd src/ts && npm test`.

- **Unit tests:** LengthScorer, FormatScorer, KeywordScorer (boundary conditions, edge cases), Sampler (rate accuracy, dimension overrides), ScoreStore (query filtering, eviction), BaselineTracker (exponential decay, convergence), QualityMonitor configuration handling
- **Failure mode tests:** One test per failure mode from the table — broken scorer detection (canary pattern), low sample rate coverage gap, scorer timeout handling, baseline drift masking slow degradation, absolute threshold catching what baseline misses, dimensional explosion resilience, queue backpressure drops
- **Integration tests:** Full pipeline with mock provider (provider → monitor → scores → health check), quality degradation detection from provider drift, cross-template quality comparison
- **What to regression test:** Scoring pipeline shouldn't add latency to the critical path. Baseline decay math. Alert firing thresholds at boundary values. Queue backpressure behavior under concurrent load.

## When This Advice Stops Applying

- **Prototyping and early experimentation.** If you're still defining what "good" looks like for your use case, you don't have a quality baseline to monitor against. Define your quality criteria first — this pattern builds on that foundation.
- **Extremely low volume systems.** If you're processing fewer than ~100 requests/day, manual review of all outputs is feasible and probably more effective than automated scoring. The overhead of maintaining scoring infrastructure isn't worth it until volume makes manual review impractical.
- **Purely creative or generative applications** where "quality" is inherently subjective and can't be reduced to scoring dimensions. A creative writing assistant doesn't have a "correctness" axis the way a classification or extraction task does. You can still monitor consistency and user engagement, but automated quality scoring has limited value.
- **Systems where the LLM is a small, replaceable component.** If the LLM generates a draft that's always human-reviewed and edited before use, the human review is your quality gate. Automated monitoring adds cost without changing the decision point.
- **When provider-side monitoring improves significantly.** If model providers start publishing per-version quality benchmarks on task distributions similar to yours, the gap this pattern fills gets smaller. That hasn't happened yet, but it's worth watching.

<!-- ## Companion Content

- Blog post: [Output Quality Monitoring — Deep Dive](https://prompt-deploy.com/output-quality-monitoring) (coming soon)
- Related patterns:
  - [Eval Harness](../../testing/eval-harness/) — defines the quality metrics that this pattern monitors in production
  - [Structured Tracing](../structured-tracing/) — provides the trace data that quality scores are attached to
  - [Online Eval Monitoring](../online-eval-monitoring/) — extends quality monitoring with production eval sampling
  - [Drift Detection](../drift-detection/) — detects when quality metrics trend away from baseline
  - [Prompt Diffing](../prompt-diffing/) — correlates quality changes with prompt changes -->

# Drift Detection

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

Model behavior changes without warning — and without drift detection, you find out when users file support tickets saying "it used to work better." By then the degradation has been compounding for weeks.

The mechanism is straightforward: provider-hosted models update in place. [Chen et al. (2023)](https://arxiv.org/abs/2307.09009) studied GPT-3.5 and GPT-4 across March and June 2023 and found that GPT-4's accuracy on prime-number identification dropped from 84% to 51% between those snapshots — while the model endpoint name stayed the same. (The original preprint reported a more dramatic 97.6% → 2.4% drop; the authors revised downward in v3, but the core finding holds: significant degradation with no version change.) Code generation and instruction-following also degraded. Nothing "failed" in the error-rate sense; the system kept responding. The degradation was only visible if you had a baseline to compare against.

Input distributions shift too. Your user base evolves, you expand to new markets, you ship a new feature that attracts a different query type. The model that performed well on your launch-week corpus may encounter an increasingly different population of prompts six months later — and without tracking the distribution over time, there's no way to know when the mismatch becomes material.

The result is that dashboards stay green, latency stays flat, error rates stay low, and quality quietly erodes. The signal only surfaces in aggregate eval scores, downstream parse rates, or support tickets — and by then the degradation has been running for weeks.

## What I Would Not Do

The instinct is to monitor outputs manually — review a sample of responses each week and trust your judgment. I understand why teams start here: it's the lowest implementation friction path. But it doesn't scale past a few hundred requests per day, and it's particularly bad at detecting the slow changes that matter most.

The other common approach is to alert on hard error rates and latency. Those metrics are real and worth tracking, but they only catch failures — not degradation. A model that starts being 15% more verbose, starts refusing edge-case inputs it used to handle, or starts formatting JSON slightly differently won't move your error rate or latency P99. It will move your downstream parse rates, your user satisfaction scores, and your eval pass rates — but those take weeks to surface in aggregate dashboards.

What I wouldn't do: wait for users to notice. The pattern that breaks silently for weeks before anyone flags it is exactly the pattern drift detection exists to catch.

## When You Need This

- Your system has been running for 4+ weeks — long enough to build a meaningful baseline
- You're using provider-hosted models that update without your explicit consent (GPT-4o, Claude Sonnet via API)
- You've already had an incident where behavior changed and you had no timestamp for when it started
- Your downstream logic parses or acts on LLM outputs (structure change = silent breakage)
- Your eval harness runs in CI but you have no equivalent running continuously against production traffic
- You're running batch jobs that process thousands of documents — one quiet prompt shift costs money at scale

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **RAG → Required.** I wouldn't want to get paged on a RAG quality issue without knowing if it's data drift (new document types entering the corpus), input drift (user query patterns shifting), or model drift (the generator changed). Without drift detection I'd have three possible causes and no way to isolate them. The retrieval layer masks model-level changes — everything looks fine until the final answer quality degrades.
- **Batch → Required.** Batch jobs amplify drift because the same degraded behavior runs across thousands of documents before anyone notices. A model that started generating slightly shorter summaries compresses batch output costs — until downstream systems that expect minimum-length outputs start failing. I'd want continuous distribution tracking on batch job outputs, not just per-run success/fail.
- **Agents → Recommended.** Agents fail loudly — tool call errors, loop guards firing, output validation rejections. Drift adds a quieter failure mode on top: the model starts choosing different tool sequences, writing slightly different reasoning traces, or varying its JSON structure within valid bounds. These don't trigger hard failures but they do change agent behavior in ways that matter over time. Worth tracking once the core reliability patterns are in place.
- **Streaming → Optional.** Real-time streaming is latency-sensitive and short-context. Quality variation in streaming is usually visible immediately to users and shows up in session feedback. The slow-drift problem that makes this pattern valuable in RAG and Batch is less acute here. Adopt it once the core streaming reliability concerns (backpressure, circuit breaking, failover) are handled.

## The Pattern

### Architecture

```
Production Traffic
        │
        ▼
┌──────────────────────────────────┐
│  DriftDetector.observe(req,resp) │
└────────────────┬─────────────────┘
                 │
    ┌────────────┴──────────────────┐
    │                               │
    ▼                               ▼
┌────────────────────┐   ┌──────────────────────┐
│  Input Window      │   │  Output Score Window  │
│  (hashes / lens)   │   │  (scores, lengths,    │
│  rolling N samples │   │   format fingerprints)│
└──────────┬─────────┘   └──────────┬────────────┘
           │                        │
           └────────────┬───────────┘
                        │  current stats
                        ▼
             ┌──────────────────────┐
             │    DriftAnalyzer     │◄──── Baseline Store
             │  compare(current,    │      (pinned snapshot,
             │   baseline)          │       forceBaselineSnapshot)
             └──────────┬───────────┘
                        │ drift score per dimension
           ┌────────────┴────────────┐
           │                         │
    below threshold            above threshold
           │                         │
           ▼                         ▼
    ┌─────────────┐        ┌──────────────────────┐
    │  no-op      │        │  DriftAlert          │
    │  (log score)│        │  {dimension, score,  │
    └─────────────┘        │   severity, window}  │
                           └───────────┬──────────┘
                                       │
                           ┌───────────▼──────────┐
                           │  Trace Logger        │
                           │  (Structured Tracing)│
                           └──────────────────────┘
```

_Scores above are illustrative — Wasserstein thresholds and ROC-AUC cutoffs depend on your baseline distribution, model type, and acceptable sensitivity. Start conservative and tighten based on false-positive rate._

### Core Abstraction

```typescript
type DriftDimension =
  | "input-length"
  | "output-length"
  | "output-score"
  | "latency";

interface DriftObservation {
  requestId: string;
  timestamp: number; // Unix ms
  inputLength: number; // prompt character length (proxy for input distribution)
  outputLength: number; // response character length
  outputScore?: number; // normalized 0–1, from eval harness if available
  latencyMs: number;
  metadata?: Record<string, unknown>;
}

interface DriftAlert {
  dimension: DriftDimension;
  score: number; // 0–1 normalized drift magnitude
  severity: "warning" | "critical";
  windowStart: number;
  windowEnd: number;
  baselineStats: DistributionStats;
  currentStats: DistributionStats;
}

interface DistributionStats {
  mean: number;
  stdDev: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
  sampleCount: number;
}

class DriftDetector {
  constructor(config: Partial<DriftDetectorConfig>);
  observe(obs: DriftObservation): DriftAlert | null;
  getBaseline(): Map<DriftDimension, DistributionStats> | null;
  getCurrentWindow(): Map<DriftDimension, DistributionStats> | null;
  forceBaselineSnapshot(): void; // pin current window as new baseline
  getBaselineAgeMs(): number | null;
  reset(): void;
}

// Factory
function createDriftDetector(
  config?: Partial<DriftDetectorConfig>
): DriftDetector;
```

### Configurability

| Parameter            | Default | Effect                                                 |
| -------------------- | ------- | ------------------------------------------------------ |
| `baselineWindowSize` | 1000    | Larger = more stable baseline, slower to initialize    |
| `currentWindowSize`  | 500     | Smaller = faster detection, higher false-positive rate |
| `scoreThreshold`     | 0.15    | Lower = more sensitive, more false positives           |
| `minSamplesForAlert` | 100     | Prevents alerts during cold start                      |
| `dimensions`         | all     | Monitor subset to reduce computation                   |

_Defaults are starting points calibrated for moderate-traffic production systems. Systems with high input variety will need a larger baseline window; latency-sensitive systems may want a smaller current window to catch regressions fast._

### Key Design Tradeoffs

**Hash-based vs. embedding-based input drift.** Full embedding drift (Wasserstein distance on embedding vectors) is the most sensitive approach but requires a vector store and adds per-request embedding overhead. Hash-based input drift — tracking the distribution of vocabulary, length buckets, or topic classifiers — is faster and has no external dependency. This implementation uses hash-based tracking by default and is designed to slot in embedding vectors as an optional upgrade once the infrastructure exists.

**Rolling window vs. fixed baseline.** A fixed baseline locks the reference point at launch time, which makes drift scores stable and interpretable. A rolling baseline adapts to drift, which reduces false positives at the cost of masking genuine long-term drift. This implementation uses a fixed baseline that can be manually refreshed — giving teams an explicit "accept this new distribution" decision point.

**Statistical distance vs. LLM-as-judge.** Statistical tests (Wasserstein, cosine distance) detect _that_ something shifted. [LLM-as-judge](https://arxiv.org/abs/2306.05685) evaluation tells you _what_ shifted semantically. This implementation handles the statistical layer. Plugging in output scores from your eval harness (pattern #4) or online eval monitoring (pattern #21) is how you get the semantic signal.

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

| Failure Mode                                                                                                                                                             | Detection Signal                                                                                                     | Mitigation                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Baseline poisoning** — baseline established during anomalous period (launch spike, A/B test, incident) makes all subsequent comparisons unreliable                     | Drift score permanently high or permanently low from day one; alert rate inconsistent with expected traffic patterns | Expose `forceBaselineSnapshot()` so operators can pin a clean baseline; log the timestamp and conditions of every baseline snapshot |
| **Cold-start false positives** — insufficient samples in current window lead to statistically noisy comparisons                                                          | Alerts fire rapidly in first hour of deployment or after a restart with no traffic history                           | Enforce `minSamplesForAlert` threshold; suppress alerts until both baseline and current window have minimum sample counts           |
| **Threshold ossification (silent degradation)** — threshold set during launch week never reviewed; genuine slow drift stays below it for months until cliff-edge failure | No alerts for 3+ months while downstream quality quietly erodes; alert fires only when drift is severe               | Set a monthly review cadence for threshold calibration; log the raw drift score distribution, not just threshold crossings          |
| **Dimension mismatch** — monitoring output length but model starts changing output _structure_ rather than length; structural drift goes undetected                      | Parse failures or format errors in downstream systems not correlated with any drift alert                            | Include multiple dimensions (length, score, format-hash) so structural changes hit at least one detector                            |
| **Baseline staleness after intentional change** — prompt update or intentional model upgrade triggers persistent drift alert; operators dismiss future alerts as noise   | Alert fatigue; legitimate drift alerts ignored because prior intentional-change alerts were suppressed               | Require explicit `forceBaselineSnapshot()` call as part of any intentional prompt or model change deployment runbook                |
| **High-cardinality input masking** — aggregating across diverse query types hides per-topic drift; one topic category degrades while aggregate score stays flat          | Aggregate drift score stable while a specific user segment or query category experiences quality decline             | Segment drift tracking by query category, user cohort, or use case tag when input diversity is high                                 |

## Observability & Operations

### Key Metrics

| Metric                       | Description                                                             | Collection                   |
| ---------------------------- | ----------------------------------------------------------------------- | ---------------------------- |
| `drift.score.input`          | Normalized 0–1 distance between current and baseline input distribution | Per-observation or per-batch |
| `drift.score.output_length`  | Distribution shift in output token length                               | Per-observation              |
| `drift.score.output_quality` | Distribution shift in eval scores (requires eval harness integration)   | Per-eval run                 |
| `drift.baseline.age_days`    | Days since baseline was last pinned                                     | Emitted on schedule          |
| `drift.window.sample_count`  | Current window sample count                                             | Per-observation              |
| `drift.alert.count`          | Alerts fired, by dimension and severity                                 | Per-alert                    |

### Alerting

| Condition                  | Threshold              | Severity | Action                                                  |
| -------------------------- | ---------------------- | -------- | ------------------------------------------------------- |
| Input drift score          | > 0.15                 | Warning  | Investigate input distribution change                   |
| Input drift score          | > 0.30                 | Critical | Escalate; compare recent input samples against baseline |
| Output quality drift score | > 0.10                 | Warning  | Cross-reference with eval harness recent run            |
| Output quality drift score | > 0.20                 | Critical | Pause automated batch jobs; manual review               |
| Baseline age               | > 30 days              | Warning  | Review whether baseline is still representative         |
| Baseline age               | > 90 days              | Critical | Baseline staleness risk; schedule refresh or review     |
| Window sample count        | < `minSamplesForAlert` | Info     | Cold-start period; suppress drift alerts                |

_These thresholds work for moderate-variance systems. High-diversity systems (broad query categories, multi-tenant) will see naturally higher drift scores and may need a higher warning threshold. Tune based on your first 30 days of observed baseline drift._

### Runbook

**Warning: input drift score elevated**

1. Check `drift.baseline.age_days` — if baseline is >30 days old, the alert may reflect legitimate traffic evolution rather than a problem
2. Pull a sample of recent inputs and compare against baseline samples — are there new query types, languages, or topics?
3. If the input shift is intentional (new feature launched, new user segment), call `forceBaselineSnapshot()` and document the change
4. If the shift is unexplained, escalate to investigate upstream changes (product changes, referral source shifts)

**Critical: output quality drift score elevated**

1. Check your eval harness and online eval monitoring dashboards for score degradation
2. Run the model against your regression test suite — did anything that was passing start failing?
3. Check the model provider changelog for recent updates to the model you're using
4. If quality degraded and model hasn't changed, check for input distribution shift that may be sending the model out-of-distribution prompts
5. If model version changed silently, pin to a specific dated version if your provider supports it ([Azure OpenAI](https://learn.microsoft.com/en-us/azure/ai-services/openai/concepts/model-versions), [Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle.html))

**Critical: baseline age > 90 days**

1. Pull baseline and current distribution statistics side by side
2. If distributions are similar, the system is stable — refresh the baseline and reset the age counter
3. If distributions have diverged, treat as a quality drift investigation before refreshing

## Tuning & Evolution

### Tuning Levers

| Lever                    | Safe Range           | Effect at Extreme                                               |
| ------------------------ | -------------------- | --------------------------------------------------------------- |
| `baselineWindowSize`     | 500–5000             | Too small → noisy baseline; too large → long cold-start         |
| `currentWindowSize`      | 100–1000             | Too small → false positives; too large → slow detection         |
| `scoreThreshold`         | 0.05–0.40            | Too low → alert fatigue; too high → misses real drift           |
| `minSamplesForAlert`     | 50–500               | Too low → cold-start alerts; too high → delayed detection       |
| Baseline refresh cadence | Monthly to quarterly | Too frequent → masks drift; too infrequent → baseline staleness |

### Drift Signals

| Month | Pattern                                                 | Interpretation                                                                                                                                           |
| ----- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Alert rate climbs steadily                              | Usually means threshold needs calibration against your specific traffic patterns                                                                         |
| 3     | Persistent low-level warning alerts that never escalate | Threshold may be too sensitive, or genuine slow drift is accumulating                                                                                    |
| 6     | Sudden critical alert after months of silence           | Classic cliff-edge pattern where slow drift finally crosses threshold; investigate whether it's been accumulating since before the last baseline refresh |

Review drift score distributions (not just threshold crossings) monthly. The raw distribution tells you whether you're trending toward a threshold long before you breach it.

### Silent Degradation

The insidious failure mode is **threshold ossification**: the drift threshold is set once at launch and never reviewed. Traffic patterns evolve, input distributions shift gradually, but the threshold doesn't move with them. Slow drift stays below the threshold for months. Meanwhile, downstream quality erodes — eval scores drop 5%, then 8%, then 12% — but no alert fires.

Signs of this at Month 6: eval scores declining quarter-over-quarter, users flagging quality regressions that don't correlate with any deployment, no drift alerts ever. The silence itself is the signal.

The proactive check: every quarter, run your regression test suite against current production traffic samples and compare pass rates to launch-week baselines. If pass rates are declining with no corresponding drift alert, the threshold needs recalibration.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers.

| Scale        | Additional Cost                       | ROI vs. No Pattern                      |
| ------------ | ------------------------------------- | --------------------------------------- |
| 1K req/day   | $0.00/day (statistical only)          | Catch regressions in hours, not weeks   |
| 10K req/day  | $0.02/day (with LLM-as-judge, GPT-4o) | Negligible vs. API spend                |
| 100K req/day | $0.04/day (with LLM-as-judge, GPT-4o) | ~$1.20/month for full semantic analysis |

## Testing

How to verify this pattern works correctly. See test files in `src/ts/` and `src/py/`.

- **Unit tests:** Baseline establishment (correct sample counts, stats calculations), drift score computation per dimension, threshold comparison, cold-start suppression, `forceBaselineSnapshot()` behavior
- **Failure mode tests:** Baseline poisoning (poisoned baseline with anomalous data → verify drift score reflects genuine drift), cold-start suppression (alert suppressed until `minSamplesForAlert` reached), threshold ossification (verify raw score emitted even when below threshold so trend is visible), dimension mismatch (structural change not caught by length-only detector)
- **Integration tests:** End-to-end flow — establish baseline, observe 500 normal requests, inject drifted requests, verify alert fires with correct severity and dimensions
- **How to run:** `cd src/ts && npm test`

## When This Advice Stops Applying

- Prototypes and short-lived systems where long-term stability isn't a concern
- Applications where some output variation is expected and acceptable (creative writing, brainstorming)
- Systems using pinned model versions with no provider-side updates (self-hosted, snapshot models)
- Very new deployments with insufficient history to establish a meaningful baseline

<!-- ## Companion Content

- Blog post: [Drift Detection — Deep Dive](https://prompt-deploy.com/drift-detection) (coming soon)
- Related patterns:
  - [Prompt Version Registry](../prompt-version-registry/) (#10, S3) — correlates drift with prompt version changes
  - [Output Quality Monitoring](../output-quality-monitoring/) (#16, S5) — provides the quality metrics that drift detection trends over time
  - [Online Eval Monitoring](../online-eval-monitoring/) (#21, S6) — production eval scores are a primary drift signal
  - [Structured Tracing](../structured-tracing/) (#8, S3) — trace data provides the raw material for drift analysis
  - [Prompt Diffing](../prompt-diffing/) (#35, S9) — differentiates prompt-caused drift from model-caused drift -->

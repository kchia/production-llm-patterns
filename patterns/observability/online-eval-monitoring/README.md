# Online Eval Monitoring

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

Offline evals run on curated datasets before deployment, but they don't cover what actually happens in production. Real users interact with your system in ways test datasets don't anticipate — different phrasings, edge-case inputs, adversarial prompts, long multi-turn conversations that drift from your training scenarios. Without online eval, your CI stays green while production quality silently degrades.

The gap tends to widen over time. A prompt update that improves one task can silently break adjacent workflows because the regression suite didn't cover that combination. A model provider update, a shift in user behavior, a subtle change in how upstream context is assembled — none of these show up in offline eval until a user reports a problem. By then, the degradation has been running for days or weeks.

The concrete version of this failure: teams have seen offline eval sets showing 90%+ success while production quality runs significantly lower, because real users interact with the system in unexpected ways ([Braintrust LLM Evaluation Guide](https://www.braintrust.dev/articles/llm-evaluation-guide)). Without production-level scoring, that gap is invisible. It surfaces as user complaints, not metrics.

## What I Would Not Do

The instinct is to run evaluations synchronously, inline with the request — gate every response through an eval before returning it. The appeal is obvious: you get guarantees, every response is checked.

Here's what breaks. Eval calls — especially LLM-as-judge — add 200–2,000ms to your p99 latency depending on the judge model. At any meaningful scale, that overhead is unacceptable. And it doesn't solve the real problem: you don't need to eval every request to detect quality drift. You need enough coverage to detect systematic issues, not per-request validation.

The other failure mode is treating online eval as a replacement for offline eval. Teams sometimes ship faster by reasoning "we'll catch it in production monitoring." That's backwards. Online eval is a safety net for things that slip through, not a substitute for pre-deployment testing. Running both, with clear roles for each, is the only setup that actually works.

The third trap: checking only aggregate scores. An average eval score across all requests hides distribution problems. A 0.8 average might mean 80% of requests score 1.0 and 20% score 0.0. Tracking score distributions, not just means, is what catches these cases.

## When You Need This

- Your offline eval dataset has been stable for more than a few weeks while production traffic keeps evolving
- CI passes consistently but users report quality regressions with no corresponding test failure
- Your production query distribution differs significantly from the scenarios your test set covers
- Catching quality regressions within hours, not days, matters for your SLA
- A model provider update, prompt change, or context pipeline change could affect quality and you want to know fast
- You've built an [Eval Harness](../../testing/eval-harness/) and want to extend it beyond CI

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **RAG → Required.** I wouldn't want to get paged on a RAG pipeline without online eval in place. Retrieval quality, answer faithfulness, and hallucination rates all drift as the index evolves — offline test sets go stale faster than the live data does.
- **Agents → Required.** Multi-turn agent quality is particularly hard to capture in static eval datasets. A tool call sequence that works in testing degrades in production as prompt phrasing, context length, and user intent interact in ways that synthetic scenarios don't anticipate. I'd want per-thread scoring before trusting any agent in production.
- **Batch → Required.** Batch jobs run large volumes without real-time feedback. A quality regression that would surface as user complaints in a chat system runs silently through thousands of records in a batch pipeline. I'd want sampling-based online eval with alerting before a batch job gets anywhere near production scale.
- **Streaming → Recommended.** Streaming output complicates eval — you're scoring partial responses, which limits what metrics you can run. Online eval is still worthwhile here, but the tooling is less mature and the integration is more involved. I'd notice the gap by month six, not month one.

## The Pattern

### Architecture

```
                         Production Request
                               │
                               ▼
                    ┌──────────────────────┐
                    │   Application Layer  │
                    │   (normal handler)   │
                    └──────────┬───────────┘
                               │ response
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                │
    ┌──────────────┐  ┌────────────────┐        │
    │   Return to  │  │  Sampling Gate │        │
    │    Caller    │  │  (1-10% rate)  │        │
    └──────────────┘  └───────┬────────┘        │
                              │ sampled trace   │
                              ▼                 │
                   ┌─────────────────────┐      │
                   │  Async Eval Queue   │      │
                   │  (non-blocking)     │      │
                   └──────────┬──────────┘      │
                              │                 │
                    ┌─────────▼──────┐          │
                    │  Eval Runner   │          │
                    │  ┌───────────┐ │          │
                    │  │ Scorers:  │ │          │
                    │  │ - LLM-as- │ │          │
                    │  │   judge   │ │          │
                    │  │ - Heuristic│ │          │
                    │  │ - Custom  │ │          │
                    │  └───────────┘ │          │
                    └──────────┬─────┘          │
                               │ score + trace  │
                               ▼                │
                    ┌──────────────────────┐    │
                    │  Score Store         │    │
                    │  (append-only log)   │    │
                    └──────────┬───────────┘    │
                               │                │
                    ┌──────────▼───────────┐    │
                    │  Alerting & Dashboard│◄───┘
                    │  (drift detection,   │
                    │   threshold alerts)  │
                    └──────────────────────┘
```

_Score thresholds (e.g., 0.7 warning / 0.5 critical) are illustrative — calibrate against your baseline before setting production alerts._

### Core Abstraction

```typescript
interface OnlineEvalMonitor {
  // Register a scorer to run on sampled production traces
  addScorer(scorer: Scorer): void;

  // Wrap a request handler — returns response immediately, samples eval async
  wrap<T>(handler: () => Promise<T>, context: EvalContext): Promise<T>;

  // Query recent scores for a scorer
  getScores(scorerName: string, window: TimeWindow): ScoreResult[];

  // Subscribe to score events for custom alerting
  onScore(callback: ScoreCallback): void;
}

interface Scorer {
  name: string;
  samplingRate: number; // 0.0 - 1.0
  score(trace: Trace): Promise<number>; // returns 0.0 - 1.0
}

interface EvalContext {
  input: string;
  output: string;
  metadata?: Record<string, unknown>;
}
```

### Configurability

| Parameter           | Default       | Notes                                                                 |
| ------------------- | ------------- | --------------------------------------------------------------------- |
| `samplingRate`      | `0.05` (5%)   | Per-scorer override. Lower for expensive LLM-as-judge scorers.        |
| `asyncTimeout`      | `30_000ms`    | Max time for an eval job before it's dropped. Prevents queue buildup. |
| `queueSize`         | `1000`        | Max pending eval jobs. Oldest are dropped when full.                  |
| `alertThreshold`    | `0.7`         | Score below this triggers a warning event.                            |
| `criticalThreshold` | `0.5`         | Score below this triggers a critical event.                           |
| `windowSize`        | `100 samples` | Rolling window for trend detection.                                   |

_These defaults are starting points. Sampling rate and alert thresholds shift significantly based on your SLA, traffic volume, and how expensive your scorers are. A 5% rate on 10K req/day gives ~500 scored samples/day — usually enough for drift detection. At 1K req/day, I'd push that to 20-30%._

### Key Design Tradeoffs

**Async over sync.** The main design decision is decoupling eval from the request path entirely. The response returns immediately; eval jobs are queued and processed by a background worker. Zero latency impact on the caller. The tradeoff: eval results lag by seconds to minutes depending on queue depth. For alerting purposes, that lag is fine. For per-request gating, it isn't — but per-request gating is the wrong use case for this pattern.

**Sampling over full coverage.** Evaluating every request is expensive, especially with LLM-as-judge scorers. Systematic drift is detectable at 1-10% sampling rates. The right sampling rate depends on traffic volume (low-volume systems need higher rates), scorer cost (heuristic scorers can run at higher rates than LLM-based ones), and how quickly you need to detect regressions.

**Score storage as append-only log.** Scores are immutable once written. This makes it possible to replay analysis over historical windows, compare current behavior against any past baseline, and audit which evaluations ran on which traces.

**Multiple scorer types.** Not every metric needs LLM-as-judge. Heuristic scorers (format checks, length validation, keyword presence) run at near-zero cost and can cover 100% of traffic. LLM-as-judge scorers handle nuanced quality metrics but belong at lower sampling rates. Running both layers means you get cheap broad coverage with expensive deep coverage where it matters.

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

| Failure Mode                                                                                                              | Detection Signal                                                                                                  | Mitigation                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Eval queue backlog** — async queue fills faster than workers drain it; oldest jobs dropped                              | Queue depth metric spikes; eval throughput (jobs/min) drops below sampling rate × request rate                    | Scale eval workers horizontally; reduce sampling rate temporarily; add queue depth alerting                                                                                     |
| **Scorer flakiness** — LLM-as-judge returns inconsistent scores for identical inputs, masking real drift                  | High score variance on synthetic calibration traces run on a schedule; bimodal score distributions                | Track scorer variance independently; use deterministic temperature settings; validate scorer output format; add a heuristic sanity check layer                                  |
| **Sampling bias** — sampled traces don't represent production distribution; drift in an unsampled segment goes undetected | Comparing sampled vs. unsampled distributions on heuristic metrics (latency, response length); manual spot-checks | Stratify sampling by request type, user segment, or metadata; monitor sampling rate per segment independently                                                                   |
| **Silent baseline drift** — eval scores gradually decline over months; no single drop triggers alerts                     | Threshold-based alerting misses slow, continuous degradation                                                      | Track 30-day rolling average alongside short-term windows; alert on slope (weekly delta), not just absolute threshold; run calibration traces monthly against a frozen baseline |
| **Eval infrastructure failure** — scorer service or queue goes down; evals stop running silently                          | Eval throughput drops to zero; no new scores recorded                                                             | Alert on zero-eval periods > N minutes; separate the eval infrastructure health check from the application health check                                                         |
| **Score inflation** — scorers learn to give high scores to output patterns that don't reflect actual quality              | Scores trend upward over time while user satisfaction metrics stay flat or decline                                | Validate scorers on adversarial test cases periodically; tie eval scores to downstream quality signals (user feedback, task success) when available                             |

## Observability & Operations

### Key Metrics

| Metric                         | Unit     | What It Signals                                                           |
| ------------------------------ | -------- | ------------------------------------------------------------------------- |
| `eval.queue.depth`             | count    | Backlog pressure; rising trend means eval infrastructure isn't keeping up |
| `eval.throughput`              | jobs/min | Whether sampling is running at the expected rate                          |
| `eval.score.p50`, `p10`, `p90` | 0.0–1.0  | Score distribution; watch for widening spread and downward shift          |
| `eval.score.rolling_mean_7d`   | 0.0–1.0  | Week-over-week trend; catches slow degradation threshold alerts miss      |
| `eval.scorer.error_rate`       | %        | Scorer failures; high error rate means scores are missing coverage        |
| `eval.lag_seconds`             | seconds  | Time between request and eval completion; indicates queue health          |

### Alerting

| Alert                          | Threshold                         | Severity | Check First                                                                                    |
| ------------------------------ | --------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| Score below warning threshold  | < 0.7 (rolling 100-sample window) | Warning  | Is this a specific scorer or all scorers? Check if a recent prompt or model change correlates. |
| Score below critical threshold | < 0.5 (rolling 100-sample window) | Critical | Pull recent failing traces from score store; check for pattern in inputs or context            |
| Eval queue depth rising        | > 500 jobs pending                | Warning  | Check eval worker health; consider reducing sampling rate temporarily                          |
| Zero evals in window           | No scores for > 15 min            | Critical | Check queue worker status; check scorer connectivity; verify sampling gate isn't misconfigured |
| Score variance spike           | Rolling stddev > 0.25             | Warning  | Scorer may be flaky; run calibration traces; check scorer model availability                   |
| 7-day rolling mean declining   | > 0.05 drop week-over-week        | Warning  | Slow degradation signal; compare recent traffic characteristics vs. baseline period            |

_These thresholds assume a 5% sampling rate on moderate traffic. High-volume systems may want tighter windows; low-volume systems may need larger windows to accumulate enough samples._

### Runbook

**Score drop alert fires:**

1. Check if the drop is scorer-specific or across all scorers — scorer-specific suggests a scorer issue, not a quality issue
2. Pull the 10 most recent low-scoring traces from the score store; look for patterns in the inputs
3. Check whether a prompt change, model update, or context pipeline change happened in the past 24 hours
4. If the drop correlates with a recent change, consider rolling it back or adding a targeted regression test
5. If no recent change correlates, check whether user traffic characteristics shifted (e.g., new entry point, viral distribution of certain query types)

**Eval queue backlog:**

1. Check eval worker process health — restarts, OOM, network issues
2. Check scorer latency — slow LLM-as-judge calls block queue throughput
3. Temporarily reduce sampling rate to drain the queue; scale workers if this recurs
4. Alert on queue depth before it hits capacity; don't wait for job drops

## Tuning & Evolution

### Tuning Levers

| Lever                            | Effect                                                                        | Safe Range                                             | Dangerous Extreme                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `samplingRate` per scorer        | Controls eval coverage vs. cost                                               | 1–20% for LLM-based scorers; up to 100% for heuristics | > 20% LLM-as-judge at high volume causes runaway eval costs                             |
| `windowSize` for trend detection | Wider windows reduce false alerts; narrower windows detect regressions faster | 50–500 samples                                         | < 20 samples means noisy alerts; > 1000 samples means slow detection                    |
| `asyncTimeout`                   | Longer timeouts handle slow scorers; shorter timeouts prevent queue buildup   | 10–60 seconds                                          | < 5s drops LLM-based evals routinely; > 120s causes queue memory pressure               |
| Alert thresholds                 | Lower thresholds catch more regressions; higher thresholds reduce noise       | Calibrated against 2 weeks of baseline scores          | Setting below baseline p10 causes constant alerts; setting above p50 misses real issues |
| Number of scorers                | More scorers means better coverage; each adds queue load                      | 2–5 scorers covering distinct quality dimensions       | > 10 scorers at moderate sampling overwhelms eval infrastructure                        |

### Drift Signals

| Timeline  | Signal                                              | Action                                                                                                                                                                  |
| --------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Month 1–2 | Alerts fire constantly                              | Sampling rate needs calibration — the threshold is set against insufficient baseline. Run 2 weeks without alerts before treating a threshold as production-ready.       |
| Month 3   | High score variance                                 | Scorers aren't stable. Usually means scorer configuration (temperature, prompt, model) needs tightening.                                                                |
| Month 6   | Scores drifted 0.01-0.02 points/month with no alert | The silent degradation question. Threshold-based alerting will have missed it entirely. The 7-day rolling mean vs. 30-day rolling mean comparison is what catches this. |

Review the scoring criteria quarterly. What "good" looks like for your application changes as the product evolves. Scorers that were well-calibrated at launch can quietly start rewarding different behavior as the output format or user expectations shift.

### Silent Degradation

The most insidious failure in systems relying solely on threshold-based alerting: scores drift down 1-2% per month over six months, never triggering an alert. At six months, the system's scoring 70% of its original quality, and the alerting setup has no signal.

Two proactive checks:

1. Run a frozen set of calibration traces — inputs with known expected outputs — on a weekly schedule. Compare against scores from month one. A 10% drop in calibration trace scores is a strong signal independent of sampling noise.
2. Track rolling mean slope, not just the absolute value. An alert on "7-day mean is 0.05 lower than 30-day mean" catches drift that threshold alerts miss.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers.

| Scale        | Additional Cost | ROI vs. No Pattern                                                       |
| ------------ | --------------- | ------------------------------------------------------------------------ |
| 1K req/day   | +$0.11/day      | Detects silent regressions; overhead is ~3.5% of base GPT-4o cost        |
| 10K req/day  | +$1.13/day      | Still marginal; one detected regression saves multiples in support/churn |
| 100K req/day | +$11.25/day     | Cut to 1-2% by using GPT-4o-mini as judge; overhead becomes ~$2-3/day    |

## Testing

See `src/ts/__tests__/index.test.ts` for the full test suite.

- **Unit tests:** Core `wrap()` method returns handler result immediately; sampling gate at 0% blocks all scoring; `getRollingMean()` computes correctly; `onScore` callback fires per scored trace; `getScores()` filters by time window
- **Failure mode tests:** Scorer errors absorbed without propagating (FM: scorer flakiness); queue drops oldest jobs when full (FM: queue backlog); scorer timeout enforced via `asyncTimeoutMs` (FM: scorer timeout); warning alert fires when rolling mean crosses `alertThreshold`; critical alert fires when rolling mean crosses `criticalThreshold`; drift detectable via rolling mean slope over 20 samples (FM: silent baseline drift)
- **Integration tests:** End-to-end wrap with mock LLM provider — response returned, score stored, rolling mean updated; multiple scorers run independently per trace; 20 concurrent requests all scored without blocking

**Run the tests:**

```bash
cd src/ts && npm install && npm test
```

## When This Advice Stops Applying

- Pre-launch systems with no production traffic — sampling requires live requests to sample from
- Very low volume systems (< 100 req/day) where manual review of all outputs is feasible and more reliable than statistical sampling
- Systems where offline eval datasets demonstrably match production distribution — if your test set covers 95%+ of production query types and that coverage is verified, online eval adds marginal signal
- Strict latency budgets where even async queue overhead (memory, network) is unacceptable — this is rare but real in edge/embedded deployments
- Applications where correctness is binary and fully automatable — if you can write deterministic pass/fail checks against every response, you don't need probabilistic sampling-based monitoring

<!-- ## Companion Content

- Blog post: [Online Eval Monitoring — Deep Dive](https://prompt-deploy.com/online-eval-monitoring) (coming soon)
- Related patterns:
  - [Eval Harness](../../testing/eval-harness/) (#4, S1) — the offline eval framework that online monitoring extends to production
  - [Structured Tracing](../structured-tracing/) (#8, S3) — provides the trace infrastructure for sampling production requests
  - [Output Quality Monitoring](../output-quality-monitoring/) (#16, S5) — monitors quality metrics; online eval adds eval-specific scoring
  - [Drift Detection](../drift-detection/) (#28, S8) — detects when online eval scores trend away from baseline
  - [Prompt Rollout Testing](../../testing/prompt-rollout-testing/) (#24, S7) — uses online eval to compare prompt variants -->

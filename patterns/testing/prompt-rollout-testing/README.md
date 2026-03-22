# Prompt Rollout Testing

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

Every prompt change is a leap of faith without a staged rollout strategy. Three words added to improve "conversational flow" can cause structured-output error rates to spike within hours — halting revenue-generating workflows until someone manually rolls back. A JSON extraction prompt that starts returning preamble text throws `json.loads()` failures at ~15% of requests. The change wasn't flagged for hours because nothing was watching the right metrics.

The deeper problem: prompts aren't treated as deployable artifacts. They bypass the SDLC — no diff, no review, no staged rollout. [OpenAI's April 2025 GPT-4o sycophancy update](https://leehanchung.github.io/blogs/2025/04/30/ai-ml-llm-ops/) reached all 180 million monthly active users simultaneously. Social media backlash became the alerting system because internal monitoring wasn't watching behavioral drift.

Offline evals make the problem worse in a subtle way. The dataset your evals run against is always stale, always smaller, and always less weird than production traffic. A prompt that scores 94% on your eval set can still wreck a specific request pattern that shows up only in prod. Offline confidence becomes false confidence — and the gap shows up as production incidents.

## What I Would Not Do

The naive approach is to evaluate prompts offline on a benchmark dataset and deploy once the score exceeds a threshold. This feels rigorous until you understand what it actually tests: a static snapshot of requests that don't represent production distribution drift.

Here's what breaks: the dataset grows stale. Teams add new product features, user behavior shifts, and the benchmark accumulates coverage gaps. A prompt that scores 96% on a dataset assembled six months ago might handle a new request category poorly — the category that's now 20% of your traffic. You won't know until you're looking at user complaints.

The second failure mode is harder to see. Incremental prompt edits accumulate without any change tracking. A single prompt accrues dozens of micro-adjustments over weeks. Each individual change looks safe in isolation. The compounding effect creates prompt drift — a gradual degradation that eventually tips into a sharp, visible failure. By then, no one remembers which change caused it, so the rollback becomes a guess.

Deploying directly to 100% of traffic with an immediate cutover is the worst possible response to this. There's no way to compare old vs. new on live requests, no statistical signal before all users are affected, and rollback only becomes an option after users experience the failure.

## When You Need This

- Prompt changes are frequent enough that manual review before each deploy isn't feasible
- Your offline eval results don't reliably predict production quality — you've had a prompt that passed evals but degraded in prod
- Multiple stakeholders (product, legal, safety) need measurable evidence that a change is an improvement before full rollout
- Output quality affects revenue or user-facing experience directly — a 12% degradation in click-through before it reaches 95% of users is the kind of thing you want to catch in canary
- System prompts control safety-relevant behavior where behavioral regression carries regulatory or legal risk

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **RAG → Required.** The retrieval prompt governs how context is synthesized into answers. A prompt regression here affects every downstream query — and because RAG outputs look superficially similar even when quality drops, I'd want live traffic comparison before committing to any non-trivial change.
- **Agents → Required.** Prompt changes in agent systems can alter tool selection, loop termination behavior, and output structure. I wouldn't want to get paged without traffic-split testing in place — a change that looks correct on 10 eval examples can interact badly with the real distribution of tool call sequences.
- **Streaming → Recommended.** Live traffic comparison is solid engineering practice here, but streaming's real-time constraints mean rollout infrastructure complexity may not be worth it for simple prompt wording tweaks. I'd use shadow mode rather than full A/B when latency headroom is tight.
- **Batch → High ROI.** Batch jobs run long and are expensive to interrupt. A canary that catches a prompt regression before committing a 48-hour run is high-value. The stakes per run are high enough that staged rollout pays for itself after one prevented incident.

## The Pattern

### Architecture

The rollout tester intercepts each request and routes it to one of N prompt variants based on configurable traffic weights. After each variant responds, the result flows through a metric collector that records the outcome against the variant label. A statistical evaluator checks accumulated data periodically and emits a decision: hold, promote, or rollback.

Three rollout modes serve different risk profiles:

| Mode            | Traffic Split      | Min Samples (per variant)                      | User Impact                      | When to Use                                                                       |
| --------------- | ------------------ | ---------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------- |
| **A/B split**   | 50% each           | 200–500 (for 5% MDE at 80% power)              | Both variants reach users        | When you need fast statistical signal and can accept equal blast radius           |
| **Canary**      | 1–10% to candidate | 200–500 (same, but takes longer to accumulate) | 90–99% on stable current variant | Default choice — low blast radius, catches regressions before most users see them |
| **Shadow mode** | 100% dual-fire     | 200–500 (same)                                 | Zero — current variant returned  | Safety-critical prompts where no user can see unvalidated candidate output        |

```
              ┌──────────────────────────────────────┐
              │        PromptRolloutTester           │
              │                                      │
Request ─────►│ 1. VariantRouter                     │
              │    (weighted random assignment)      │
              │        │               │             │
              │  [A: current]    [B: candidate]      │
              │        │         │ shadow: fire &    │
              │        │         │ log only; no resp │
              │        ▼         ▼                   │
              │ 2. LLM Provider calls                │
              │        │         │                   │
              │        └────┬────┘                   │
              │             ▼                        │
              │ 3. MetricCollector                   │
              │    latency · cost · quality score    │
              │             │  (every N requests)    │
              │             ▼                        │
              │ 4. StatisticalEvaluator              │
              │    Welch t-test · p < 0.05           │
              │       │         │         │          │
              │     hold    promote    rollback       │
              │              │           │           │
              │           B→100%      B→0%           │
              │           weights    weights          │
              └─────────────────────────────────────┘
                             │
Response ◄───────────────────┘
  (A/B: routed variant · shadow: A only)

                             ▼
                      [Logs / Metrics]
```

> Numeric defaults (traffic weights, significance threshold) are illustrative starting points. The right values depend on your traffic volume, acceptable risk, and how large a quality difference you want to detect.

### Core Abstraction

```typescript
interface PromptVariant {
  id: string;
  label: string; // e.g. "current", "candidate-v2"
  prompt: string;
  weight: number; // 0.0–1.0, weights must sum to 1.0
}

interface RolloutConfig {
  variants: PromptVariant[];
  mode: "ab" | "canary" | "shadow";
  minSampleSize: number; // per variant before statistical eval
  significanceLevel: number; // alpha, typically 0.05
  qualityMetric: (response: string, input: string) => Promise<number>; // 0–1
  autoRollback: boolean;
  rollbackThreshold: number; // quality drop that triggers rollback
}

interface RolloutDecision {
  action: "hold" | "promote" | "rollback";
  confidence: number; // p-value or 1 - p-value
  variantStats: Map<string, VariantStats>;
  reasoning: string;
}
```

### Configurability

| Parameter            | Default | Effect                                              | Safe Range | Dangerous Extreme                                               |
| -------------------- | ------- | --------------------------------------------------- | ---------- | --------------------------------------------------------------- |
| `canaryWeight`       | `0.05`  | Fraction of traffic to candidate                    | 0.01–0.20  | >0.50: canary becomes A/B, blast radius too large               |
| `minSampleSize`      | `200`   | Requests per variant before eval runs               | 100–1000   | <50: false significance; >2000: slow to detect regressions      |
| `significanceLevel`  | `0.05`  | p-value threshold for decisions                     | 0.01–0.10  | >0.10: too many false positives; <0.01: misses real regressions |
| `rollbackThreshold`  | `0.10`  | Quality drop (absolute) that auto-triggers rollback | 0.05–0.20  | <0.02: noisy triggers; >0.30: lets bad prompts through          |
| `shadowMode`         | `false` | Run candidate silently, no user impact              | —          | Shadow indefinitely = never ship improvements                   |
| `evaluationInterval` | `50`    | Requests between statistical checks                 | 25–100     | <10: CPU overhead; >500: slow to catch regressions              |

> These defaults are starting points calibrated for moderate-traffic systems. High-volume APIs (>10K req/day) can use smaller minimum samples. Safety-critical systems warrant lower significance levels and rollback thresholds. Your SLA determines how fast you need to detect a regression.

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Key design decisions:

| Decision                                         | Why                                                                                                                                                                  |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Weighted random assignment at request time**   | Deterministic per-request, not per-user, keeps the implementation stateless. Per-user stickiness would need a session ID hash, which is straightforward to layer on. |
| **Welch's t-test for quality comparison**        | Handles unequal sample sizes and variances between variants, which is realistic when canary weights are asymmetric.                                                  |
| **Shadow mode returns current variant response** | User experience is never affected; candidate output is logged for comparison only.                                                                                   |
| **Metric collector is pluggable**                | The `qualityMetric` function is injected, so you can use automated LLM-as-judge scoring, downstream outcome signals, or both.                                        |

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

### Key design decisions:

- Uses `random.choices()` with weights for variant selection — idiomatic Python, avoids reinventing weighted sampling.
- `scipy.stats.ttest_ind` with `equal_var=False` for Welch's t-test — standard library, no extra dependencies.
- Async-first design matches typical FastAPI / asyncio production environments.

## Failure Modes

| Failure Mode                                                                                                                                                                                                                                                               | Detection Signal                                                                                                                   | Mitigation                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Novelty bias in early samples** — first 50–100 requests to a new variant show inflated quality scores because they hit cache-warmed, easy queries. Statistical test declares significance too early.                                                                     | Variant A and variant B quality scores diverge sharply in the first 50 requests, then converge at 200.                             | Enforce `minSampleSize` strictly; ignore statistical results until both variants have hit the floor. Add a warm-up period that discards early samples.                                 |
| **Traffic imbalance invalidates comparison** — canary receives 5% of traffic but all premium-tier users happen to route to the current variant. The comparison isn't apples-to-apples.                                                                                     | Variant metrics show different baseline latency or cost that reflects user tier, not prompt quality.                               | Log user cohort metadata alongside variant assignment. Run a pre-experiment balance check on key covariates (user tier, query type) before interpreting results.                       |
| **Quality metric gaming** — the automated quality scorer is correlated with prompt style rather than semantic correctness. A verbose, formal prompt always scores higher, masking actual user experience degradation.                                                      | Rollouts consistently prefer the more verbose variant regardless of actual downstream outcomes.                                    | Cross-validate the quality metric against a held-out human-labeled set monthly. Use multiple metrics (task completion rate + output length + latency) rather than a single score.      |
| **Rollback storms** — auto-rollback fires on a noisy quality metric during a temporary infrastructure hiccup. The rollback itself causes a deployment event, which resets sample counts and delays real evaluation.                                                        | Rollback triggered during a known infrastructure incident window; quality metric recovers without prompt change.                   | Add a minimum observation window (e.g., 30 minutes wall-clock time) before rollback fires, not just sample count. Gate auto-rollback on a secondary confirmatory signal.               |
| **Silent drift (the 6-month failure)** — a promoted prompt accumulates micro-edits after rollout. The rollout tester only guards the deployment event; post-deployment drift is invisible. Quality slowly degrades below the rollback threshold but above the noise floor. | p99 quality score for the current prompt drifts down 8% over 90 days. No alerts fire because the absolute threshold isn't crossed. | Run a "current vs. baseline" comparison monthly — baseline being the prompt at last formal rollout. Alert on cumulative drift, not just per-deploy regressions.                        |
| **Insufficient power for small effects** — the experiment ends with enough samples to call it significant for a 15% quality difference, but a real 3% regression was present and undetected. The candidate is promoted with a latent bug.                                  | Statistical test shows p > 0.05 with 200 samples per variant, experiment concluded as "no difference."                             | Run power analysis before starting rollout to determine sample size for the minimum detectable effect size you care about. For a 3% MDE at 80% power, expect ~600 samples per variant. |

## Observability & Operations

### Key Metrics

| Metric                             | Unit                        | Collection Method                                     | What It Signals                                                                     |
| ---------------------------------- | --------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `rollout.variant.quality_score`    | 0–1 float, per variant      | Emitted after each evaluation                         | Relative prompt quality; compare across variants                                    |
| `rollout.variant.request_count`    | Integer, per variant        | Incremented on each routed request                    | Whether traffic weights are being applied correctly                                 |
| `rollout.variant.latency_p50/p99`  | ms, per variant             | Histogram per variant                                 | Candidate prompt shouldn't add latency; regression here is a proxy for extra tokens |
| `rollout.variant.cost_per_request` | USD, per variant            | Token count × pricing at emit time                    | Cost regression from longer prompts                                                 |
| `rollout.decision`                 | Enum: hold/promote/rollback | Emitted when statistical evaluator runs               | Track frequency; too-frequent rollbacks suggest noisy metric                        |
| `rollout.experiment_age_requests`  | Integer                     | Total requests since experiment started               | Alert if experiment runs too long without decision                                  |
| `rollout.drift_vs_baseline`        | Float                       | Monthly batch job comparing current vs. last-promoted | Silent drift detection                                                              |

### Alerting

| Alert                            | Condition                                                              | Severity | First Check                                                                                                                                      |
| -------------------------------- | ---------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auto-rollback fired              | `rollout.decision == rollback`                                         | Critical | Inspect variant quality score time series — is the drop sustained or a spike? Check infrastructure health first (it may not be prompt-related)   |
| Experiment stalled               | `rollout.experiment_age_requests > 10× minSampleSize` with no decision | Warning  | Traffic volume may be too low for significance. Check if canary weight is misconfigured or traffic has dropped. Consider widening canary weight. |
| Quality metric suspiciously high | Candidate score >20% above current in first 100 requests               | Warning  | Likely novelty bias or traffic imbalance — don't promote yet. Inspect which request types are routing to the candidate.                          |
| Quality metric missing           | `rollout.variant.quality_score` absent for >5 minutes                  | Critical | Quality scorer is failing. Rollout decisions will be based on incomplete data. Pause auto-promote until resolved.                                |
| Baseline drift detected          | Monthly: current prompt scores >5% below last-promoted baseline        | Warning  | Prompt has drifted post-rollout. Initiate a review of all micro-edits since last formal deploy.                                                  |

> Thresholds assume moderate traffic and a quality metric with ~10% natural variance. High-variance metrics warrant wider bands; safety-critical systems warrant tighter ones.

### Runbook

**Auto-rollback fired in production:**

1. Check `rollout.variant.quality_score` time series — is the drop on the candidate or did both variants drop simultaneously? Simultaneous drops suggest infrastructure, not prompt.
2. If prompt-related: confirm the rollback completed (current variant at 100% weight, candidate at 0%).
3. Inspect the candidate prompt diff vs. current — identify the change that likely caused the regression.
4. Check for traffic imbalance during the experiment: were certain user cohorts overrepresented in one variant?
5. Widen the minimum observation window or the rollback threshold if this was a false positive (spike, not sustained).
6. Open a post-mortem documenting what the candidate changed and what the regression looked like.

**Experiment stalled (no statistical decision after expected volume):**

1. Verify canary weight is configured correctly — confirm via `rollout.variant.request_count` that both variants are receiving traffic.
2. Calculate the experiment's observed effect size so far. If the difference is tiny (< 2%), the experiment may be powered for a difference that doesn't exist — consider widening the acceptable MDE or stopping the experiment.
3. Check if the quality metric is working — flat scores for both variants suggest the scorer is returning a constant.

## Tuning & Evolution

### Tuning Levers

| Lever                    | Effect                                   | When to Adjust                                                                                                                                              |
| ------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canaryWeight`           | Controls blast radius of bad changes     | Reduce to 1–2% for safety-critical prompts; raise to 20–30% when you need faster signal on low-traffic routes                                               |
| `minSampleSize`          | Controls how long experiments run        | Raise when you're catching too many false positives; lower if traffic is thin and experiments never complete                                                |
| `significanceLevel`      | False positive / false negative tradeoff | Tighten to 0.01 for production-blocking decisions; loosen to 0.10 for low-stakes iterative improvements                                                     |
| `qualityMetric` function | What "quality" means                     | Swap in downstream outcome signals (task completion, user satisfaction) as they become available — LLM-as-judge is a good bootstrap, not a long-term metric |
| `evaluationInterval`     | How often statistical evaluator runs     | Smaller values catch regressions faster at slightly higher CPU cost; the default of 50 requests is suitable for most traffic levels                         |

### Drift Signals

- Rollout experiments that ran fine at launch start completing without decisions — traffic volume dropped, the experiment never reaches `minSampleSize`. Either lower the threshold or investigate traffic loss.
- Quality scores for the current (stable) prompt trend down month-over-month without any formal rollout event — prompt drift from undocumented edits. Every prompt edit after rollout should trigger a new formal experiment.
- Auto-rollback fires on 3+ consecutive candidates — the baseline prompt may itself be degrading. Run a "current vs. original" comparison to check if the reference is still valid.

**Review cadence:** Check the monthly baseline drift metric (current vs. last-promoted). After 90 days of production, review whether the quality metric still correlates with downstream outcomes — metric-outcome alignment drifts as user behavior shifts.

### Silent Degradation

Month 3: Prompt edits accumulate outside the rollout system. Quality scores for the "current" variant trend down 5% from launch. No alert fires because there's no rollback event to trigger.

Month 6: The current prompt has diverged 8–12% from its rolled-out version. The rollout tester treats the current degraded prompt as the baseline. Any new candidate is compared against a bad baseline — experiments that should promote are flagging false regressions.

The check: run a monthly comparison between today's current prompt and the version tagged at last formal rollout. A sustained 5%+ gap is a signal to re-anchor the baseline.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers.

In canary and A/B modes, the rollout tester adds no LLM API calls beyond what the application was already making — it just routes existing traffic. Shadow mode is the exception: it dual-fires every request, effectively doubling API cost for the duration of the experiment. Cost impact comes from three sources: the candidate prompt's token count (longer prompts cost more per request), the fraction of traffic routed to the candidate during the experiment, and — in shadow mode — the duplicate API call for every request.

| Scale        | Additional Cost (canary, GPT-4o) | Additional Cost (shadow) | ROI vs. No Pattern                                               |
| ------------ | -------------------------------- | ------------------------ | ---------------------------------------------------------------- |
| 1K req/day   | +$0.006/day                      | +$3.25/day               | Canary: immediate. Shadow: justified for safety-critical prompts |
| 10K req/day  | +$0.06/day                       | +$32.50/day              | Canary: one 15-min regression outweighs months of overhead       |
| 100K req/day | +$0.63/day                       | +$325.00/day             | Canary: high ROI. Shadow: limit to 3–7 days to control spend     |

> Additional cost is negligible when candidate and current prompts are similar in length. Cost rises when A/B testing between substantially different prompt architectures.

## Testing

How to verify this pattern works correctly. See test files in `src/ts/__tests__/` and `src/py/tests/`.

- **Unit tests:** Variant router correctly applies traffic weights (statistical test over 1000 assignments); statistical evaluator correctly identifies significant differences; metric collector aggregates correctly; rollback threshold logic.
- **Failure mode tests:** Novelty bias (early samples skew high, decision deferred until `minSampleSize`); traffic imbalance detection; rollback storm prevention (secondary confirmation gate); insufficient power detection (test declares no-decision before MDE threshold).
- **Integration tests:** Full end-to-end rollout with mock provider — experiment starts, accumulates samples, statistical evaluator runs, decision fires. Shadow mode returns only current variant response while logging both.

Run with: `cd src/ts && npm test`

## When This Advice Stops Applying

- Early-stage products where iteration speed matters more than measurement rigor — if you're shipping 5 prompt changes a day and the stakes are low, a full rollout framework adds overhead without proportional benefit.
- Systems with very low traffic where statistical significance is unreachable. With fewer than ~50 requests per day, you'd need weeks of data per experiment to reach 200 samples per variant. Offline eval with manual review may be the right call.
- Prompts that are effectively constants — unchanged for quarters, no upcoming changes planned, no evidence of drift. The infrastructure cost isn't justified.
- Internal tools where prompt quality affects developer experience rather than user-facing outcomes, and full deploys are acceptable.

<!-- ## Companion Content

- Blog post: [Prompt Rollout Testing — Deep Dive](https://prompt-deploy.com/prompt-rollout-testing) (coming soon)
- Related patterns:
  - [Eval Harness](../eval-harness/) (#4, S1) — provides the evaluation metrics used to compare prompt variants
  - [Prompt Version Registry](../../observability/prompt-version-registry/) (#10, S3) — stores the prompt versions being tested
  - [Regression Testing](../regression-testing/) (#11, S4) — offline regression testing complements live rollout testing
  - [Online Eval Monitoring](../../observability/online-eval-monitoring/) (#21, S6) — monitors quality during rollout
  - [Snapshot Testing](../snapshot-testing/) (#33, S9) — snapshot comparisons between prompt variants -->

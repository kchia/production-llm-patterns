# Eval Harness

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

Without an eval harness, prompt changes ship on vibes. "It looked good on five examples" isn't a quality bar — it's hoping.

Here's what actually happens. A developer tweaks a system prompt to improve summarization. It works great on the three examples they tested. What they didn't check: the same change broke entity extraction for a different query type, and hallucination rates on long-form inputs went from 3% to 18%. Nobody noticed for two weeks, until a customer escalated.

This isn't hypothetical. [Stanford and UC Berkeley researchers](https://arxiv.org/abs/2307.09009) tracked GPT-4's behavior across model updates and found that, on their specific benchmark, code generation accuracy dropped from 52% to 10% between March and June 2023 — on the same inputs, with no prompt changes. GPT-3.5 dropped from 22% to 2% over the same period. The provider changed the model underneath, and without systematic evaluation, teams had no signal that their prompts were degrading.

The core issue: LLM outputs are non-deterministic. The same prompt can pass a manual spot-check and fail on the next run. Multiplied across use cases, query types, and model versions, manual review doesn't scale. A prompt change that improves one scenario silently degrades three others, and the feedback loop — users complain, support tickets pile up, someone eventually investigates — takes days or weeks.

[Hamel Husain](https://hamel.dev/blog/posts/evals/), who's helped over 30 companies set up evaluation systems, puts it directly: unsuccessful AI products almost always share a common root cause — a failure to create robust evaluation systems. The eval harness is the foundation that makes systematic quality measurement possible.

## What I Would Not Do

It's tempting to eyeball a handful of outputs after each prompt change. Open the playground, paste five inputs, check if the results look reasonable, ship it. This works until it doesn't — and it stops working fast.

At 3-5 query types, manual review already misses interactions between them. A prompt tweak that improves tone for customer support queries might make technical explanations worse. With five test cases, there's roughly a coin flip that the evaluator even tests the affected scenario. At 10+ query types, manual review covers maybe 20% of the surface area on a good day.

The next step teams usually take: writing a few assertion tests. Check that the output contains certain keywords, doesn't exceed a length, includes a required disclaimer. These work for structural constraints but miss the semantic problems — whether the response is actually correct, helpful, or consistent with previous behavior. A response can pass every assertion and still be wrong. It's like testing a calculator by verifying the output is a number, not that it's the right number.

Both approaches share the same fundamental flaw: no systematic comparison between versions. Without baseline scores across a representative dataset, there's no way to quantify whether a change made things better or worse. The developer's intuition that "this seems improved" is unfalsifiable. By the time degradation surfaces through user complaints, it's been in production for days or weeks, and isolating which change caused it means reviewing every commit in the window.

## When You Need This

- Prompt changes happen more than once — every change is a potential regression, and the risk compounds with frequency
- There are multiple query types or use cases — a change that helps one category can silently degrade another
- Model version upgrades are planned or forced (provider updates) — GPT-4's accuracy on specific benchmarks dropped 30+ percentage points across a single model update ([Chen et al., 2023](https://arxiv.org/abs/2307.09009))
- The system feeds downstream processes (RAG pipelines, agent loops, batch jobs) where a degraded output cascades into larger failures
- More than one person edits prompts — without shared eval, each developer has a different definition of "looks good"
- There's any compliance or quality SLA — "we manually checked a few examples" won't survive an audit

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **RAG → Required.** Retrieved context is only useful if the generation step handles it correctly. A prompt regression that increases hallucination rate or ignores retrieved passages undermines the entire pipeline. I wouldn't want to get paged over a quality issue that a 50-example eval suite would've caught before deploy.
- **Agents → Required.** Agent loops make LLM calls at every step — planning, tool selection, response synthesis. A subtle quality drop in any one step compounds across the loop. Without eval, a prompt change that makes tool selection 10% less accurate turns into 30-40% task failure rates in multi-step workflows.
- **Batch → Required.** Batch jobs process thousands of items with the same prompt. A regression isn't one bad response — it's a thousand bad responses before anyone checks. The eval harness is the only gate between a prompt change and a large-scale quality failure. I'd want eval in CI before any batch prompt change merges.
- **Streaming → Recommended.** Streaming systems typically have fewer prompt variations and the feedback loop is tighter — users see outputs in real time and report issues faster. Eval still catches regressions before they reach users, but the urgency is lower because the detection gap is shorter. I'd notice the gap in the first month, but it's not day-one critical.

## When This Advice Stops Applying

- One-shot scripts that don't evolve — no iteration means no regression risk
- Systems where human review is the primary quality gate and automated eval is supplementary — but even then, eval helps scale the human reviewer's coverage
- Very early exploration where "good output" isn't defined yet — ground truth comes before eval. [Hamel Husain](https://hamel.dev/blog/posts/evals/) emphasizes starting with manual error analysis before building automated eval infrastructure — the right sequencing
- Creative applications where output quality is inherently subjective and can't be reduced to metrics — though even here, structural evals (length, format, safety) still apply
- Single-model, single-prompt systems with very low change frequency — the overhead of maintaining an eval dataset may exceed the risk of undetected regressions

## The Pattern

### Architecture

The core idea: separate the three concerns of evaluation — what to test (dataset), how to judge (scorers), and what changed (comparison). The harness orchestrates all three and produces a structured report.

```
                    ┌──────────────────┐
                    │   Eval Dataset   │
                    │  (cases + ground │
                    │   truth/labels)  │
                    └────────┬─────────┘
                             ▼
┌────────────┐    ┌──────────────────────┐    ┌──────────────┐
│   Prompt   │───→│     Eval Runner      │←───│   Scorer[]   │
│  (system + │    │                      │    │  (exact,     │
│   config)  │    │  For each case:      │    │   semantic,  │
│            │    │  1. Generate output   │    │   llm-judge, │
└────────────┘    │  2. Score output     │    │   custom)    │
                  │  3. Record result    │    └──────────────┘
                  └──────────┬─────────┘
                             ▼
                  ┌──────────────────────┐
                  │    Eval Result       │
                  │                      │
                  │  Per-case scores     │
                  │  Aggregate metrics   │
                  │  Score distribution  │
                  └──────────┬─────────┘
                             ▼
                  ┌──────────────────────┐
                  │    Comparison        │
                  │                      │
                  │  Baseline vs Current │
                  │  Regression flag     │
                  │  Per-category delta  │
                  └──────────────────────┘
```

Threshold values (regression sensitivity, pass/fail cutoffs) are illustrative — actual values depend on the use case and what "acceptable quality" means for the specific application.

**Core abstraction** — the `EvalHarness`:

```typescript
interface EvalCase {
  id: string;
  input: string;
  expected?: string; // ground truth, if available
  tags?: string[]; // category labels for sliced analysis
  metadata?: Record<string, unknown>;
}

interface Scorer {
  name: string;
  score: (
    input: string,
    output: string,
    expected?: string
  ) => Promise<ScorerResult>;
}

interface ScorerResult {
  score: number; // 0.0 – 1.0
  pass: boolean;
  reason?: string; // explanation for the score
}

interface EvalResult {
  caseId: string;
  input: string;
  output: string;
  expected?: string;
  scores: Record<string, ScorerResult>;
  latencyMs: number;
  tokenUsage: { input: number; output: number };
}
```

The runner accepts a dataset, a prompt/model configuration, and an array of scorers. For each case, it generates an output via the LLM provider, runs all scorers against the output, and collects structured results. A comparison step diffs results against a baseline to flag regressions.

**Configurability:**

| Parameter             | Default     | Purpose                                                                |
| --------------------- | ----------- | ---------------------------------------------------------------------- |
| `dataset`             | (required)  | Array of `EvalCase` objects with inputs, expected outputs, and tags    |
| `scorers`             | (required)  | Array of `Scorer` implementations to run against each output           |
| `provider`            | (required)  | LLM provider function — `(input: string) => Promise<string>`           |
| `concurrency`         | `5`         | Number of eval cases to process in parallel                            |
| `threshold`           | `0.7`       | Minimum aggregate score to consider a run passing                      |
| `regressionTolerance` | `0.05`      | Maximum acceptable score drop from baseline before flagging regression |
| `timeout`             | `30000`     | Per-case timeout in milliseconds                                       |
| `tags`                | `undefined` | If set, only run cases matching these tags                             |

Defaults are starting points. The right `threshold` depends on the task (extractive QA might target 0.9; creative generation might accept 0.5). `regressionTolerance` depends on dataset size — smaller datasets need wider tolerance to account for variance. `concurrency` should match rate limits on the provider.

**Key design tradeoffs:**

| Decision                                         | Alternative                             | Benefit                                                                                            | Cost                                                                                                                |
| ------------------------------------------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Scorer-based** over assertion-based            | Binary pass/fail assertions             | Continuous scores enable regression detection, distribution analysis, and threshold tuning         | Scorers are harder to write and slower to run, especially LLM-as-judge scorers                                      |
| **Tags for sliced analysis** over flat scoring   | Single aggregate score across all cases | Catches "improved overall but degraded on entity extraction" scenarios by computing per-tag scores | Requires upfront taxonomy work and makes the dataset more effort to maintain                                        |
| **Comparison-based** over absolute-threshold     | Fixed quality threshold only            | Catches relative regressions even when absolute quality is hard to define                          | Requires storing baselines and deciding when to update them (a drifted baseline makes regressions invisible)        |
| **Mock provider** for testing the harness itself | Test only against real LLMs             | Harness bugs don't get conflated with model issues; deterministic outputs for reliable tests       | Mock behavior diverges from real LLM behavior, so harness tests prove infrastructure correctness, not eval validity |

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

How this pattern itself can fail. Every solution creates new failure modes.

| Failure Mode                                                                                                                                                                                                                                                                                                                                                               | Detection Signal                                                                                                                                                                                                     | Mitigation                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stale eval dataset** — the dataset no longer represents real production traffic. New query types emerge, old ones shift in distribution, but the eval cases stay frozen. Quality looks stable on evals while production quality degrades.                                                                                                                                | Compare eval dataset tag distribution against production traffic logs monthly. If a tag represents <5% of eval cases but >20% of production traffic, the dataset is stale.                                           | Schedule quarterly dataset refresh: sample recent production inputs, re-label, and add cases for new query types. Track dataset freshness as a metric (days since last refresh).                                                          |
| **Overfitted scoring threshold** — the threshold was tuned to make the current prompt pass, not to reflect actual quality requirements. Future regressions get a free pass because the bar is artificially low.                                                                                                                                                            | Track threshold changes over time. If the threshold has been lowered more than twice without a documented reason, it's likely overfitted. Cross-reference with user-reported quality issues that evals didn't catch. | Anchor thresholds to external quality signals: user satisfaction scores, downstream task success rates, or human review agreement. Require justification for threshold changes.                                                           |
| **LLM-judge drift** — if using an LLM to score outputs, the judge model itself can change behavior across updates (the same problem the harness is supposed to catch). Scores shift without any change to the system under evaluation.                                                                                                                                     | Run a fixed set of "golden" cases with known scores through the judge periodically. If golden case scores drift >0.1, the judge has changed.                                                                         | Pin the judge model version. Maintain a golden set of 10-20 cases with human-assigned scores and alert on divergence.                                                                                                                     |
| **Non-determinism masking regressions** — LLM output variance means a real regression produces scores within the noise band, and the harness doesn't flag it. The regression exists but is statistically invisible.                                                                                                                                                        | Track score variance per case over multiple runs. If variance is high (stddev >0.15) and sample size is low (<30 cases per tag), regressions below the noise floor are undetectable.                                 | Increase dataset size for high-variance categories. Run evals multiple times per case (3-5 runs) and use median scores. Tighten `regressionTolerance` as dataset grows.                                                                   |
| **Silent baseline rot (silent degradation)** — the baseline is updated periodically to match "current" performance. Each update resets the comparison point. Over months, quality drifts down 2-3% per cycle, but each individual comparison shows an acceptable delta. After six months, aggregate quality has dropped 15% with no single eval run flagging a regression. | Maintain a "genesis baseline" from the first production eval run. Periodically compare current scores against genesis, not just the most recent baseline. Plot score trends over time.                               | Keep an immutable genesis baseline alongside the rolling baseline. Alert when the gap between genesis and current exceeds a configurable threshold (e.g., >10% aggregate drop). Review and explicitly approve any genesis baseline reset. |
| **Scorer disagreement** — multiple scorers produce conflicting signals on the same output. One says quality improved, another says it degraded. Without a clear aggregation policy, the harness either picks the wrong signal or paralizes the CI gate.                                                                                                                    | Track per-scorer correlation. If two scorers disagree on >30% of cases, they're measuring different things (expected) or one is miscalibrated (problem).                                                             | Define explicit aggregation: minimum-of-all (conservative), weighted average (requires calibration), or per-scorer thresholds. Document which scorer is authoritative for which quality dimension.                                        |

## Observability & Operations

**Key metrics:**

| Metric                                 | What It Measures                                     | Why It Matters                                                                        |
| -------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Aggregate score per scorer per run** | Mean scorer output across all cases                  | Primary health signal — track as time series                                          |
| **Per-tag score breakdown**            | Mean score per tag per scorer                        | Catches category-level regressions that aggregate scores hide                         |
| **Pass rate**                          | Fraction of cases where all scorers passed           | Complementary to aggregate — catches tail failures                                    |
| **Eval run duration**                  | Wall-clock time for a full eval run                  | Infrastructure health — sudden increases signal provider throttling or dataset growth |
| **Dataset freshness**                  | Days since last dataset update                       | Stale datasets are the #1 long-term risk                                              |
| **Genesis baseline gap**               | Delta between current aggregate and genesis baseline | Catches silent baseline rot across multiple cycles                                    |
| **Golden case judge scores**           | LLM-judge scores on cases with known-correct grades  | Drift here means the judge model changed, not the system under evaluation             |

**Alerting:**

| Level        | Condition                                      | Action                                                                         |
| ------------ | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| **Warning**  | Aggregate score drops >5% from previous run    | Check if it's noise or a real trend — inspect per-tag breakdown                |
| **Warning**  | Dataset freshness >60 days                     | Time to sample recent production traffic and refresh                           |
| **Warning**  | Golden case judge scores drift >0.1            | Judge model may have been updated — verify version                             |
| **Critical** | Aggregate score drops below `threshold`        | Block the deploy                                                               |
| **Critical** | Genesis baseline gap exceeds 10%               | Cumulative quality drift — review genesis comparison                           |
| **Critical** | Eval run fails entirely (>50% provider errors) | CI gate is not functioning — investigate provider status                       |
| **Low-side** | Pass rate is 100% for >30 days                 | Dataset may be too easy or scorers too lenient — review difficulty calibration |

These thresholds are starting points. The right values depend on dataset size (smaller datasets need wider tolerance), score variance, and how aggressive the CI gate needs to be.

**Runbook:**

| Alert                    | Check This First                                                                                  | Resolution                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Aggregate score drop** | Which tags regressed? Identify specific failed cases. Compare outputs side-by-side with baseline. | If regression is real, revert the prompt change. If it's noise, increase dataset size for that tag.                                                             |
| **Dataset freshness**    | Sample 20-50 recent production inputs. Check if existing tags cover them.                         | Add new cases for uncovered query types. Re-run eval to establish new baseline.                                                                                 |
| **Judge drift**          | Check if the judge model version changed.                                                         | Re-score golden cases with new version. Update expected scores if acceptable; otherwise pin previous version.                                                   |
| **Genesis gap**          | Pull trend chart of aggregate scores over time. Identify when drift started.                      | If intentional (threshold relaxation), reset genesis with documented justification. If unintentional, revert to last-known-good prompt version and investigate. |

## Tuning & Evolution

**Tuning levers:**

| Lever                     | Safe Range                                               | Dangerous Extreme                                                         | Guidance                                                                                                                                    |
| ------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **`threshold`**           | 0.3–0.95                                                 | <0.2 (passes everything) or >0.98 (blocks on noise)                       | Start permissive (0.5-0.6) and tighten as the dataset matures. Extractive tasks can go higher (0.85+); creative tasks stay lower (0.4-0.6). |
| **`regressionTolerance`** | 0.02–0.15                                                | >0.2 (hides real regressions) or <0.01 (flags noise constantly)           | Larger datasets can use tighter tolerance. Scale down as dataset grows.                                                                     |
| **`concurrency`**         | 1–20                                                     | >50 against rate-limited APIs                                             | Match to provider rate limits. Higher concurrency = faster eval runs, but risks 429s.                                                       |
| **Dataset size**          | 5-10 cases per tag (floor)                               | <3 cases per tag (statistically meaningless)                              | More cases = more statistical power, less noise masking. But also more cost per run.                                                        |
| **Scorer composition**    | Code scorers first, LLM judges for subjective dimensions | All LLM judges, no code scorers (expensive, slow, fragile to judge drift) | Start with code scorers, add LLM judges for dimensions that code can't capture (coherence, helpfulness).                                    |

**Drift signals:**

| Signal                                                             | Meaning                                           |
| ------------------------------------------------------------------ | ------------------------------------------------- |
| Score variance increasing over time without prompt changes         | Model behavior drift (provider-side)              |
| Tag distribution in dataset diverging from production traffic logs | Dataset going stale                               |
| Threshold lowered more than twice in a quarter                     | Potential overfitting                             |
| Genesis baseline gap growing steadily                              | Cumulative quality erosion                        |
| Eval run duration increasing without dataset growth                | Provider throttling or infrastructure degradation |

- **Silent degradation:**
  - **Month 3:** Dataset starts going stale. New query types from product evolution aren't represented. Eval scores look stable, but production quality on new use cases is unknown. The fix: compare dataset tag distribution against production traffic monthly.
  - **Month 6:** Baseline rot compounds. Three baseline updates, each accepting a small regression. Aggregate score is now 12% below genesis, but no single update triggered an alert. The fix: genesis baseline comparison with alerting on cumulative drift >10%.
  - **Month 12:** Scorer calibration has drifted. LLM judge model was silently updated twice. Human-eval agreement has dropped from 90% to 70%, meaning the automated gate is accepting outputs that humans would reject. The fix: quarterly human-eval alignment checks on a sample of cases.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers. Costs shown are for eval runs only — the harness adds zero cost to production requests.

| Scale        | Additional Cost (code scorers) | Additional Cost (1 LLM judge) | ROI vs. No Pattern                                      |
| ------------ | ------------------------------ | ----------------------------- | ------------------------------------------------------- |
| 1K req/day   | +$0.88/day ($26/mo)            | +$1.44/day ($43/mo)           | One caught regression pays for months of eval           |
| 10K req/day  | +$10.50/day ($315/mo)          | +$17.25/day ($518/mo)         | Prevents batch-scale quality failures (1K+ bad outputs) |
| 100K req/day | +$52.50/day ($1,575/mo)        | +$86.25/day ($2,588/mo)       | Use GPT-4o-mini judges to cut cost 17x ($155/mo)        |

## Testing

See test files in `src/ts/__tests__/index.test.ts`. Run with `cd src/ts && npm test`.

- **Unit tests (14 tests):** Core eval run logic, aggregate computation, per-tag scoring, tag filtering, all four built-in scorers (exact match, contains, length, custom), comparison regression/improvement detection, threshold checks
- **Failure mode tests (6 tests):** One test per failure mode from the table — stale dataset detection, overfitted threshold masking, LLM-judge drift via golden case divergence, non-determinism variance, silent baseline rot (genesis vs rolling), scorer disagreement
- **Integration tests (5 tests):** Full run→compare→regression-gate flow, concurrent processing, provider error handling (50% error rate), per-case timeout, multi-scorer mixed results

<!-- ## Companion Content

- Blog post: [Eval Harness — Deep Dive](https://prompt-deploy.com/eval-harness) (coming soon)
- Related patterns:
  - [Structured Output Validation](../../safety/structured-output-validation/) — validates output format; eval harness validates output quality. Complementary layers.
  - [Regression Testing](../regression-testing/) (#11, S4) — uses the eval harness to catch prompt regressions across versions
  - [Adversarial Inputs](../adversarial-inputs/) (#18, S5) — uses the eval harness to test edge cases and attack inputs
  - [Snapshot Testing](../snapshot-testing/) (#33, S9) — uses the eval harness for output stability checks over time
  - [Online Eval Monitoring](../../observability/online-eval-monitoring/) (#21, S6) — extends eval from CI into production traffic monitoring
  - [Prompt Rollout Testing](../prompt-rollout-testing/) (#24, S7) — uses eval to compare prompt variants on live traffic (A/B for prompts) -->

# Regression Testing

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

A developer tweaks a summarization prompt to improve conciseness. It works — summaries get shorter, cleaner. What they didn't test: the same change broke entity extraction for legal documents, dropping accuracy from 92% to 64%. Nobody noticed for eleven days, until a compliance review caught it.

This scenario is the natural consequence of how LLM prompts work. A single system prompt governs behavior across every query type the system handles. Change one instruction, and you've potentially changed behavior for all of them. [Stanford and UC Berkeley researchers](https://arxiv.org/abs/2307.09009) tracked GPT-4 across model updates and found code generation accuracy on one benchmark dropped from 52% to 10% between March and June 2023 — same inputs, no prompt changes. The model changed underneath, and nobody's tests caught it.

The core issue: prompt changes and model updates both create regression risk, and neither announces which behaviors changed. Without a systematic way to compare "before" and "after" across every query category, regression detection depends on user complaints — a feedback loop that takes days or weeks to close. At [Notion](https://www.braintrust.dev/articles/llm-evaluation-guide), as documented in Braintrust's evaluation guide, before they built systematic eval infrastructure, quality issues surfaced through support tickets. After investing in hundreds of test datasets across specific criteria, their debugging velocity jumped to 30 issues per day.

Prompt regression testing is the CI gate that makes prompt changes as testable as code changes. Without it, every prompt edit is a coin flip across the entire surface area of the system.

## What I Would Not Do

It's tempting to eyeball a few outputs in the playground after each prompt change and call it a day. Run five inputs, check if the results look reasonable, ship it. This breaks down the moment the system handles more than one query type. At 3-5 query types, there's roughly a coin flip that manual review even covers the affected scenario. At 10+, manual review touches maybe 20% of the surface area.

The second attempt: keyword assertions. Check that outputs contain certain strings, don't exceed a length, include required disclaimers. These catch structural regressions but miss semantic ones entirely. A response can pass every assertion — right format, right length, right keywords — and still be factually wrong. It's testing that the calculator returned a number, not that it returned the right number.

Both approaches share a deeper flaw: no baseline comparison. Without stored scores from the previous prompt version, there's no way to quantify whether a change made things better or worse. "This seems improved" is unfalsifiable. And once a regression reaches production, isolating which prompt change caused it means reviewing every edit since the last known-good state — a forensic exercise that gets harder with each passing day.

The third trap is more subtle: running evals but treating the test suite as static. Teams build a regression suite, catch a few regressions, and then stop updating it. Three months later, the system handles new query types that aren't in the test suite, and regressions in those categories pass silently. A test suite that doesn't evolve with the product provides false confidence — arguably worse than no tests at all.

## When You Need This

- The system handles more than one query type or use case — every prompt change creates cross-category regression risk
- Prompts change more than once a month — each change is a potential regression, and the risk compounds with frequency
- Model upgrades are planned or forced by provider deprecations — [OpenAI](https://developers.openai.com/api/docs/deprecations/) has been aggressively deprecating model versions (gpt-4.5-preview, o1-preview, o1-mini all deprecated in 2025), and [Azure](https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirements) deployments of retired models return error responses
- More than one person edits prompts — without shared eval baselines, each developer has a different definition of "looks good"
- The system feeds downstream processes (RAG pipelines, agent loops, batch jobs) where a degraded output cascades into larger failures
- There's any quality SLA or compliance requirement — "we manually checked a few examples" won't survive an audit

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **RAG → Required.** The generation step sits downstream of retrieval — a prompt regression that increases hallucination or ignores retrieved context undermines the entire pipeline. I wouldn't want to get paged because a prompt tweak made the system start ignoring the documents it retrieved.
- **Agents → Required.** Agent loops make LLM calls at every step — planning, tool selection, response synthesis. A subtle quality drop in one step compounds across the loop. A prompt change that makes tool selection 10% less accurate turns into 30-40% task failure rates in multi-step workflows. I'd want regression coverage across every step type.
- **Batch → Required.** Batch jobs process thousands of items with the same prompt. A regression isn't one bad response — it's thousands of bad responses before anyone checks. The regression test suite is the only gate between a prompt change and a large-scale quality failure.
- **Streaming → Recommended.** Streaming systems typically have fewer prompt variations and users see outputs in real time, so the feedback loop is tighter. Regression testing still catches problems before they reach users, but the urgency is lower because detection gaps are shorter. I'd notice the gap in the first month, not the first week.

## The Pattern

### Architecture

The regression testing pattern wraps an eval harness with three additional concerns: baseline management (store and retrieve previous scores), version-aware comparison (diff current run against baseline per category), and a CI gate (pass/fail decision based on regression thresholds).

```
┌──────────────┐  ┌────────────────────┐
│  Test Suite  │  │   Prompt Version   │
│  cases[]     │  │  (current change)  │
│  (tagged)    │  └─────────┬──────────┘
└──────┬───────┘            │
       └───────────┬────────┘
                   ▼
        ┌─────────────────────┐
        │  Regression Runner  │
        └─────────┬───────────┘
                  │
       ┌──────────┴──────────┐
       ▼                     ▼
┌──────────────┐     ┌──────────────┐
│ 1. Load      │     │ 2. Run Eval  │
│   Baseline   │     │    Harness   │
│              │     │              │
│ ┌──────────┐ │     │ provider()   │
│ │ Baseline │ │     │ scorers[]    │
│ │  Store   │ │     │ per-case     │
│ └──────────┘ │     │  scores      │
└──────┬───────┘     └──────┬───────┘
       └───────────┬────────┘
                   ▼
         ┌──────────────────┐
         │ 3. Compare       │
         │    per-tag Δ     │
         │                  │
         │  baseline vs     │
         │  current scores  │
         └────────┬─────────┘
                  │
           ┌──────┴──────┐
           ▼             ▼
     ┌──────────┐  ┌──────────┐
     │regression│  │   no     │
     │ detected │  │regression│
     └────┬─────┘  └────┬─────┘
          │              │
          ▼              ▼
   ┌────────────┐ ┌────────────┐
   │ 4. Gate:   │ │ 4. Gate:   │
   │   FAIL ✗   │ │   PASS ✓   │
   │ (block CI) │ │ save as    │
   └────────────┘ │ new baseline│
                  └──────┬─────┘
                         ▼
                  ┌────────────┐
                  │  Report    │
                  │ per-tag Δ  │
                  │ trend data │
                  └────────────┘
```

Values in configuration (thresholds, tolerances) are illustrative — actual values depend on the dataset size, score variance, and quality requirements for the specific application.

**Core abstraction** — the `RegressionRunner`:

```typescript
interface RegressionConfig {
  suite: TestSuite;
  provider: LLMProvider;
  scorers: Scorer[];
  baselineStore: BaselineStore;
  regressionThreshold: number; // max acceptable per-tag score drop
  minPassScore: number; // absolute minimum score to pass
  failOnRegression: boolean; // whether regressions block CI
  concurrency: number;
}

interface TestSuite {
  id: string;
  version: string;
  cases: TestCase[];
}

interface TestCase {
  id: string;
  input: string;
  expected?: string;
  tags: string[]; // category labels for sliced comparison
  metadata?: Record<string, unknown>;
}

interface BaselineStore {
  load(suiteId: string): Promise<BaselineResult | null>;
  save(suiteId: string, result: RunResult): Promise<void>;
  history(suiteId: string, limit: number): Promise<RunResult[]>;
}

interface RegressionReport {
  passed: boolean;
  overallScore: number;
  baselineScore: number | null;
  regressions: TagRegression[];
  improvements: TagImprovement[];
  perTagScores: Record<string, number>;
  summary: string;
}
```

The runner takes a test suite, runs each case through the eval harness (provider + scorers), loads the previous baseline, compares scores per tag, and produces a structured report with a pass/fail gate decision.

**Configurability:**

| Parameter             | Default    | Purpose                                               |
| --------------------- | ---------- | ----------------------------------------------------- |
| `suite`               | (required) | Test suite with tagged cases                          |
| `provider`            | (required) | LLM provider function                                 |
| `scorers`             | (required) | Scorer implementations for quality measurement        |
| `baselineStore`       | (required) | Storage for baseline results (file, DB, or in-memory) |
| `regressionThreshold` | `0.05`     | Maximum per-tag score drop before flagging regression |
| `minPassScore`        | `0.7`      | Absolute minimum aggregate score to pass              |
| `failOnRegression`    | `true`     | Whether detected regressions fail the CI gate         |
| `concurrency`         | `5`        | Parallel case processing limit                        |

Defaults are starting points. `regressionThreshold` depends on dataset size — smaller datasets need wider tolerance (0.10-0.15) to account for LLM non-determinism. `minPassScore` varies by task type: extractive QA might target 0.85+, creative tasks might accept 0.5. `concurrency` should match provider rate limits.

**Key design tradeoffs:**

| Decision                                   | Alternative                         | Benefit                                                                                                                 | Cost                                                                                    |
| ------------------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Per-tag comparison** over aggregate-only | Single aggregate score diff         | Catches category-specific regressions that aggregate scores mask — "overall improved but entity extraction dropped 20%" | Requires tagged test cases and produces more complex reports                            |
| **Baseline store** over inline thresholds  | Hardcoded quality thresholds only   | Catches relative regressions even when absolute quality is hard to define; adapts as the system evolves                 | Requires storage infrastructure and baseline management (when to update, when to reset) |
| **Builds on Eval Harness** over standalone | Full reimplementation of eval logic | Reuses proven scorer/runner infrastructure; regression testing adds version comparison, not evaluation                  | Creates a dependency — changes to the eval harness affect regression testing            |
| **File-based baseline** as default over DB | Database storage for baselines      | Zero infrastructure — works immediately in CI, baselines commit alongside code                                          | Doesn't scale to large teams with concurrent baseline updates; no query capability      |

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

How this pattern itself can fail. Every solution creates new failure modes.

| Failure Mode                                                                                                                                                                                                                                                                                                                                                  | Detection Signal                                                                                                                                                                                                                     | Mitigation                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stale test suite** — the test suite no longer represents real production traffic. New query types emerge, old ones shift in distribution, but the test cases stay frozen. Regressions in new categories pass undetected.                                                                                                                                    | Compare test suite tag distribution against production traffic logs monthly. If a tag represents <5% of test cases but >20% of production traffic, the suite is stale.                                                               | Schedule quarterly suite refresh: sample recent production inputs, tag them, add cases for new query types. Track suite freshness as a metric (days since last refresh). [Braintrust](https://www.braintrust.dev/articles/llm-evaluation-guide) recommends converting production traces to test cases with minimal friction. |
| **Threshold erosion** — the regression threshold gets widened after a few false positives. Each widening is small and justified, but cumulatively the gate becomes permissive enough to miss real regressions.                                                                                                                                                | Track threshold changes over time. If `regressionThreshold` has been widened more than twice without a documented justification, it's likely eroding. Cross-reference with user-reported quality issues that the suite didn't catch. | Require written justification for threshold changes. Anchor thresholds to external quality signals (user satisfaction, downstream task success). Set a floor below which the threshold can't drop.                                                                                                                           |
| **Baseline inflation** — the baseline is updated after every run, including runs where quality degraded slightly but within threshold. Over multiple cycles, the baseline drifts to accept lower and lower quality. After six months, aggregate quality has dropped 15% with no single run flagging a regression.                                             | Maintain a "genesis baseline" from the first stable eval run. Periodically compare current scores against genesis, not just the rolling baseline. Plot score trends over time.                                                       | Keep an immutable genesis baseline alongside the rolling one. Alert when the gap between genesis and current exceeds a configurable threshold (e.g., >10% aggregate drop). Require explicit approval for genesis baseline resets.                                                                                            |
| **Non-determinism noise** — LLM output variance causes scores to fluctuate between runs. Real regressions produce score drops within the noise band, making them statistically invisible. The regression exists but can't be distinguished from normal variance.                                                                                              | Track score variance per tag over multiple runs. If stddev >0.15 and there are <30 cases per tag, regressions below the noise floor are undetectable.                                                                                | Increase case count for high-variance categories. Run evals multiple times per case (3-5 runs) and use median scores. Use deterministic settings (temperature=0) where possible.                                                                                                                                             |
| **Tag taxonomy drift (silent degradation)** — the tag system used to categorize test cases slowly diverges from how the product actually categorizes queries. New features use different terminology, old tags are never updated. The suite still passes, but it's testing an outdated mental model of the system. Over months, coverage gaps widen silently. | Quarterly review: map current product features to test suite tags. Count features with zero test case coverage. Track the ratio of "untagged" or "miscellaneous" cases — if it grows, the taxonomy is losing precision.              | Tie tag taxonomy to the product's feature registry or route definitions. When a new feature ships, require at least 5-10 test cases tagged for it before the feature is considered complete. Treat the tag taxonomy as living documentation, not a one-time setup.                                                           |
| **Scorer-suite coupling** — scorers are tuned to perform well on the specific test suite rather than measuring general quality. The suite passes consistently, but real-world inputs that differ from the suite's distribution produce poor scores that the regression gate never sees.                                                                       | Run scorers on a held-out sample of production inputs periodically. If scorer pass rates differ by >15% between the test suite and production sample, the scorer is overfitted to the suite.                                         | Maintain a separate "canary" set of cases sampled from recent production traffic. Run it alongside the main suite but don't include it in the baseline — use it as a drift detector.                                                                                                                                         |

## Observability & Operations

**Key metrics:**

| Metric                                 | What It Measures                                            | Why It Matters                                                                          |
| -------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Aggregate score per scorer per run** | Mean scorer output across all cases                         | Primary health signal — track as a time series to spot trends                           |
| **Per-tag score breakdown**            | Mean score per tag per scorer                               | Catches category-specific regressions that aggregate scores mask                        |
| **Pass rate**                          | Fraction of cases where all scorers passed                  | Complementary to aggregate — catches tail failures even when the mean is stable         |
| **Genesis baseline gap**               | Delta between current aggregate and genesis baseline        | Catches silent baseline rot across multiple cycles                                      |
| **Suite freshness**                    | Days since last test case addition or refresh               | Stale suites are the #1 long-term risk — they provide false confidence                  |
| **Run duration**                       | Wall-clock time for a full regression run                   | Sudden increases signal provider throttling or suite growth                             |
| **Suite coverage ratio**               | Ratio of product features with test cases vs total features | Catches tag taxonomy drift — features without cases are invisible to regression testing |

**Alerting:**

| Level        | Condition                                        | Action                                                                       |
| ------------ | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| **Warning**  | Aggregate score drops >5% from previous baseline | Inspect per-tag breakdown — check if it's noise or a real trend              |
| **Warning**  | Suite freshness >60 days                         | Time to sample recent production traffic and add new cases                   |
| **Warning**  | Suite coverage ratio drops below 80%             | New features shipped without regression test cases                           |
| **Critical** | Aggregate score drops below `minPassScore`       | Block the deploy — investigate which cases failed                            |
| **Critical** | Genesis baseline gap exceeds 10%                 | Cumulative quality drift — review the full score trend since genesis         |
| **Critical** | Run fails entirely (>50% provider errors)        | CI gate is not functioning — check provider status and rate limits           |
| **Low-side** | Pass rate is 100% for >30 consecutive runs       | Suite may be too easy or scorers too lenient — review difficulty calibration |

These thresholds are starting points. The right values depend on suite size (smaller suites need wider tolerance), score variance, and how aggressive the CI gate should be.

**Runbook:**

| Alert                    | Check This First                                                                                  | Resolution                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Aggregate score drop** | Which tags regressed? Identify specific failed cases. Compare outputs side-by-side with baseline. | If regression is real, revert the prompt change. If it's noise, increase case count for that tag.                                               |
| **Suite freshness**      | Sample 20-50 recent production inputs. Check if existing tags cover them.                         | Add new cases for uncovered query types. Re-run to establish new baseline.                                                                      |
| **Genesis gap**          | Pull trend chart of aggregate scores over time. Identify when drift started.                      | If intentional (threshold relaxation), reset genesis with documented justification. If unintentional, revert to last-known-good prompt version. |
| **Coverage drop**        | Map product features to suite tags. Which features have zero cases?                               | Require test cases for new features before they're considered complete.                                                                         |
| **100% pass rate**       | Review recent production quality complaints. Are they in areas the suite covers?                  | Add harder cases, add new scorers for unchecked dimensions, or tighten pass thresholds.                                                         |

## Tuning & Evolution

**Tuning levers:**

| Lever                     | Safe Range                  | Dangerous Extreme                                                | Guidance                                                                                     |
| ------------------------- | --------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **`regressionThreshold`** | 0.02–0.15                   | >0.20 (hides real regressions) or <0.01 (flags noise constantly) | Larger suites can use tighter tolerance. Start at 0.05–0.10 and tighten as confidence grows. |
| **`minPassScore`**        | 0.3–0.95                    | <0.2 (passes everything) or >0.98 (blocks on noise)              | Extractive tasks can go higher (0.85+); creative tasks stay lower (0.4-0.6).                 |
| **`genesisGapThreshold`** | 0.05–0.15                   | >0.25 (allows massive cumulative drift)                          | Tighter is better — this is the guard against the most insidious failure mode.               |
| **Suite size**            | 5-10 cases per tag (floor)  | < 3 cases per tag (statistically meaningless)                    | More cases = more statistical power. But also more cost per run.                             |
| **Concurrency**           | 1–25                        | >50 against rate-limited APIs                                    | Match to provider rate limits. Higher = faster runs, but risks 429 errors.                   |
| **Run frequency**         | Per prompt change + nightly | Every commit (expensive) or monthly (too late)                   | Per-change is ideal. Nightly catches model-side drift between prompt changes.                |

**Drift signals:**

| Signal                                                      | Meaning                                           |
| ----------------------------------------------------------- | ------------------------------------------------- |
| Score variance increasing without prompt changes            | Model behavior drift (provider-side update)       |
| Tag distribution in suite diverging from production traffic | Suite going stale                                 |
| Threshold widened more than twice in a quarter              | Potential threshold erosion                       |
| Genesis gap growing steadily                                | Cumulative quality erosion                        |
| New tags appearing in production logs not present in suite  | Feature taxonomy drift                            |
| Run duration increasing without suite growth                | Provider throttling or infrastructure degradation |

**Silent degradation:**

| Timeline     | Symptom                                                                                                                                                                                                                 | Detection                                                         | Fix                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Month 3**  | Suite starts going stale. New query types from product evolution aren't represented. Regression scores look stable, but production quality on new use cases is unknown.                                                 | Compare suite tag distribution against production traffic monthly | Track suite coverage ratio as a metric. Add cases for uncovered query types.                                          |
| **Month 6**  | Baseline rot compounds. Three baseline updates, each accepting a small regression. Aggregate score is now 12% below genesis, but no single update triggered an alert.                                                   | Genesis baseline comparison                                       | Alert on cumulative drift >10% from genesis. Review trend chart since first run.                                      |
| **Month 12** | Tag taxonomy has drifted. The product now uses different terminology for features than the suite's tags. Three major features have zero test coverage. The suite still passes on every run, providing false confidence. | Quarterly tag taxonomy review: map product features to suite tags | Tie tag taxonomy to the product's feature registry. Treat the tag list as living documentation, not a one-time setup. |

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers. Costs are for regression suite runs only — the pattern adds zero cost to production requests.

| Scale        | Additional Cost (GPT-4o, code scorers) | ROI vs. No Pattern                                    |
| ------------ | -------------------------------------- | ----------------------------------------------------- |
| 1K req/day   | +$0.30/day ($9/mo)                     | One caught regression saves weeks of debugging        |
| 10K req/day  | +$0.90/day ($27/mo)                    | Prevents 10K+ bad responses per undetected regression |
| 100K req/day | +$1.80/day ($54/mo)                    | Use GPT-4o-mini to cut cost to $3.78/mo               |

## Testing

See test files in `src/ts/__tests__/index.test.ts`. Run with `cd src/ts && npm test`.

- **Unit tests (16 tests):** Core run logic, per-tag scoring, baseline establishment and comparison, genesis baseline immutability, history tracking, regression detection (per-tag and overall), improvement detection, threshold sensitivity, failOnRegression flag, multiple scorers, custom scorers, provider error handling
- **Failure mode tests (6 tests):** One test per failure mode — stale test suite detection (tag distribution mismatch), threshold erosion tracking, baseline inflation via genesis gap detection (silent degradation), non-determinism variance measurement, tag taxonomy drift detection, scorer-suite coupling via canary set divergence
- **Integration tests (5 tests):** Full baseline→regression→fix pipeline, versioned providers with createVersionedProviders, concurrent case processing, mixed scorer results (exact_match fails while contains passes), provider timeout handling

## When This Advice Stops Applying

- Brand-new systems with no established behavior to regress from — regression testing compares versions, and there's no version to compare against yet. Start with exploratory eval, build the regression suite once there's a baseline worth protecting.
- R&D experimentation where outputs are expected to change dramatically with each iteration — regression testing assumes stability as a goal. If every change is intended to produce different outputs, the suite generates noise, not signal.
- Single-use-case systems with simple prompts where the prompt rarely changes — the overhead of maintaining a regression suite may exceed the risk. A handful of manual checks might genuinely be sufficient.
- Systems where the eval dataset is fundamentally unrepresentative — a regression suite built from synthetic examples that don't match real traffic catches synthetic regressions. If production traffic can't be sampled into the test suite, the pattern's value drops significantly.
- Very high creativity applications (fiction generation, brainstorming) where "different from before" isn't a defect — though even here, structural regressions (format, length, safety) are still worth testing.

<!-- ## Companion Content

- Blog post: [Regression Testing — Deep Dive](https://prompt-deploy.com/regression-testing) (coming soon)
- Related patterns:
  - [Eval Harness](../eval-harness/) (#4, S1) — the foundation this pattern builds on; provides the evaluation framework that regression testing wraps
  - [Snapshot Testing](../snapshot-testing/) (#33, S9) — a complementary approach using output snapshots instead of scored metrics
  - [Prompt Rollout Testing](../prompt-rollout-testing/) (#24, S7) — tests regressions on live traffic, not just offline datasets
  - [Adversarial Inputs](../adversarial-inputs/) (#18, S5) — regression tests for edge cases and attack vectors
  - [Prompt Version Registry](../../observability/prompt-version-registry/) (#10, S3) — tracks which prompt version each regression test ran against
  - [Structured Output Validation](../../safety/structured-output-validation/) — validates output format; regression testing validates output quality across versions -->

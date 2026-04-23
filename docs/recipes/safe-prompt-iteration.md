# Recipe: Safe Prompt Iteration

> **Patterns combined:** [Eval Harness](../../patterns/testing/eval-harness/) + [Prompt Rollout Testing](../../patterns/testing/prompt-rollout-testing/) + [Online Eval Monitoring](../../patterns/observability/online-eval-monitoring/)

Every prompt change is a deployment. Treating it otherwise — eyeballing outputs in the playground, shipping to 100% of traffic, watching for user complaints — is how quality degrades silently over weeks. These three patterns wire together as a deployment pipeline: the eval harness gates changes before merge, rollout testing limits blast radius during staged deployment, and online eval monitoring catches what slips through in production.

---

## When This Combination Makes Sense

Any prompt-based system that evolves eventually needs this pipeline. The trigger signals:

- A prompt change that looked good on five examples broke something in production
- Offline evals passed but production quality drifted in a category not covered by the test suite
- Multiple people edit prompts without a shared definition of "correct"
- A model provider updated silently and nobody had a signal until users complained
- There's a quality SLA — any compliance requirement means "we checked a few examples" isn't defensible

The earlier this goes in, the cheaper it is. The alternative is forensic debugging after the fact — combing through weeks of commits to find which prompt change correlated with the quality drop.

---

## How the Three Patterns Compose

The patterns are phases in a deployment pipeline, not a request-time stack. Each phase has a different role:

| Phase | Pattern | When It Runs | What It Catches |
|---|---|---|---|
| Pre-merge | Eval Harness | CI — every prompt change | Regressions vs. baseline across all test categories |
| Staged deploy | Prompt Rollout Testing | Deployment — canary traffic | Production distribution gaps not in eval set |
| Production | Online Eval Monitoring | Always — continuous sampling | Drift over time, model updates, input distribution shifts |

### Architecture

```
Developer edits prompt
        │
        ▼
┌──────────────────────────┐
│     Eval Harness (CI)    │
│  run test suite          │
│  compare to baseline     │
│  score delta > threshold?│
└──────────┬───────────────┘
           │
     PASS  │  FAIL
           │    │
           │    └──→ Block merge, show regression report
           │
           ▼
      Merge + Deploy (canary: 5–10% traffic)
           │
           ▼
┌──────────────────────────┐
│  Prompt Rollout Tester   │
│  A/B route by variant    │
│  collect metrics         │
│  statistical test        │
└──────────┬───────────────┘
           │
    HOLD   │  PROMOTE/ROLLBACK
           │
     ──────┴──────
     │            │
     ▼            ▼
  Promote      Rollback
  to 100%    (previous prompt)
           │
           ▼
┌──────────────────────────┐
│ Online Eval Monitoring   │
│ sample 5–10% of traffic  │
│ score async (LLM judge)  │
│ alert on quality drift   │
└──────────────────────────┘
           │
           ▼
     Continuous signal
     (catches model updates,
      distribution drift,
      long-tail regressions)
```

---

## Wiring Code

### TypeScript

```typescript
import { EvalHarness } from '../patterns/testing/eval-harness/src/ts/index.js';
import { PromptRolloutTester } from '../patterns/testing/prompt-rollout-testing/src/ts/index.js';
import { OnlineEvalMonitor } from '../patterns/observability/online-eval-monitoring/src/ts/index.js';

// ── Phase 1: CI Gate ──────────────────────────────────────────────────

const harness = new EvalHarness({
  testCases: loadTestSuite('prompts/eval-cases.jsonl'),
  judge: async (input, output) => await llmJudge(input, output),
  regressionThreshold: 0.05,   // fail if any category drops > 5 percentage points
});

// Run in CI (e.g., GitHub Actions). Blocks merge if a regression is detected.
async function ciEvalGate(newPrompt: string, baselineVersion: string): Promise<void> {
  const result = await harness.compare({
    baseline: { version: baselineVersion },
    candidate: { prompt: newPrompt },
  });

  if (result.hasRegression) {
    const regressions = result.categories
      .filter((c) => c.delta < -0.05)
      .map((c) => `${c.name}: ${(c.delta * 100).toFixed(1)}%`)
      .join(', ');
    throw new Error(`Prompt regression detected: ${regressions}`);
  }

  // Save baseline if this candidate is being promoted.
  await harness.saveBaseline(newPrompt, result.scores);
}

// ── Phase 2: Staged Rollout ───────────────────────────────────────────

const rollout = new PromptRolloutTester({
  variants: [
    { id: 'control', prompt: loadPrompt('v1'), weight: 0.90 },
    { id: 'candidate', prompt: loadPrompt('v2'), weight: 0.10 },
  ],
  minSamplesPerVariant: 200,
  metricCollector: async (variant, input, output) => {
    const score = await quickEvalScore(input, output);
    return { variant, score, timestamp: Date.now() };
  },
  onDecision: async (decision) => {
    if (decision.action === 'promote') {
      await deployPrompt('v2', trafficWeight: 1.0);
    } else if (decision.action === 'rollback') {
      await deployPrompt('v1', trafficWeight: 1.0);
    }
  },
});

// Application handler — routes each request through the active rollout.
export async function handleWithRollout(request: LLMRequest) {
  return rollout.execute(request);
}

// ── Phase 3: Production Monitoring ────────────────────────────────────

const monitor = new OnlineEvalMonitor({
  sampleRate: 0.08,            // score 8% of traffic — enough signal, low overhead
  judgeModel: 'gpt-4o-mini',  // cheaper judge for production sampling
  alertThreshold: 0.10,       // alert if quality drops > 10 points
  onAlert: (alert) => {
    sendPagerDutyAlert({
      title: `Quality degradation: ${alert.metric}`,
      value: alert.currentScore,
      baseline: alert.baselineScore,
    });
  },
});

// Wrap the application handler to add production monitoring.
export async function handleWithMonitoring(request: LLMRequest) {
  const response = await callProvider(request);
  // Async — doesn't block the response path.
  monitor.sampleAndScore(request, response).catch(console.error);
  return response;
}
```

### Python

```python
from patterns.testing.eval_harness.src.py import EvalHarness, EvalHarnessConfig
from patterns.testing.prompt_rollout_testing.src.py import PromptRolloutTester, RolloutConfig
from patterns.observability.online_eval_monitoring.src.py import OnlineEvalMonitor, MonitorConfig

# ── Phase 1: CI Gate ──────────────────────────────────────────────────

harness = EvalHarness(
    config=EvalHarnessConfig(
        test_cases=load_test_suite("prompts/eval-cases.jsonl"),
        judge=llm_judge,
        regression_threshold=0.05,
    )
)

async def ci_eval_gate(new_prompt: str, baseline_version: str) -> None:
    result = await harness.compare(
        baseline={"version": baseline_version},
        candidate={"prompt": new_prompt},
    )
    if result.has_regression:
        regressions = [
            f"{c.name}: {c.delta * 100:.1f}%"
            for c in result.categories
            if c.delta < -0.05
        ]
        raise RuntimeError(f"Prompt regression detected: {', '.join(regressions)}")
    await harness.save_baseline(new_prompt, result.scores)

# ── Phase 2: Staged Rollout ───────────────────────────────────────────

rollout = PromptRolloutTester(
    config=RolloutConfig(
        variants=[
            {"id": "control", "prompt": load_prompt("v1"), "weight": 0.90},
            {"id": "candidate", "prompt": load_prompt("v2"), "weight": 0.10},
        ],
        min_samples_per_variant=200,
        metric_collector=lambda variant, inp, out: quick_eval_score(inp, out),
        on_decision=lambda d: deploy_prompt("v2" if d.action == "promote" else "v1"),
    )
)

async def handle_with_rollout(request: dict) -> dict:
    return await rollout.execute(request)

# ── Phase 3: Production Monitoring ────────────────────────────────────

monitor = OnlineEvalMonitor(
    config=MonitorConfig(
        sample_rate=0.08,
        judge_model="gpt-4o-mini",
        alert_threshold=0.10,
        on_alert=lambda a: send_alert(
            f"Quality degradation: {a.metric} "
            f"({a.current_score:.2f} vs baseline {a.baseline_score:.2f})"
        ),
    )
)

async def handle_with_monitoring(request: dict) -> dict:
    response = await call_provider(request)
    # Fire-and-forget — doesn't add latency to the response path.
    asyncio.create_task(monitor.sample_and_score(request, response))
    return response
```

---

## What to Watch

### Metrics to Track

| Metric | What It Signals | Alert If |
|---|---|---|
| `eval.regression_count` per deploy | CI gate effectiveness | Non-zero in prod (means CI was bypassed) |
| `eval.category_scores` delta | Per-category quality change | Any category drops > 5% vs. baseline |
| `rollout.variant_quality_delta` | Candidate vs. control | Candidate < control by > 3% (statistical) |
| `rollout.decision` | Promote/hold/rollback rate | Rollback rate > 20% of deployments |
| `online_eval.score` p50/p95 | Production quality trend | 7-day rolling average drops > 8% |
| `online_eval.score_distribution` | Score distribution shape | Bimodal signal (some category scoring 0.0) |

### Combined Failure Modes

**Eval set staleness.** The CI harness runs against a test suite assembled months ago. New product features, user behavior shifts, and query pattern changes mean the test suite covers less of production traffic over time. A prompt regression in a new category passes CI, reaches canary, and gets promoted because the rollout tester's metrics only track categories in the eval set. Set a quarterly reminder to expand the eval suite with queries from production sampling (pull from online eval monitoring logs).

**Canary promotion on insufficient sample size.** With 5% canary traffic at 1K req/day, the candidate variant sees only 50 requests/day. At 200 minimum samples, promotion takes 4 days. If the team promotes early ("it looks fine"), the statistical test hasn't run. Enforce the minimum sample count as a hard gate in the rollout tester, not a recommendation.

**Online eval monitor diverges from offline eval.** The judge model used in production monitoring (gpt-4o-mini for cost) may score differently than the judge used in the eval harness (gpt-4o for quality). A 10% quality drop detected by online eval might be model divergence, not real degradation — or vice versa. Run both judges on the same sample quarterly to calibrate.

**Silent prompt drift from accumulated micro-edits.** Each individual edit passes the CI gate because the delta is below threshold. After 20 small changes, the cumulative drift is significant but no single commit was a regression. Track absolute scores over time (not just deltas), and alert if the 90-day rolling baseline drifts more than 15% from the initial benchmark.

### Runbook: Production Quality Alert

1. Check `online_eval.score` by category — is this global or specific to one task type?
2. Check `rollout.decision` history — was a prompt change promoted in the last 48 hours?
3. Check provider status page — model updates can change behavior behind the same API.
4. If a specific prompt change correlates: roll back via `rollout.forceRollback()`, then re-run CI with expanded test cases that cover the affected category.
5. If no prompt change correlates: provider model update is likely. Run the eval harness against the current prompt with both model versions to quantify the impact.

---

## Tension Between Patterns

**CI gate threshold vs. canary sensitivity.** If the CI regression threshold is 5%, a change that degrades one category by 4.9% passes CI and enters canary. The canary detects it only if the affected category is well-represented in production traffic. Setting a tighter CI threshold (2–3%) catches more regressions but increases false positive CI failures on minor model variance. I'd tune CI to match the quality SLA, not to a round number.

**Sample rate and judge cost.** At 8% sampling with gpt-4o-mini as judge, monitoring 10K req/day means ~800 judge calls/day at ~$0.001 each — under $1/day. But if the system grows to 100K req/day, that's $10/day for monitoring alone. Consider dropping sample rate as volume grows (4% at 50K req/day is still 2,000 data points), or filtering to score only a statistically representative subset rather than proportional sampling.

**Rollout speed vs. blast radius.** A 5% canary at 1K req/day takes 4 days to reach minimum sample size. A 20% canary reaches it in 1 day. Faster rollout = more users exposed to a potential regression. The right split depends on the consequence of a regression: for safety-critical prompts, slower is almost always worth it.

---

## Related Recipes

- [RAG Quality Stack](./rag-quality-stack.md) — regression testing within RAG-specific pipelines
- [Agent Safety Stack](./agent-safety-stack.md) — prompt injection defense and loop guards are the safety complement to prompt quality controls

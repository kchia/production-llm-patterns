# Snapshot Testing

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

Prompt changes ship silently broken. The team edits a system prompt, reruns the test suite, sees green — and doesn't notice until a week later that one response category collapsed. There's no compiler error. No stack trace. Just a quiet shift in quality that bypasses every conventional check.

The underlying issue is that LLM outputs aren't reliably deterministic — even at temperature 0, infrastructure factors like [batching](https://152334h.github.io/blog/non-determinism-in-gpt-4/), quantization, and API version changes can introduce variation — so the testing primitives that work everywhere else don't apply here. Exact-match assertions fail on every innocent rephrase, training the team to ignore failing tests — which means when a real regression happens, it fails alongside the noise and nobody investigates. The opposite mistake is checking nothing: relying on manual spot-checks after prompt edits that sample maybe 5–10 examples from a space of thousands of possible inputs.

What makes this failure mode particularly expensive is category-specific collapse. Aggregate metrics lie: an overall quality score dropping 2% conceals a 15% regression in a specific question type. The summary looks fine. A customer cohort is getting degraded responses. You find out in a support ticket three weeks later.

The pattern that snapshot testing addresses is this: capture what "good" looks like at an output level — structure, semantic content, key information presence — and fail CI when a change deviates meaningfully. Not exact string matching, but structured deviation detection with semantic tolerance.

## What I Would Not Do

The first instinct is to write exact-match assertions — `expect(output).toBe(snapshot)`. It seems like the right analog to traditional snapshot testing. It's not. The problem surfaces immediately in practice: the model rephrases its answer on every run, even at temperature 0, even for the same prompt. The test suite generates constant noise. The team starts adding [`--updateSnapshot`](https://jestjs.io/docs/snapshot-testing) to every CI run to silence the failures, at which point the tests catch nothing.

The second instinct is to go the opposite direction: rely entirely on manual review before shipping prompt changes. I understand the appeal — it avoids the false alarm problem. But manual review doesn't scale. It samples a handful of cases from a large input distribution. The categories it misses are exactly the edge cases most likely to collapse when prompt semantics shift. The 15-point onboarding regression that went undetected for a week? The team had reviewed the change manually and approved it.

The third mistake is averaging. Running an overall semantic similarity score across a test corpus and setting a threshold on the mean hides the distribution. A change that improves 80% of cases while degrading 20% passes a mean threshold and ships with a hidden regression. The insight snapshot testing adds is per-case tracking: each snapshot either passes or fails individually, and you see which cases regressed rather than a number that obscures them.

What I wouldn't do: skip the baseline altogether. Snapshot testing only catches regressions if you've captured what good looks like before the change.

## When You Need This

- You're shipping prompt changes more than once a week and relying on manual review to catch regressions
- Your test suite generates constant false alarms from exact-string matching — >20% of failures on any run are non-regressions
- You've already been surprised by a silent quality drop after a prompt edit that looked benign
- You're changing the underlying model version and want to know what actually changed in output behavior
- Your RAG pipeline, agent, or batch workflow has structured output requirements where silent format drift is expensive to debug downstream
- You want a lightweight regression layer between "no tests" and "full eval harness with LLM-as-judge"

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **RAG → Recommended.** RAG responses change from three directions simultaneously — prompt edits, retrieved document changes, and model updates. Snapshot baselines make it possible to isolate which dimension caused a regression. I'd want output snapshots before making any of those changes, because without a baseline there's no way to tell what shifted.
- **Agents → Recommended.** Agents produce structured reasoning and tool-call sequences that shift with model updates in ways that don't trigger hard failures. A snapshot that captures expected tool selection patterns, response structure, and key reasoning elements catches these silent behavioral changes before they compound into workflow failures.
- **Batch → Recommended.** Batch jobs run a changed prompt against thousands of documents before anyone reviews the output. A snapshot regression in a batch workflow doesn't surface until downstream parsing breaks or the output file looks wrong. Running snapshot tests against a representative sample before executing a full batch run is the standard I'd set.
- **Streaming → Optional.** Streaming pipelines primarily concern themselves with delivery mechanics and real-time responsiveness. Output content in streaming contexts is usually reviewed immediately by users, so silent semantic drift surfaces faster. Snapshot testing is possible but adds less value here than in the other system types.

## The Pattern

### Architecture

```
Prompt Change / Model Update / Retrieval Change
              │
              ▼
┌──────────────────────────────────────┐
│  SnapshotRunner.run(testCase)         │
│  1. Execute prompt with inputs       │
│  2. Extract output characteristics   │
└──────────────┬───────────────────────┘
               │
    ┌──────────┴──────────────────┐
    │                             │
    ▼                             ▼
┌──────────────┐   ┌────────────────────────┐
│ Snapshot     │   │ Live Output            │
│ Store        │   │ Characteristics        │
│ (baseline)   │   │ - structural props     │
└──────┬───────┘   │ - key phrases          │
       │           │ - semantic embedding   │
       └─────┬─────┴────────────────────────┘
             ▼
   ┌──────────────────┐          ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
   │  SnapshotMatcher  │          ╎ side-channel  ╎
   │  compare(live,    │ ──score──► Metrics/Logs  ╎
   │   baseline, tol)  │          ╎ (per-case     ╎
   └────────┬──────────┘          ╎  similarity)  ╎
            │                     ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
   ┌────────┴──────────────┐
   │                       │
within tolerance       outside tolerance
   │                       │
   ▼                       ▼
┌──────────┐   ┌─────────────────────────┐
│  PASS    │   │  FAIL                   │
└──────────┘   │  { testCase, delta,     │
               │    similarity, live }   │
               └─────────────────────────┘
```

*Tolerance thresholds (e.g., similarity ≥ 0.85) are illustrative — appropriate values depend on output type, desired sensitivity, and your team's false-positive tolerance.*

### Core Abstraction

```typescript
interface SnapshotTestCase {
  id: string;                     // Unique, stable identifier — storage key
  promptTemplate: string;         // Prompt with {{variable}} placeholders
  inputs: Record<string, unknown>; // Values interpolated into the template
  expectedCharacteristics?: Partial<SnapshotCharacteristics>; // Run-only override
}

interface SnapshotCharacteristics {
  embeddingVector: number[];      // Cosine-similarity-ready embedding
  charCount: number;              // Output length for range checks
  structuralFingerprint: { topLevelKeys: string[]; keyTypes: Record<string, string> } | null;
  keyPhrases: string[];           // High-frequency content words (capped at 20)
  capturedAt: string;             // ISO timestamp of capture
}

interface SnapshotResult {
  testCaseId: string;
  passed: boolean;
  similarity: number;             // 0–1 cosine similarity to baseline
  delta: SnapshotDelta;           // Structured diff: what changed and how
  baseline: SnapshotCharacteristics;
  live: SnapshotCharacteristics;
}
```

### Configurability

| Parameter | Default | Description |
|-----------|---------|-------------|
| `similarityThreshold` | `0.85` | Minimum semantic similarity to pass. Lower = more tolerant. |
| `structuralMatchRequired` | `true` | Whether structural property mismatches fail the test. |
| `keyPhrasesRequired` | `false` | Whether missing key phrases fail the test. |
| `updateMode` | `false` | When `true`, overwrite stored snapshots with current outputs. |
| `snapshotDir` | `".snapshots"` | Directory where baseline snapshots are persisted. |

*These defaults suit early adoption — tight enough to catch structural regressions, tolerant enough to survive normal rephrasing variance. Teams with high-stakes output requirements (structured extraction, compliance copy) should raise `similarityThreshold` toward 0.92+.*

### Key design decisions

**Why semantic similarity instead of exact matching.** Exact matching generates false alarms on every stylistic variation, which trains the team to ignore failures. Semantic similarity using embedding cosine distance captures meaning-level changes (a regression) while tolerating surface-level variation (a non-event).

**Why store characteristics, not raw output.** Storing the raw LLM output and re-embedding it on every run adds latency and cost that scales with corpus size, and introduces instability if the embedding model is updated between runs. Storing derived characteristics (embedding vectors, structural fingerprints, key phrase sets) makes comparisons cheap and reproducible.

**Why per-case tracking instead of aggregate scores.** Aggregate similarity scores hide which cases regressed. Per-case pass/fail makes regressions actionable: the diff shows exactly which test cases changed and how.

**Why a dedicated update mode.** Snapshot updates should be an explicit, reviewed action — not a consequence of running with a flag. The update mode workflow mirrors git: run, review the diff, approve by committing the updated snapshots.

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

| Failure Mode | Detection Signal | Mitigation |
| ------------ | ---------------- | ---------- |
| **Stale snapshot acceptance** — baselines are never reviewed and accumulate drift over time; the snapshot "passes" but no longer reflects the actual quality bar | Snapshot update frequency > once per week per case; no snapshot diff review in PR history | Enforce snapshot diffs in code review; treat snapshot updates as meaningful changes, not cosmetic ones |
| **Threshold miscalibration** — similarity threshold set too low fails to catch real regressions; set too high generates constant noise until disabled | False-negative rate: real regressions shipping without failure; or false-positive rate: >20% failures on unchanged prompts | Calibrate threshold against historical output variation on a fixed prompt; separate thresholds for high-stakes vs. exploratory outputs |
| **Coverage gap — undertested categories** — snapshot corpus covers common cases but misses the tail that actually regresses; high-volume query types are tested, niche categories are not | A regression surfaces in production that wasn't represented in the snapshot set | Sample snapshot corpus from production traffic logs, not just manually curated examples; weight by failure-prone categories |
| **Silent embedding model drift** *(silent degradation)* — the embedding model used for comparison is updated, shifting similarity scores without any output change; snapshots that previously passed now fail or pass at different thresholds with no underlying regression | Unexplained step-change in pass/fail rates after a dependency update; similarity scores shift uniformly across all cases | Pin embedding model version; run a baseline validation when updating the embedding model to distinguish model-induced score shifts from actual output changes |
| **Update-mode accidents** — someone runs `--updateSnapshot` without reviewing the diff, silently overwriting a baseline that was catching a regression | Snapshots committed without a corresponding PR review comment on the diff | Gate snapshot updates behind a separate CI job that requires explicit approval; never auto-update in a standard test run |
| **Missing first-run baseline** — a new test case is added but no baseline is captured; the first run creates a snapshot from whatever the model generates today, which may already be degraded | First snapshot captured during a period of known degradation becomes the new "good" | Require human review of newly created snapshots before committing; flag first-run snapshots distinctly in the snapshot file |

## Observability & Operations

**Key metrics:**

| Metric | What It Measures | Collection Method |
|--------|-----------------|-------------------|
| `snapshot_pass_rate` | Fraction of test cases passing per run | Count(pass) / Count(total) per CI run |
| `snapshot_mean_similarity` | Average semantic similarity across test cases | Mean of per-case similarity scores |
| `snapshot_update_frequency` | How often baselines are being updated | Count of snapshot commit diffs per week |
| `snapshot_corpus_size` | Number of test cases in the baseline set | Count of entries in snapshot store |
| `snapshot_run_duration_ms` | Time to execute the full snapshot suite | End-to-end wall-clock time per CI run |

**Alerting:**

| Alert | Threshold | Severity | Meaning |
|-------|-----------|----------|---------|
| Pass rate drop | < 90% on a run that was previously > 99% | Warning | Possible regression from a change; investigate before merging |
| Pass rate collapse | < 70% | Critical | Significant regression or threshold miscalibration; block merge |
| Snapshot update spike | > 30% of baselines updated in one commit | Warning | Either a legitimate model migration or accidental `--updateSnapshot` |
| Mean similarity cliff | Drop > 0.05 in mean similarity with no corresponding snapshot update | Warning | Model or prompt behavior shifted without team awareness |
| Zero new snapshots over 30 days | No new test cases added in 30 days | Low | Coverage is stagnating; review whether the corpus still represents production inputs |

*These thresholds are starting points calibrated for a corpus of 50–200 test cases. Teams with smaller corpora should widen the pass-rate bands; teams with strict quality SLAs should narrow them.*

**Runbook:**

*Pass rate drops below threshold:*
1. Check which test cases failed — run `npm test -- --reporter=verbose` to see per-case similarity scores
2. Review the PR diff: did a prompt change, model version, or retrieval configuration change?
3. If the failure is a real regression: block the change and investigate the prompt delta
4. If the failure is an intentional improvement: review the snapshot diffs, confirm they reflect better output, then run with `--updateSnapshot`
5. If the failure is noise (similarity 0.83 on a 0.85 threshold for stylistic variation): recalibrate threshold, don't update snapshots

*Snapshot update spike:*
1. Identify the commit that triggered the spike
2. Review the snapshot diffs — compare baseline characteristics before and after
3. If the update was intentional (model migration, intentional quality improvement): document in PR; have a second reviewer confirm diffs look correct
4. If accidental: revert the snapshot commit and rerun to restore the baseline

## Tuning & Evolution

| Tuning Lever | Effect | Safe Range | Dangerous Extreme |
|--------------|--------|-----------|-------------------|
| `similarityThreshold` | Controls sensitivity — how much output variation is tolerated | 0.80–0.92 | Below 0.75: stops catching meaningful regressions; above 0.95: noisy on normal rephrasing |
| `structuralMatchRequired` | Whether JSON structure / field presence must match exactly | `true` for structured outputs; `false` for free-form prose | `true` on free-form outputs generates constant noise; `false` on strict schemas misses format regressions |
| Corpus size | More test cases = better coverage, longer run time | 50–300 cases | < 20: coverage too sparse; > 500: CI run time becomes a blocker |
| Snapshot update cadence | How often baselines are refreshed | Review-gated updates on model or prompt changes | Auto-update in every run: defeats the purpose |

**Drift signals — when to revisit configuration:**

- Pass rate is consistently at 99–100% over several weeks without any prompt changes: threshold may be too low, or corpus isn't sampling the inputs that actually vary
- Pass rate fluctuates 5–15% between runs with no changes: threshold is too high for current output variance; lower it or increase embedding stability
- Snapshot suite has grown to > 300 cases but you rarely look at the failure detail: corpus needs pruning; keep representative cases per category, remove redundant ones
- The embedding model used for comparison has been updated: re-run full corpus to calibrate new baseline similarity distribution before restoring thresholds

**Silent degradation:**

At month 3, the risk is snapshot staleness: the corpus was built during early development and no longer reflects the query distribution in production. Pass rates stay high because the test cases don't surface the failure modes users are actually hitting. The signal is a gap between snapshot test pass rates and user-facing quality scores or support ticket rates.

At month 6, the risk is threshold drift: the similarity threshold was calibrated for one model version and one prompt, but both have evolved. The threshold that was "tight" in month 1 is now "loose" relative to current output variance. Run a threshold calibration pass: execute the suite on the current baseline (no changes) and observe the natural similarity distribution; set the threshold at the 5th percentile of that distribution.

Proactive check: quarterly, run the snapshot suite against a randomly sampled set of production inputs (not the fixed corpus) and review the similarity scores. If production samples show consistently lower similarity than the corpus, the corpus has drifted from production reality.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers.

| Scale        | Additional Cost | ROI vs. No Pattern |
| ------------ | --------------- | ------------------ |
| 1K req/day   | ~$0/day production; ~$1–5/day CI (LLM calls) | Avoids ~$300–600 per regression incident (2–4 hr investigation) |
| 10K req/day  | ~$0/day production; ~$5–22/day CI | At 10K req/day, one silent regression costs more than the full month of CI |
| 100K req/day | ~$0/day production; ~$22–66/day CI | Format regressions at this scale corrupt batch pipelines; detection cost negligible vs. remediation |

## Testing

How to verify this pattern works correctly. See test files in `src/ts/` and `src/py/`.

- **Unit tests:** `SnapshotMatcher` similarity comparison logic; threshold boundary conditions (exactly at threshold, just above, just below); `SnapshotStore` read/write/update operations; characteristic extraction from LLM outputs
- **Failure mode tests:** One test per failure mode — stale snapshot detection, threshold miscalibration signal, update-mode behavior, missing baseline handling, embedding model version pinning
- **Integration tests:** Full run with mock provider — first run creates baseline, second run passes, modified output fails with correct delta; update mode correctly overwrites stored snapshots
- **How to run:** `cd src/ts && npm test`

## When This Advice Stops Applying

- Systems where output format is fully deterministic (structured extraction with strict schemas and temperature 0) — exact assertion testing works fine and is simpler
- Very early development where "known-good" isn't yet established — snapshot testing requires a stable baseline to compare against; capturing snapshots too early locks in flawed outputs as the reference
- Creative applications where output variation is intentional and valuable — if the point is diverse outputs, semantic similarity comparisons will flag feature behavior as failures
- Systems where the eval harness already provides sufficient regression coverage — if you're running LLM-as-judge evaluations on every test case with meaningful rubrics, adding snapshot tests duplicates effort without adding signal
- Single-use or throwaway scripts where CI discipline isn't warranted

## Companion Content

- Blog post: [Snapshot Testing — Deep Dive](https://prompt-deploy.com/snapshot-testing) (coming soon)
- Related patterns:
  - [Eval Harness](../eval-harness/) (#4, S1) — the evaluation framework that snapshot testing builds on
  - [Regression Testing](../regression-testing/) (#11, S4) — regression tests catch behavioral changes; snapshots catch output changes
  - [Prompt Rollout Testing](../prompt-rollout-testing/) (#24, S7) — snapshot comparisons between prompt variants
  - [Prompt Diffing](../../observability/prompt-diffing/) (#35, S9) — diffing for prompts, snapshots for outputs

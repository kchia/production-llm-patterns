# Prompt Diffing

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

Prompt changes are the [leading cause of silent quality regressions](https://www.braintrust.dev/articles/what-is-prompt-versioning) in production LLM systems — and they're almost never treated as deployments.

The failure mode is slow and hard to connect. A product manager tweaks system instructions to improve tone. Three days later, structured output parsing starts failing intermittently. The engineering team spends hours checking infrastructure, API limits, and model behavior before someone thinks to look at the prompt. By then, the prompt's been edited twice more, and rolling back means guessing which version was "good."

What makes this worse is that even small changes carry large effects. Changing "Output strictly valid JSON" to "Always respond using clean, parseable JSON" reads as equivalent to a human — but models can interpret the phrasing differently depending on training data and temperature, and in some cases one version introduces trailing commas or omits required fields under edge conditions, silently breaking downstream parsers. A [widely documented production incident](https://deepchecks.com/llm-production-challenges-prompt-update-incidents/) illustrates how a small phrasing change intended to "improve conversational flow" caused structured-output error rates to spike within hours, halting revenue-generating workflows until engineers manually rolled back.

The core problem isn't that prompts change — it's that the change isn't treated as a deployment event with correlation to outcomes. Without diffing, you know the prompt changed (if you're lucky enough to have version history at all), but you can't answer: _which words changed, how much changed, and what did output quality do at that moment?_

## What I Would Not Do

The naive approach is to store the current prompt somewhere (database field, config file, environment variable) and relying on ad hoc notes or git history to track changes.

This breaks in a specific production scenario. At 2am, output quality degrades. You have three versions of the prompt edited in the past week and no clear way to correlate timestamps with the quality drop you're seeing in monitoring. You do a manual read-through of each version looking for the suspect change. It takes 45 minutes and you're not confident you found the right one.

The diffing part is usually solved by just grepping or copy-pasting into a text editor side by side. That works once or twice, but it doesn't scale to a team with multiple active prompts and daily edits. It also doesn't surface the semantic severity of what changed — "added a sentence" looks the same as "changed a safety instruction" in a raw text diff.

The other naive approach is using git diffs on prompt files. Git diffs work, but they have two gaps for LLM prompts specifically. First, they don't distinguish between structural changes (added a section) and semantic changes (softened a constraint) — both show as red/green lines with no signal about production impact. Second, they don't connect to output quality data. Knowing that line 12 changed tells you nothing about whether that change is why your entity extraction accuracy dropped 8%.

## When You Need This

- Prompt changes happen more than weekly and multiple people have edit access
- You've had quality regressions traced back to a prompt change after significant debugging time — the diagnosis took longer than the fix
- Your system has template variables that interact in non-obvious ways across multiple prompt versions
- You're running multiple active prompts (query reformulation, context injection, generation instructions) and need to correlate cross-prompt changes with output metrics
- The team does A/B experiments on prompt variants — you need to compare versions systematically, not manually
- You have output quality monitoring in place and want to correlate metric changes with specific prompt edits

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **RAG → Recommended.** RAG pipelines have multiple prompt touchpoints. When retrieval quality drops, I'd want to quickly surface whether a retrieval reformulation prompt or the answer generation prompt changed in the past week. Without diffing, that correlation is a manual archaeology exercise.
- **Agents → Recommended.** Agent systems are highly sensitive to subtle prompt changes — altering how the planner phrases tool descriptions can shift routing behavior across the entire session. Diffing helps isolate whether a behavior change came from a prompt edit or model drift, which is otherwise hard to distinguish.
- **Streaming → Optional.** Streaming systems typically have fewer prompt touchpoints and more stable templates. The pattern's worth having once the system matures, but it's not what I'd prioritize first. I'd notice the gap eventually, probably not in month one.
- **Batch → Recommended.** Batch jobs reprocess large volumes with the same prompt. A bad prompt version affects the entire run, and you may not know until results are reviewed hours later. I'd want to know exactly what changed between the last good run and the current one — not just that something changed.

## The Pattern

### Architecture

```
 Author edits prompt
         │
         ▼
 ┌─────────────────────┐
 │   Prompt Registry    │  ← v1, v2, v3…
 └──────────┬──────────┘
            │ 1. fetch(v_a, v_b)
            ▼
 ┌────────────────────────────────────────┐
 │             PromptDiffer               │
 │                                        │
 │  ┌──────────────┐  ┌────────────────┐  │
 │  │ TokenizeDiff  │  │ SemanticDist   │  │
 │  │ (word-level)  │  │ (cosine sim)   │  │
 │  └──────┬───────┘  └──────┬─────────┘  │
 │         └────────┬─────────┘           │
 │                  ▼                     │
 │        ┌──────────────────┐            │
 │        │   severity gate  │            │
 │        │  dist > 0.15?    │            │
 │        └──┬──────┬────────┘            │
 │      HIGH │  MED │  LOW               │
 └───────────┼──────┼────────────────────┘
             │      │
             ▼      ▼
        ┌──────────────────────┐
        │  Quality Correlation  │  ← async, joins output
        │  (optional)           │    metrics by version + time
        └──────────┬────────────┘
                   │ 2. DiffResult
                   ▼
           ┌──────────────┐
           │   Reporter    │  ← CLI / API / webhook
           └──────────────┘

Side channel: all diffs logged to trace store with version IDs
```

_Severity thresholds (LOW / MEDIUM / HIGH) and cosine similarity cutoff are illustrative defaults. Tune based on your prompts' sensitivity and the risk tolerance of your deployment._

### Core Abstraction

```typescript
interface PromptDiff {
  versionA: string; // version ID
  versionB: string; // version ID
  hunks: DiffHunk[]; // word-level changes (added, removed, unchanged)
  severity: "LOW" | "MEDIUM" | "HIGH";
  semanticDistance: number; // 0–1 cosine distance between embeddings
  summary: string; // human-readable change description
}

interface PromptDiffer {
  diff(versionA: string, versionB: string): Promise<PromptDiff>;
  diffLatest(promptName: string): Promise<PromptDiff>; // latest vs previous
  correlate(diff: PromptDiff, metrics: QualityMetrics): CorrelationReport;
}
```

### Configurability

| Parameter                 | Default                    | What It Controls                                             |
| ------------------------- | -------------------------- | ------------------------------------------------------------ |
| `diffGranularity`         | `'word'`                   | Token granularity: `'word'` \| `'sentence'` \| `'paragraph'` |
| `semanticModel`           | `'text-embedding-3-small'` | Embedding model for semantic distance                        |
| `highSeverityThreshold`   | `0.15`                     | Cosine distance above which changes are HIGH severity        |
| `mediumSeverityThreshold` | `0.05`                     | Cosine distance above which changes are MEDIUM severity      |
| `includeUnchanged`        | `false`                    | Whether to include unchanged spans in diff output            |
| `maxHunkContext`          | `3`                        | Number of surrounding words to include for context           |

_Defaults are starting points. If your prompts use highly technical vocabulary or have strict structural constraints, you'll likely want to lower the severity thresholds. If prompts are long and conversational, start with sentence-level granularity._

### Key Design Tradeoffs

**Word-level diff vs. line-level diff:** Word-level diffing reveals changes that line diffs miss — a single-word substitution on a long line looks unchanged in a line diff. The tradeoff is verbosity: word-level diffs on long prompts produce large output. Sentence-level is a reasonable middle ground for production display.

**Semantic distance via embeddings vs. structural diff only:** A structural diff tells you what bytes changed. Semantic distance tells you how much the meaning shifted. Changing "do not include" to "exclude" has near-zero semantic distance but significant structural diff output — useful signal for triage. The tradeoff is latency: embedding calls can add roughly 50–200ms per diff, though actual latency varies with model size, provider, and network conditions. Cache embeddings per version to amortize this. [LangSmith's Prompt Hub](https://changelog.langchain.com/announcements/diff-view-in-langsmith-s-prompt-hub) ships this same pairing — structural diff view alongside semantic evaluation.

**Synchronous vs. asynchronous correlation:** Correlating diffs with quality metrics requires time-windowed data, which often isn't available at diff time. The pattern separates diffing (synchronous, fast) from correlation (asynchronous, requires metric lag). Don't block the diff result on correlation.

## Failure Modes

| Failure Mode                                  | Detection Signal                                                                                                       | Mitigation                                                                                                                                                                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **False LOW severity on high-impact changes** | A change classified LOW is later identified as the cause of a quality regression                                       | Add semantic similarity scoring alongside structural diff; tune thresholds based on historical regressions. Treat any change to safety instructions or output format specifications as at least MEDIUM regardless of size |
| **Template variable masking**                 | Diff shows unchanged lines but behavior shifts because a referenced variable changed upstream                          | Version prompt templates and their variable bindings together; diff the rendered prompt for critical deployments, not just the template                                                                                   |
| **Embedding drift**                           | Severity scores shift over time for identical changes as the embedding model is updated                                | Pin embedding model version in config; re-index historical versions when upgrading the embedding model                                                                                                                    |
| **Silent severity accumulation**              | Many LOW-severity changes over months compound into significant behavioral drift; no single diff triggers a HIGH alert | Add a rolling 30-day semantic distance metric across all changes — not just per-diff severity. Alert when cumulative drift exceeds a threshold even if no individual change was HIGH                                      |
| **Correlation latency gaps**                  | Prompt change is deployed; quality metrics take 2–4 hours to stabilize; correlation window misses the signal           | Buffer correlation windows with at least 4–6 hours post-deployment lag; don't run correlation immediately after a prompt change                                                                                           |
| **Registry dependency failure**               | Diff system can't retrieve versions from the registry; silently fails or compares wrong versions                       | Assert version existence before diffing; surface registry errors explicitly rather than returning empty diffs                                                                                                             |

## Observability & Operations

### Key Metrics

| Metric                                | Unit                             | What It Signals                                                                              |
| ------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------- |
| `prompt_diff_severity_distribution`   | count by LOW/MEDIUM/HIGH per day | Frequency of high-impact changes; sudden spike indicates rushed editing                      |
| `prompt_diff_semantic_distance_p95`   | cosine distance (0–1)            | Whether cumulative prompt drift is accelerating                                              |
| `prompt_diff_correlation_lag_seconds` | seconds                          | How quickly correlations are completing; rising lag means metric pipeline is slow            |
| `prompt_diff_registry_fetch_errors`   | count/min                        | Registry connectivity issues; a diff system that can't fetch versions silently stops working |
| `prompt_versions_changed_per_day`     | count                            | Leading indicator — more changes means more exposure                                         |

### Alerting

| Alert                                     | Level    | Threshold                                                               | Action                                                                 |
| ----------------------------------------- | -------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| HIGH-severity diff deployed to production | Warning  | Any HIGH diff reaching prod without a corresponding regression test run | Trigger mandatory eval before promotion                                |
| Cumulative semantic drift                 | Warning  | 30-day rolling cosine distance > 0.30                                   | Schedule a prompt review session; drift has been accumulating silently |
| Correlation lag elevated                  | Warning  | p95 lag > 6 hours for 3+ consecutive hours                              | Check metric pipeline health; correlation results may be unreliable    |
| Registry fetch error rate                 | Critical | > 1% of diff requests failing                                           | Diff system is degraded; prompt changes are deploying without diffing  |

_These thresholds are starting points. If your prompts iterate frequently, lower the cumulative drift threshold. If your prompts are stable for weeks at a time, you can tolerate a higher HIGH-severity threshold before alarming._

### Runbook

**HIGH-severity diff deployed without eval run:**

1. Check which prompt changed: `GET /diffs/latest?promptName=<name>`
2. Verify whether regression test suite was run against the new version
3. If not: pause promotion, trigger eval with existing test cases
4. If eval passes: resume with MEDIUM monitoring window for 2 hours post-deploy
5. If eval fails or no test suite exists: roll back to previous version, file a test gap ticket

**Cumulative drift alert fires:**

1. Pull 30-day diff history: `GET /diffs/history?promptName=<name>&days=30`
2. Sort by semantic distance descending — the highest-distance changes are the candidates
3. Check output quality metrics in the same window — is there a correlated quality shift?
4. If yes: identify the inflection point and investigate that specific diff
5. If no quality shift: drift is benign; update the cumulative baseline

## Tuning & Evolution

### Tuning Levers

| Lever                                     | Safe Range                                              | Dangerous Extreme                                | Effect                                                 |
| ----------------------------------------- | ------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| `highSeverityThreshold` (cosine distance) | 0.10–0.20                                               | < 0.05 (too sensitive, alert fatigue)            | Controls when changes trigger HIGH classification      |
| `diffGranularity`                         | `word` for debugging, `sentence` for production display | `character` (too noisy)                          | Affects readability and signal-to-noise of diffs       |
| Correlation window size                   | 4–8 hours post-deploy                                   | < 1 hour (metrics haven't stabilized)            | Affects whether correlation catches the quality signal |
| Embedding model                           | `text-embedding-3-small` (fast, good enough)            | Very large embedding models (expensive per diff) | Semantic distance accuracy vs. latency                 |

### Drift Signals

- **Increasing average diff size over time**: prompts are accumulating changes faster than they're being reviewed — the signal is that nobody is reading what's accumulating.
- **HIGH-severity diffs that don't correlate with quality changes**: your severity thresholds may be too sensitive, or your quality metrics aren't sensitive enough to detect the impact of these changes. Review both.
- **Correlation window consistently empty**: quality metrics aren't flowing, or the metric pipeline is too slow for your deployment cadence. Check that prompt version IDs are being attached to LLM spans.

Review thresholds quarterly, or whenever you add a new prompt with significantly different structure or sensitivity.

### Silent Degradation

The 6-month failure: cumulative semantic drift that no single diff flags as HIGH. Each change is LOW or MEDIUM. But after 30+ edits, the prompt has drifted far from its original intent — safety constraints have been softened incrementally, formatting instructions have been relaxed, and the overall behavioral envelope has widened.

At Month 3: output quality metrics are stable, but you'd notice careful reading of the current prompt versus the 90-day-ago version would reveal significant drift.

At Month 6: quality metrics may start showing subtle increases in edge case failures — outputs that aren't clearly wrong, but are less precise than they were originally. Tracing this back to "accumulated prompt drift" rather than model behavior change requires the cumulative semantic distance metric.

Proactive check: once a quarter, compute the semantic distance between the current production version and the version from 90 days ago. If it's above your cumulative threshold, run a full regression suite against both versions.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers.

| Scale        | Additional Cost | ROI vs. No Pattern                                                                               |
| ------------ | --------------- | ------------------------------------------------------------------------------------------------ |
| 1K req/day   | +$0.000005/day  | Positive: prevents ~$200+ debugging sessions; pays for itself after the first incident prevented |
| 10K req/day  | +$0.000008/day  | Strongly positive: cost is negligible; value is in preventing undetected prompt regressions      |
| 100K req/day | +$0.000013/day  | Strongly positive: at this scale, an undetected prompt regression affects millions of outputs    |

## Testing

How to verify this pattern works correctly. See test files in `src/ts/` and `src/py/`.

- **Unit tests:** Word-level tokenization and diff accuracy; severity classification against known test cases (no-change → LOW, synonym swap → MEDIUM, structural rewrite → HIGH); template variable detection
- **Failure mode tests:** Registry fetch failure returns explicit error (not empty diff); identical prompts produce zero-distance result; cumulative drift accumulation over N low-severity changes
- **Integration tests:** Full diff workflow — register two versions, diff them, verify hunk structure and severity match expected; correlation with mock quality metrics

To run:

```bash
# TypeScript
cd src/ts && npm test

# Python
cd src/py && python -m pytest tests/
```

## When This Advice Stops Applying

- Systems with a single, rarely-changed prompt — nothing to diff
- Early-stage development where prompts change too rapidly for diffing to be actionable (multiple changes per hour)
- Systems without output quality monitoring — diffing prompts without being able to measure impact tells you what changed but not whether it mattered
- Managed prompt platforms that include prompt comparison features — evaluate whether their diffing capabilities meet your needs before building your own

<!-- ## Companion Content

- Blog post: [Prompt Diffing — Deep Dive](https://prompt-deploy.com/prompt-diffing) (coming soon)
- Related patterns:
  - [Prompt Version Registry](../prompt-version-registry/) — stores the versions that diffing compares
  - [Output Quality Monitoring](../output-quality-monitoring/) — provides the quality metrics to correlate with prompt diffs
  - [Regression Testing](../../testing/regression-testing/) — diffs help explain why regression tests failed
  - [Drift Detection](../drift-detection/) — prompt diffs help distinguish prompt-caused drift from model-caused drift
  - [Snapshot Testing](../../testing/snapshot-testing/) — snapshot diffs for outputs complement prompt diffs for inputs -->

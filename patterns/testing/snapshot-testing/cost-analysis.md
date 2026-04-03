# Cost Analysis: Snapshot Testing

## Overview

Snapshot testing is a **test-time-only pattern** — it adds zero overhead to production request paths. All costs are incurred during CI runs when prompts, models, or retrieval configs change. This makes the cost model fundamentally different from production middleware patterns.

The cost question is: does the CI overhead (compute, embedding API calls) justify the regression prevention?

---

## Assumptions

| Assumption | Value | Justification |
|-----------|-------|---------------|
| Snapshot corpus size | 50–200 test cases | Typical team starting with coverage of major input categories |
| Mock provider (no real API) | $0.00/run | All snapshot comparisons use offline embeddings |
| Real embedding model (optional) | text-embedding-3-small ($0.02/1M tokens) | Only needed if replacing mock with production-grade embeddings |
| Average prompt + response tokens per test case | 500 tokens | 200 input + 300 output, typical for summary/QA tasks |
| CI runs per day | 5–20 | Active team: multiple prompt change PRs per day |
| Regression incident cost avoided | 2–4 hours engineering time | Investigation + rollback when a silent regression surfaces in prod |
| Engineering hour cost | $150/hr | Mid-senior engineer fully loaded |

---

## Production Cost: $0.00

Snapshot testing runs **only in CI**. It adds no API calls, no tokens, and no latency to production request handling. The cost analysis below covers CI-only expenses.

---

## CI Cost: Mock Provider (Recommended)

With the mock provider (character-frequency embeddings), the cost is **compute time only** — no external API calls.

```
CI compute cost per run = 0 (test-time CPU overhead is negligible)
Daily CI cost = $0.00
```

The only real cost is the CI compute time itself (minutes of runner time), which is already paid for by the CI platform subscription.

---

## CI Cost: Real Embedding Model (Optional Upgrade)

If teams replace the mock provider with a real embedding model for higher-fidelity semantic comparison:

**Formula:**
```
Tokens per test case = avg_tokens_per_response  (only the LLM output is embedded)
Daily embedding cost = (CI_runs/day) × (corpus_size) × (tokens_per_case / 1M) × embedding_price_per_1M
```

| Scale (CI runs/day) | Corpus | Tokens/case | text-embedding-3-small | text-embedding-ada-002 |
|---------------------|--------|------------|------------------------|------------------------|
| 5 runs/day | 50 cases | 300 tok | $0.000015/day | $0.00005/day |
| 10 runs/day | 100 cases | 300 tok | $0.00006/day | $0.0002/day |
| 20 runs/day | 200 cases | 300 tok | $0.00024/day | $0.0008/day |

**Monthly maximum (20 runs/day, 200 cases, ada-002):** ~$0.024/month

Real embedding costs are negligible at any reasonable CI cadence. The overhead is measured in fractions of a cent per day.

---

## LLM Call Cost During CI (The Real Variable)

The dominant cost in snapshot testing is not the comparison — it's the LLM call to generate the live output for each test case.

**Formula:**
```
LLM cost per CI run = corpus_size × (avg_input_tokens × input_price + avg_output_tokens × output_price)
Daily LLM CI cost = CI_runs/day × LLM_cost_per_run
```

### GPT-4o ($0.0050/1K input, $0.0150/1K output)

| CI runs/day | Corpus | Input (200 tok) | Output (300 tok) | Daily LLM cost |
|-------------|--------|-----------------|------------------|----------------|
| 5/day | 50 cases | $0.050/run | $0.225/run | $1.38/day |
| 10/day | 100 cases | $0.100/run | $0.450/run | $5.50/day |
| 20/day | 200 cases | $0.200/run | $0.900/run | $22.00/day |

### Claude Sonnet ($0.003/1K input, $0.015/1K output)

| CI runs/day | Corpus | Input (200 tok) | Output (300 tok) | Daily LLM cost |
|-------------|--------|-----------------|------------------|----------------|
| 5/day | 50 cases | $0.030/run | $0.225/run | $1.28/day |
| 10/day | 100 cases | $0.060/run | $0.450/run | $5.10/day |
| 20/day | 200 cases | $0.120/run | $0.900/run | $20.40/day |

### GPT-4o-mini ($0.00015/1K input, $0.0006/1K output)

| CI runs/day | Corpus | Input (200 tok) | Output (300 tok) | Daily LLM cost |
|-------------|--------|-----------------|------------------|----------------|
| 5/day | 50 cases | $0.0015/run | $0.009/run | $0.053/day |
| 10/day | 100 cases | $0.003/run | $0.018/run | $0.21/day |
| 20/day | 200 cases | $0.006/run | $0.036/run | $0.84/day |

---

## ROI Summary

| Scenario | Daily CI cost (GPT-4o) | Cost to catch 1 regression | Engineering time saved |
|----------|----------------------|---------------------------|----------------------|
| 1K req/day production, 5 CI runs/day, 50 cases | $1.38/day | $41/month | 2–4 hrs ($300–600) per avoided incident |
| 10K req/day production, 10 CI runs/day, 100 cases | $5.50/day | $165/month | 2–4 hrs per avoided incident |
| 100K req/day production, 20 CI runs/day, 200 cases | $22.00/day | $660/month | 2–4 hrs per avoided incident, plus production traffic impact |

**Break-even analysis:** At $5.50/day CI cost for a 100-case suite, you break even if the test suite prevents **one regression incident per month** that would have taken 2+ hours to diagnose and roll back. At 100K req/day, a silent format regression can corrupt downstream pipelines for days before detection — the prevention value far exceeds $660/month.

---

## README Summary Table

| Scale | Additional Cost | ROI vs. No Pattern |
|-------|----------------|-------------------|
| 1K req/day | ~$0/day production; ~$1–5/day CI (LLM calls) | Avoids ~$300–600 per regression incident (2–4 hr investigation) |
| 10K req/day | ~$0/day production; ~$5–22/day CI | At 10K req/day, one silent regression costs more than the full month of CI |
| 100K req/day | ~$0/day production; ~$22–66/day CI | Format regressions at this scale corrupt batch pipelines; detection cost is negligible vs. remediation |

---

## How to Calculate for Your Own Usage

1. **Corpus size** — how many snapshot test cases will you maintain?
2. **CI cadence** — how many prompt change PRs trigger a full snapshot run per day?
3. **LLM model** — which model generates the live outputs for comparison?
4. **Embedding model** — mock (free) or real (fractions of a cent)?

```
Daily CI LLM cost = CI_runs_per_day
  × corpus_size
  × (avg_input_tokens × input_price_per_token + avg_output_tokens × output_price_per_token)

Daily embedding cost = CI_runs_per_day
  × corpus_size
  × avg_output_tokens
  × embedding_price_per_token
```

Example: 10 CI runs/day × 100 cases × (200 tok × $0.000005 + 300 tok × $0.000015) = $5.50/day

**Key insight:** The LLM generation cost dominates all other costs by 3–4 orders of magnitude. Optimise by caching test outputs (only regenerate when the prompt/model changes), rather than calling the LLM on every CI run.

---

## Pricing Notes

Prices as of 2026-04-03. Verify current pricing:
- GPT-4o: platform.openai.com/docs/models
- Claude Sonnet: anthropic.com/api
- text-embedding-3-small: platform.openai.com/docs/guides/embeddings

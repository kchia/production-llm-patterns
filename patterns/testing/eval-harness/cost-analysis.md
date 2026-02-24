# Cost Analysis: Eval Harness

## How the Eval Harness Affects Costs

The eval harness is a **testing tool, not a production middleware** — it doesn't add cost to every production request. Instead, it adds cost during development and CI:

1. **Eval runs in CI/CD:** Every prompt change triggers an eval run against the full dataset. Each case makes one LLM call (or more, if using LLM-as-judge scorers).
2. **LLM-as-judge scoring:** If any scorer uses an LLM to grade outputs, that's an additional API call per case per scorer.
3. **No production overhead:** The harness doesn't run in the production request path. Production costs are unchanged.

The cost question is: **how much does it cost to run evals, and what does that prevent?**

## Assumptions

| Parameter | Value | Justification |
|-----------|-------|---------------|
| Average input tokens per eval case | 200 | Typical system prompt + user input |
| Average output tokens per eval case | 300 | Typical LLM response |
| Eval dataset size | 50 cases (small), 200 cases (medium), 500 cases (large) |  |
| Eval runs per day | 5 (1K req/day system), 15 (10K), 30 (100K) | Scales with deployment frequency |
| LLM-judge calls per case | 0 (code scorers only), 1, or 2 | Depends on scorer configuration |
| Judge input tokens | 500 | System prompt + original input/output + rubric |
| Judge output tokens | 100 | Score + explanation |

## Pricing Reference

| Model | Input (per 1M tokens) | Output (per 1M tokens) |
|-------|----------------------|------------------------|
| GPT-4o | $2.50 | $10.00 |
| Claude Sonnet | $3.00 | $15.00 |
| GPT-4o-mini | $0.15 | $0.60 |

Prices verified February 2026.

## Formulas

```
Per-case generation cost = (input_tokens × input_price) + (output_tokens × output_price)

Per-case judge cost = judge_calls × ((judge_input_tokens × input_price) + (judge_output_tokens × output_price))

Per-case total = generation_cost + judge_cost

Per-eval-run cost = dataset_size × per_case_total

Daily eval cost = eval_runs_per_day × per_eval_run_cost

Monthly eval cost = daily_eval_cost × 30
```

## Cost Projections: GPT-4o

### Code Scorers Only (No LLM Judge)

Per-case cost: (200 × $2.50/1M) + (300 × $10.00/1M) = $0.0005 + $0.003 = **$0.0035/case**

| Scale | Dataset | Runs/Day | Daily Cost | Monthly Cost |
|-------|---------|----------|------------|-------------|
| 1K req/day | 50 cases | 5 | $0.88 | $26 |
| 10K req/day | 200 cases | 15 | $10.50 | $315 |
| 100K req/day | 500 cases | 30 | $52.50 | $1,575 |

### With 1 LLM Judge Scorer (GPT-4o)

Judge per-case: (500 × $2.50/1M) + (100 × $10.00/1M) = $0.00125 + $0.001 = **$0.00225/judge call**

Total per-case: $0.0035 + $0.00225 = **$0.00575/case**

| Scale | Dataset | Runs/Day | Daily Cost | Monthly Cost |
|-------|---------|----------|------------|-------------|
| 1K req/day | 50 cases | 5 | $1.44 | $43 |
| 10K req/day | 200 cases | 15 | $17.25 | $518 |
| 100K req/day | 500 cases | 30 | $86.25 | $2,588 |

### With 2 LLM Judge Scorers (GPT-4o)

Total per-case: $0.0035 + (2 × $0.00225) = **$0.008/case**

| Scale | Dataset | Runs/Day | Daily Cost | Monthly Cost |
|-------|---------|----------|------------|-------------|
| 1K req/day | 50 cases | 5 | $2.00 | $60 |
| 10K req/day | 200 cases | 15 | $24.00 | $720 |
| 100K req/day | 500 cases | 30 | $120.00 | $3,600 |

## Cost Projections: Claude Sonnet

### Code Scorers Only

Per-case cost: (200 × $3.00/1M) + (300 × $15.00/1M) = $0.0006 + $0.0045 = **$0.0051/case**

| Scale | Dataset | Runs/Day | Daily Cost | Monthly Cost |
|-------|---------|----------|------------|-------------|
| 1K req/day | 50 cases | 5 | $1.28 | $38 |
| 10K req/day | 200 cases | 15 | $15.30 | $459 |
| 100K req/day | 500 cases | 30 | $76.50 | $2,295 |

### With 1 LLM Judge Scorer (Claude Sonnet)

Judge per-case: (500 × $3.00/1M) + (100 × $15.00/1M) = $0.0015 + $0.0015 = **$0.003/judge call**

Total per-case: $0.0051 + $0.003 = **$0.0081/case**

| Scale | Dataset | Runs/Day | Daily Cost | Monthly Cost |
|-------|---------|----------|------------|-------------|
| 1K req/day | 50 cases | 5 | $2.03 | $61 |
| 10K req/day | 200 cases | 15 | $24.30 | $729 |
| 100K req/day | 500 cases | 30 | $121.50 | $3,645 |

## Cost Projections: GPT-4o-mini

### Code Scorers Only

Per-case cost: (200 × $0.15/1M) + (300 × $0.60/1M) = $0.00003 + $0.00018 = **$0.00021/case**

| Scale | Dataset | Runs/Day | Daily Cost | Monthly Cost |
|-------|---------|----------|------------|-------------|
| 1K req/day | 50 cases | 5 | $0.05 | $1.58 |
| 10K req/day | 200 cases | 15 | $0.63 | $18.90 |
| 100K req/day | 500 cases | 30 | $3.15 | $94.50 |

### With 1 LLM Judge Scorer (GPT-4o-mini)

Judge per-case: (500 × $0.15/1M) + (100 × $0.60/1M) = $0.000075 + $0.00006 = **$0.000135/judge call**

Total per-case: $0.00021 + $0.000135 = **$0.000345/case**

| Scale | Dataset | Runs/Day | Daily Cost | Monthly Cost |
|-------|---------|----------|------------|-------------|
| 1K req/day | 50 cases | 5 | $0.09 | $2.59 |
| 10K req/day | 200 cases | 15 | $1.04 | $31.05 |
| 100K req/day | 500 cases | 30 | $5.18 | $155.25 |

## How to Calculate for Your Own Usage

1. **Count your eval cases.** Start with the number of production query types × 5-10 examples per type. A system with 10 query types needs ~50-100 eval cases minimum.

2. **Estimate runs per day.** Count daily prompt/code deploys. Each deploy should trigger an eval run. Add 1-2 for scheduled regression checks.

3. **Calculate per-case cost:**
   ```
   generation = (your_avg_input_tokens × model_input_price/1M) + (your_avg_output_tokens × model_output_price/1M)
   judge = num_judges × ((judge_input_tokens × model_input_price/1M) + (judge_output_tokens × model_output_price/1M))
   per_case = generation + judge
   ```

4. **Multiply:**
   ```
   daily = eval_cases × runs_per_day × per_case
   monthly = daily × 30
   ```

5. **Optimization levers:**
   - Use GPT-4o-mini for judge calls (17x cheaper than GPT-4o, often sufficient for grading)
   - Run full dataset on merge, tag-filtered subsets on PR (reduces cases by 60-80%)
   - Cache eval outputs for unchanged prompts (skip re-generation)

## Key Insights

- **Code-only scorers are nearly free.** At $0.88/day for a 50-case suite, there's no cost argument against running evals. The value of catching one regression vastly exceeds the monthly cost.

- **LLM judges are the cost driver.** Adding a single LLM judge roughly doubles the eval cost. Using GPT-4o-mini as the judge instead of GPT-4o cuts judge costs by ~17x while often providing sufficient grading quality.

- **Model choice matters most at scale.** At 100K req/day with 2 GPT-4o judges, monthly cost is $3,600. The same setup with GPT-4o-mini judges: $155. That's a 23x difference.

- **Break-even is immediate.** A single undetected regression that requires a production rollback, customer escalation, or engineering investigation easily costs more in engineer time than months of eval infrastructure. At $26-60/month for a small team, the ROI is effectively infinite.

- **The real cost of evals isn't the API calls — it's building the dataset.** Token costs are predictable and small. The engineering time to curate, label, and maintain a representative eval dataset is the actual investment.

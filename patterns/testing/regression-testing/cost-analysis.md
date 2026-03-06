# Cost Analysis: Regression Testing

## Key Insight

Regression testing is an **offline testing cost**, not a production overhead. The pattern adds zero cost to production requests — costs are incurred only when running the regression suite (typically in CI or on prompt change). The cost question is: "How much does it cost to run the regression suite?" not "How much does it add to each request?"

## Assumptions

| Assumption | Value | Justification |
|-----------|-------|---------------|
| Average input tokens per test case | 200 | System prompt (~150) + user input (~50) |
| Average output tokens per test case | 150 | Typical structured response length |
| Test suite size at 1K req/day scale | 50 cases | Starting suite, 5-10 cases per tag |
| Test suite size at 10K req/day scale | 150 cases | Growing suite, more query type diversity |
| Test suite size at 100K req/day scale | 300 cases | Comprehensive suite, 10-15 cases per tag |
| Suite runs per day | 3 | 1 CI run per prompt change, ~3 changes/day |
| LLM-judge scorer calls | 0 (code scorers only) | Code scorers for cost column; LLM judge adds 1 extra API call per case |
| LLM-judge scorer (when used) | 1 call per case | Uses same model as production for judging |

## Formulas

```
Base cost per run = suite_size × (input_tokens × input_price + output_tokens × output_price)

Daily cost = base_cost_per_run × runs_per_day

With LLM-judge scorer:
  Judge cost per run = suite_size × (judge_input_tokens × input_price + judge_output_tokens × output_price)
  judge_input_tokens ≈ 400 (original input + output + rubric)
  judge_output_tokens ≈ 100 (score + reasoning)
  Daily cost = (base_cost_per_run + judge_cost_per_run) × runs_per_day
```

## Cost Projections: GPT-4o ($2.50/1M input, $10.00/1M output)

| Scale | Suite Size | Cost/Run (code scorers) | Cost/Run (+ LLM judge) | Daily Cost (code) | Daily Cost (+ judge) | Monthly Cost (code) | Monthly Cost (+ judge) |
|-------|-----------|------------------------|----------------------|------------------|--------------------|--------------------|---------------------|
| 1K req/day | 50 cases | $0.10 | $0.15 | $0.30 | $0.46 | $9 | $14 |
| 10K req/day | 150 cases | $0.30 | $0.46 | $0.90 | $1.38 | $27 | $41 |
| 100K req/day | 300 cases | $0.60 | $0.92 | $1.80 | $2.75 | $54 | $83 |

### GPT-4o Calculation Detail

```
Per case: 200 × $0.0000025 + 150 × $0.000010 = $0.0005 + $0.0015 = $0.002

50 cases: 50 × $0.002 = $0.10/run
150 cases: 150 × $0.002 = $0.30/run
300 cases: 300 × $0.002 = $0.60/run

LLM-judge per case: 400 × $0.0000025 + 100 × $0.000010 = $0.001 + $0.001 = $0.002
Judge adds: ~$0.002 per case (roughly doubles per-case cost)
```

## Cost Projections: Claude Sonnet ($3.00/1M input, $15.00/1M output)

| Scale | Suite Size | Cost/Run (code scorers) | Cost/Run (+ LLM judge) | Daily Cost (code) | Daily Cost (+ judge) | Monthly Cost (code) | Monthly Cost (+ judge) |
|-------|-----------|------------------------|----------------------|------------------|--------------------|--------------------|---------------------|
| 1K req/day | 50 cases | $0.14 | $0.23 | $0.43 | $0.68 | $13 | $20 |
| 10K req/day | 150 cases | $0.43 | $0.68 | $1.28 | $2.03 | $38 | $61 |
| 100K req/day | 300 cases | $0.86 | $1.35 | $2.57 | $4.05 | $77 | $122 |

### Claude Sonnet Calculation Detail

```
Per case: 200 × $0.000003 + 150 × $0.000015 = $0.0006 + $0.00225 = $0.00285

50 cases: 50 × $0.00285 = $0.14/run
150 cases: 150 × $0.00285 = $0.43/run
300 cases: 300 × $0.00285 = $0.86/run
```

## Cost Projections: GPT-4o-mini ($0.15/1M input, $0.60/1M output)

| Scale | Suite Size | Cost/Run (code scorers) | Cost/Run (+ LLM judge) | Daily Cost (code) | Daily Cost (+ judge) | Monthly Cost (code) | Monthly Cost (+ judge) |
|-------|-----------|------------------------|----------------------|------------------|--------------------|--------------------|---------------------|
| 1K req/day | 50 cases | $0.007 | $0.011 | $0.02 | $0.03 | $0.63 | $1.00 |
| 10K req/day | 150 cases | $0.020 | $0.032 | $0.06 | $0.10 | $1.89 | $3.00 |
| 100K req/day | 300 cases | $0.041 | $0.065 | $0.12 | $0.19 | $3.78 | $5.99 |

### GPT-4o-mini Calculation Detail

```
Per case: 200 × $0.00000015 + 150 × $0.0000006 = $0.00003 + $0.00009 = $0.00012

50 cases: 50 × $0.00012 = $0.006/run ≈ $0.007
150 cases: 150 × $0.00012 = $0.018/run ≈ $0.020
300 cases: 300 × $0.00012 = $0.036/run ≈ $0.041

With LLM-judge: judge adds ~$0.00008 per case — marginal
```

## How to Calculate for Your Own Usage

1. **Count your test cases:** How many cases in your regression suite? Start with 5-10 per query type.
2. **Measure token usage:** Run the suite once and log actual token counts per case. The assumptions above (200 input, 150 output) are typical but your system may differ.
3. **Determine run frequency:** How often does the suite run? Per PR, per merge, scheduled?
4. **Choose your model:** If using LLM-judge scorers, consider GPT-4o-mini for judging — it's 17x cheaper than GPT-4o and often sufficient for rubric-based scoring.
5. **Calculate:**
   ```
   cost_per_run = cases × (your_input_tokens × model_input_price + your_output_tokens × model_output_price)
   daily_cost = cost_per_run × runs_per_day
   monthly_cost = daily_cost × 30
   ```

## Key Insights

- **Regression testing is cheap relative to production spend.** A 300-case suite costs $0.60/run with GPT-4o — catching one regression that would have affected 100K production requests at $0.002 each saves $200+.
- **GPT-4o-mini makes LLM-judge scoring near-free.** At $0.065/run for 300 cases with a judge, monthly cost is under $6. This makes sophisticated semantic scoring accessible even for budget-conscious teams.
- **The real cost is the production incident it prevents.** A regression that reaches production and affects 10K requests before detection costs far more in user trust, engineering time to diagnose, and rollback effort than months of regression suite runs.
- **Code scorers are effectively free.** No API calls, no token costs. Use code scorers for structural checks (format, length, keywords) and reserve LLM judges for semantic quality dimensions.
- **Suite size matters more than model choice.** Doubling the suite doubles cost linearly. But a 150-case suite catches significantly more regressions than 50 cases. The quality improvement usually justifies the cost.

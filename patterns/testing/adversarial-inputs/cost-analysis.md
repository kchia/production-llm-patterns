# Cost Analysis: Adversarial Inputs

## How This Pattern Affects Costs

Adversarial Inputs is a **testing pattern** — it doesn't run in the production request path. Costs are incurred during test runs, not per user request. The cost model depends on what you're testing against:

- **Mock provider testing:** $0. The implementation ships with a configurable mock. Suitable for CI/CD on every commit.
- **Real LLM testing:** Costs scale with test suite size × model price. Suitable for nightly/weekly runs or pre-deploy gates.

The analysis below covers **real LLM testing costs** at three production request scales, since the adversarial test suite size typically scales with system complexity.

## Assumptions

| Parameter | Value | Justification |
|-----------|-------|---------------|
| Adversarial test cases per run | 300 (6 categories × 50 cases) | Default configuration |
| Average input tokens per test case | 150 | Adversarial inputs vary: simple injections ~50 tokens, overflow tests ~500 tokens (truncated), encoding tests ~100 tokens. Weighted average ~150. |
| Average output tokens per response | 80 | Most responses are short refusals or brief completions |
| Test frequency at 1K req/day | Weekly (4 runs/month) | Low-traffic systems run adversarial tests on deploy + weekly |
| Test frequency at 10K req/day | Daily (30 runs/month) | Medium-traffic systems run adversarial tests in nightly CI |
| Test frequency at 100K req/day | Daily + per-deploy (45 runs/month) | High-traffic systems run on every deploy + nightly full suite |
| CI runs with mock provider | Every commit — $0 | Mock provider covers regression testing; real LLM runs catch model-level changes |

## Formulas

```
Tokens per run:
  input_tokens  = test_cases × avg_input_tokens  = 300 × 150 = 45,000
  output_tokens = test_cases × avg_output_tokens  = 300 × 80  = 24,000

Cost per run:
  run_cost = (input_tokens × input_price / 1M) + (output_tokens × output_price / 1M)

Monthly cost:
  monthly_cost = run_cost × runs_per_month

ROI comparison:
  The "without pattern" cost isn't a direct comparison — without adversarial testing,
  the cost is $0 on testing but higher on incident response. ROI is measured as
  testing_cost vs. expected_incident_cost × probability_of_incident.
```

## Cost Projections

### GPT-4o ($2.50/1M input, $10.00/1M output)

```
Cost per run = (45,000 × $2.50 / 1M) + (24,000 × $10.00 / 1M)
             = $0.1125 + $0.24
             = $0.35 per run
```

| Scale | Runs/Month | Monthly Cost | Daily Equivalent | Test Cases/Month |
|-------|-----------|-------------|-----------------|-----------------|
| 1K req/day | 4 | $1.41 | $0.05 | 1,200 |
| 10K req/day | 30 | $10.58 | $0.35 | 9,000 |
| 100K req/day | 45 | $15.86 | $0.53 | 13,500 |

### Claude Sonnet ($3.00/1M input, $15.00/1M output)

```
Cost per run = (45,000 × $3.00 / 1M) + (24,000 × $15.00 / 1M)
             = $0.135 + $0.36
             = $0.50 per run
```

| Scale | Runs/Month | Monthly Cost | Daily Equivalent | Test Cases/Month |
|-------|-----------|-------------|-----------------|-----------------|
| 1K req/day | 4 | $1.98 | $0.07 | 1,200 |
| 10K req/day | 30 | $14.85 | $0.50 | 9,000 |
| 100K req/day | 45 | $22.28 | $0.74 | 13,500 |

### GPT-4o-mini ($0.15/1M input, $0.60/1M output)

```
Cost per run = (45,000 × $0.15 / 1M) + (24,000 × $0.60 / 1M)
             = $0.00675 + $0.0144
             = $0.02 per run
```

| Scale | Runs/Month | Monthly Cost | Daily Equivalent | Test Cases/Month |
|-------|-----------|-------------|-----------------|-----------------|
| 1K req/day | 4 | $0.08 | <$0.01 | 1,200 |
| 10K req/day | 30 | $0.63 | $0.02 | 9,000 |
| 100K req/day | 45 | $0.95 | $0.03 | 13,500 |

## How to Calculate for Your Own Usage

1. **Count your test cases:** `categories × casesPerCategory`. Default is 6 × 50 = 300.
2. **Estimate tokens:** Input tokens vary by generator — injection tests average ~100, overflow tests average ~500 (capped). Use 150 as a weighted average. Output tokens average ~80.
3. **Determine run frequency:** How often do you run against a real LLM? Mock provider runs are free.
4. **Plug into formula:**
   ```
   monthly_cost = runs_per_month × ((test_cases × 150 × input_price / 1M) + (test_cases × 80 × output_price / 1M))
   ```
5. **Adjust for LLM-as-judge:** If using an LLM judge instead of the built-in rule-based judge, double the cost (each test case requires an additional LLM call to evaluate the response).

## Key Insights

- **Testing costs are negligible compared to production API spend.** At 100K req/day with GPT-4o, production costs likely exceed $1,000/day. Adversarial testing adds $0.53/day — a 0.05% overhead for meaningful security coverage.
- **Model choice matters 25x.** GPT-4o-mini at $0.02/run vs. Claude Sonnet at $0.50/run. For adversarial testing specifically, cheaper models are often sufficient — you're testing your system's safety filters and pipeline behavior, not the model's reasoning quality.
- **Mock provider eliminates most costs.** CI runs (every commit) use the mock. Real LLM runs (nightly/weekly) catch model-level behavior changes. This hybrid approach gets 90%+ coverage at mock-only costs.
- **Break-even vs. incident cost.** A single adversarial input incident (data leak, unauthorized tool call) can cost $10K-$3M in remediation and regulatory response. At $16/month for daily GPT-4o testing, the break-even is one prevented incident per ~15 years of testing.
- **LLM-as-judge doubles cost.** If you upgrade from rule-based judging to LLM-as-judge for more nuanced evaluation, expect 2x the cost per run. At GPT-4o-mini prices, this is still under $1/month at any scale.

# Cost Analysis: Output Quality Monitoring

## How This Pattern Affects Costs

Output Quality Monitoring is primarily a **compute and storage** cost, not a token cost. The pattern doesn't make additional LLM API calls in its default configuration — it scores existing responses using deterministic and heuristic scorers that run locally. The cost profile:

- **No extra API calls** in the default configuration (deterministic + heuristic scorers)
- **Compute overhead:** Negligible — ~0.006ms per interaction at p50 (see benchmarks)
- **Storage cost:** Score metadata stored per sampled interaction
- **Optional LLM-as-judge cost:** If you add an LLM scorer (not in the default implementation), each scored interaction incurs an additional API call

This analysis covers two scenarios: the default (no LLM scorer) and the optional LLM-as-judge configuration.

## Assumptions

| Parameter | Value | Justification |
| --------- | ----- | ------------- |
| Average input tokens/request | 500 | Typical prompt with context |
| Average output tokens/request | 200 | Typical response |
| Sample rate | 10% | Default configuration |
| LLM-as-judge input (if used) | 800 tokens | Original input + output + scoring prompt |
| LLM-as-judge output (if used) | 50 tokens | Score + brief reasoning |
| Infrastructure cost | ~$0.10/day per 10K scored samples | In-memory storage, minimal compute |

## Model Pricing (as of March 2026)

| Model | Input | Output |
| ----- | ----- | ------ |
| GPT-4o | $2.50 / 1M tok | $10.00 / 1M tok |
| Claude Sonnet | $3.00 / 1M tok | $15.00 / 1M tok |
| GPT-4o-mini | $0.15 / 1M tok | $0.60 / 1M tok |

## Scenario A: Default Configuration (Deterministic Scorers Only)

No additional API calls. Cost is infrastructure only.

| Scale | Samples Scored/Day | Infrastructure Cost | Additional API Cost |
| ----- | ------------------ | ------------------- | ------------------- |
| 1K req/day | 100 | ~$0.01/day | $0.00 |
| 10K req/day | 1,000 | ~$0.10/day | $0.00 |
| 100K req/day | 10,000 | ~$1.00/day | $0.00 |

**This is the recommended starting configuration.** Deterministic scorers (length, format, keyword) catch a significant class of quality issues at effectively zero marginal cost.

## Scenario B: With LLM-as-Judge Scorer (Optional)

Each scored sample requires one additional LLM call for quality evaluation.

### GPT-4o

| Scale | Samples/Day | Judge Input Cost | Judge Output Cost | Total Additional | % of Base Spend |
| ----- | ----------- | ---------------- | ----------------- | ---------------- | --------------- |
| 1K req/day | 100 | $0.20 | $0.50 | **$0.70/day** | 21.5% |
| 10K req/day | 1,000 | $2.00 | $5.00 | **$7.00/day** | 21.5% |
| 100K req/day | 10,000 | $20.00 | $50.00 | **$70.00/day** | 21.5% |

### Claude Sonnet

| Scale | Samples/Day | Judge Input Cost | Judge Output Cost | Total Additional | % of Base Spend |
| ----- | ----------- | ---------------- | ----------------- | ---------------- | --------------- |
| 1K req/day | 100 | $0.24 | $0.75 | **$0.99/day** | 22.0% |
| 10K req/day | 1,000 | $2.40 | $7.50 | **$9.90/day** | 22.0% |
| 100K req/day | 10,000 | $24.00 | $75.00 | **$99.00/day** | 22.0% |

### GPT-4o-mini

| Scale | Samples/Day | Judge Input Cost | Judge Output Cost | Total Additional | % of Base Spend |
| ----- | ----------- | ---------------- | ----------------- | ---------------- | --------------- |
| 1K req/day | 100 | $0.01 | $0.003 | **$0.01/day** | 6.7% |
| 10K req/day | 1,000 | $0.12 | $0.03 | **$0.15/day** | 7.7% |
| 100K req/day | 10,000 | $1.20 | $0.30 | **$1.50/day** | 7.7% |

## Formulas

```
Base daily cost = requests/day × (avg_input_tokens × input_price + avg_output_tokens × output_price)

Example (GPT-4o, 10K req/day):
  = 10,000 × (500 × $2.50/1M + 200 × $10.00/1M)
  = 10,000 × ($0.00125 + $0.00200)
  = 10,000 × $0.00325
  = $32.50/day

Monitoring cost (deterministic only) = infrastructure_cost ≈ $0.10/day (negligible)

Monitoring cost (with LLM judge) = samples/day × (judge_input_tokens × input_price + judge_output_tokens × output_price)

Example (GPT-4o, 10K req/day, 10% sample rate):
  = 1,000 × (800/1M × $2.50 + 50/1M × $10.00)
  = 1,000 × ($0.0020 + $0.0005)
  = $2.00/day (judge input) + $5.00/day (judge output) = $7.00/day

Monitor overhead % = monitoring_cost / base_cost × 100
  = $7.00 / $32.50 = 21.5%

Base costs per day (for reference):
  GPT-4o:      1K=$3.25  |  10K=$32.50  |  100K=$325.00
  Claude:      1K=$4.50  |  10K=$45.00  |  100K=$450.00
  GPT-4o-mini: 1K=$0.20  |  10K=$1.95   |  100K=$19.50
```

## How to Calculate for Your Own Usage

1. **Determine your base daily cost:**
   ```
   base_cost = daily_requests × (your_avg_input_tokens / 1M × your_model_input_price
              + your_avg_output_tokens / 1M × your_model_output_price)
   ```

2. **Deterministic scorers only (recommended start):**
   ```
   monitoring_cost ≈ $0.01 × (daily_requests / 1000)  # infrastructure only
   ```

3. **With LLM-as-judge:**
   ```
   samples_per_day = daily_requests × sample_rate
   judge_cost = samples_per_day × (judge_input_tokens / 1M × judge_model_input_price
              + judge_output_tokens / 1M × judge_model_output_price)
   ```

4. **Cost optimization levers:**
   - Lower sample rate (5% instead of 10%) cuts judge cost in half
   - Use GPT-4o-mini as the judge model — 15-20x cheaper than GPT-4o with adequate quality for many scoring tasks
   - Use deterministic scorers for the majority of quality signals, LLM judge only for nuanced assessment

## Key Insights

- **Deterministic scorers are free** (from an API cost perspective). Start here. Length, format, keyword, and structural checks catch a surprising amount of quality degradation at zero marginal cost.
- **LLM-as-judge adds ~22% overhead** when using the same model class for judging as for generation. Using a cheaper model (GPT-4o-mini) for judging drops this to ~7%.
- **Sample rate is the biggest cost lever.** Going from 10% to 5% halves monitoring cost. Going from 10% to 1% cuts it by 90% — but increases the time to detect localized degradation.
- **The real ROI isn't cost savings — it's avoiding quality incidents.** A single undetected quality degradation event that affects 10% of traffic for a week is far more expensive (in user trust, support costs, and engineering time) than the monitoring infrastructure.
- **Break-even is immediate for deterministic scorers.** For LLM-as-judge, the break-even depends on your quality incident frequency — if you've had even one undetected degradation event, the monitoring likely pays for itself.

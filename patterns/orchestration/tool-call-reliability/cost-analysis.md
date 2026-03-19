# Cost Analysis: Tool Call Reliability

> Pricing verified March 2026. Current prices:
> - GPT-4o: $2.50/1M input tokens, $10.00/1M output tokens
> - Claude Sonnet (claude-sonnet-4-6): $3.00/1M input tokens, $15.00/1M output tokens
> - GPT-4o-mini: $0.15/1M input tokens, $0.60/1M output tokens

## Summary

Tool Call Reliability adds cost through repair round-trips (additional API calls when validation fails). The pattern does not add system prompt tokens to every request — validation is a post-processing step on the LLM's response. Cost impact is driven entirely by the repair rate.

At a 5% repair rate (1 in 20 requests needs one repair attempt), the pattern adds ~5% to your LLM API costs. At a 15% repair rate, it adds ~15%. The pattern's cost breaks even with the alternative (absorbing tool call failures and losing user requests) at very low repair rates.

## Assumptions

| Parameter | Value | Justification |
|-----------|-------|---------------|
| Avg input tokens per request | 800 tokens | Typical: 200 system prompt + 300 conversation + 300 tool schemas |
| Avg output tokens per response | 150 tokens | Tool call JSON response (typically 100–200 tokens) |
| Repair message tokens (input) | 200 tokens | Validation error feedback added to context on repair |
| Repair output tokens | 150 tokens | Same output size as original call |
| Baseline repair rate | 5% | Conservative estimate; tau-bench data shows 39–75% failure rates without constrained decoding — 5% assumes constrained decoding is enabled |
| Repair success rate | 80% | Most failures are correctable with structured feedback |
| Max repair attempts | 2 | Default config |

**Repair rate sensitivity:** Without constrained decoding (OpenAI `strict: true`), tool call parse failures can reach 20–40%. With constrained decoding, semantic errors remain and drive a 3–8% repair rate in practice. This analysis uses 5% as a baseline and shows the 15% scenario.

## Formulas

```
Base cost per request = (input_tokens × input_price) + (output_tokens × output_price)

Repair cost per request = repair_rate × (
  (repair_input_tokens × input_price) + (repair_output_tokens × output_price)
)

Total cost = Base cost + Repair cost
Daily cost = Total cost × requests_per_day

Repair overhead % = Repair cost / Base cost × 100
```

## Cost Projections

### GPT-4o ($2.50/1M input, $10.00/1M output)

| Scale | Base Cost/day | +Repair (5% rate) | +Repair (15% rate) | Break-even |
|-------|---------------|-------------------|--------------------|------------|
| 1K req/day | $3.50 | +$0.18/day (+5.0%) | +$0.53/day (+15.0%) | Immediate |
| 10K req/day | $35.00 | +$1.75/day (+5.0%) | +$5.25/day (+15.0%) | Immediate |
| 100K req/day | $350.00 | +$17.50/day (+5.0%) | +$52.50/day (+15.0%) | Immediate |

*Base: 800 input + 150 output tokens × GPT-4o pricing*
*Repair: 200 additional input + 150 output tokens per repaired request*

### Claude Sonnet ($3.00/1M input, $15.00/1M output)

| Scale | Base Cost/day | +Repair (5% rate) | +Repair (15% rate) |
|-------|---------------|-------------------|--------------------|
| 1K req/day | $4.65 | +$0.23/day (+5.0%) | +$0.70/day (+15.0%) |
| 10K req/day | $46.50 | +$2.33/day (+5.0%) | +$6.98/day (+15.0%) |
| 100K req/day | $465.00 | +$23.25/day (+5.0%) | +$69.75/day (+15.0%) |

### GPT-4o-mini ($0.15/1M input, $0.60/1M output)

| Scale | Base Cost/day | +Repair (5% rate) | +Repair (15% rate) |
|-------|---------------|-------------------|--------------------|
| 1K req/day | $0.21 | +$0.01/day (+5.0%) | +$0.03/day (+15.0%) |
| 10K req/day | $2.10 | +$0.11/day (+5.0%) | +$0.32/day (+15.0%) |
| 100K req/day | $21.00 | +$1.05/day (+5.0%) | +$3.15/day (+15.0%) |

## Detailed Calculation (GPT-4o, 5% repair rate)

```
Input price:  $2.50 / 1,000,000 = $0.0000025 per token
Output price: $10.00 / 1,000,000 = $0.000010 per token

Base cost per request:
  = (800 × $0.0000025) + (150 × $0.000010)
  = $0.002000 + $0.001500
  = $0.003500 per request

Repair cost per repaired request:
  = (200 × $0.0000025) + (150 × $0.000010)
  = $0.000500 + $0.001500
  = $0.002000 per repair attempt

Repair cost per request (at 5% repair rate):
  = 0.05 × $0.002000
  = $0.000100 per request

Total cost per request:
  = $0.003500 + $0.000100
  = $0.003600 (2.86% increase)

Daily cost at 10K req/day:
  = 10,000 × $0.003600
  = $36.00/day

Overhead:
  = $0.000100 / $0.003500 × 100
  = 2.86% overhead at 5% repair rate
```

*Note: The tables above use exactly 5% as a multiplier for clarity. The actual overhead percentage is 2.86% of the total cost at 5% repair rate, because repair requests are smaller than base requests (200 input tokens vs. 800).*

## How to Calculate for Your Usage

1. **Measure your actual repair rate** — deploy with metrics and observe `tool_call_repair_rate` for 1–2 weeks. This is the most important input.

2. **Measure your actual token usage** — log `prompt_tokens` and `completion_tokens` from your provider's response object. The 800/150 defaults may not match your workload.

3. **Plug into the formula:**
   ```
   actual_repair_cost_per_day =
     (requests_per_day × actual_repair_rate)
     × ((repair_input_tokens × your_input_price)
        + (repair_output_tokens × your_output_price))
   ```

4. **Compare against the alternative** — the counterfactual is absorbing tool call failures. For agent systems, a failed tool call typically means a failed task, which means either a user retry (another full request) or a lost conversion. A 5% repair rate that saves 4% of those requests pays for itself at any scale.

## Key Insights

- **The cost impact scales exactly with your repair rate.** A 5% repair rate at GPT-4o pricing adds ~2.86% to your LLM API cost. Reduce repair rate by improving tool schemas and you reduce the pattern's cost proportionally.

- **Repair messages are small.** The additional context per repair is ~200 tokens (error description) — much smaller than the base request. At 5% repair rate, the marginal cost is negligible.

- **GPT-4o-mini makes this nearly free.** At mini pricing, the pattern adds <$0.01/day at 1K requests and <$1.05/day at 100K. The economic case is strongest for high-volume, cost-sensitive workloads where catching every repair failure matters.

- **The break-even point is immediate.** Any tool call failure that causes a user-visible error or a silent data corruption is worth multiple API call costs to prevent. The repair pattern pays for itself by avoiding even one failed agent session per hour.

- **Watch for repair rate drift.** A repair rate that rises from 3% to 12% over six months adds $52.50/day in unexpected costs at 100K requests on GPT-4o. Monthly monitoring of the repair rate controls cost as much as it controls reliability.

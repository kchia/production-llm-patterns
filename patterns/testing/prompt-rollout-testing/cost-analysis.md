# Cost Analysis: Prompt Rollout Testing

## How This Pattern Affects Cost

The rollout tester itself makes no extra LLM API calls in A/B and canary mode — each request is routed to exactly one variant. Shadow mode is the exception: both variants fire for every request, which doubles your API spend during the shadow period.

Three distinct cost profiles:

| Mode | API Call Overhead | Token Overhead | When to Use |
|---|---|---|---|
| **Canary** (1–10%) | 0× extra calls | +0–5% (fraction of traffic sees candidate prompt) | Default choice. Minimal cost, catches regressions before 90–99% of users |
| **A/B** (50/50) | 0× extra calls | +0–10% (half of traffic sees candidate prompt) | When you need faster signal or traffic is too low for canary |
| **Shadow** (100%) | 1× extra calls | +100% during shadow | When you can't risk any user seeing candidate output |

---

## Assumptions

| Parameter | Value | Justification |
|---|---|---|
| `avg_input_tokens` | 500 | Typical RAG or agent prompt: system prompt + context + query |
| `avg_output_tokens` | 200 | Medium-length structured response |
| `candidate_prompt_overhead` | +50 input tokens | Candidate prompts typically add examples, instructions, or formatting guidance |
| `canary_weight` | 0.05 (5%) | Default starting weight |
| `ab_weight` | 0.50 (50%) | Equal traffic split |
| `shadow_multiplier` | 2.0 | Both variants run; user sees current only |
| `experiment_duration` | 7 days | Typical experiment window to reach statistical significance |

> These assumptions are conservative. Candidate prompts that are shorter than current save money. Shadow mode cost is the ceiling — it fully doubles API spend during the experiment window only.

---

## Formulas

```
# Base daily cost per request
cost_per_req = avg_input_tokens × input_price + avg_output_tokens × output_price

# Base daily cost
base_daily = requests_per_day × cost_per_req

# Canary mode: only canary_weight fraction sees the candidate prompt
# candidate_overhead_tokens = extra input tokens in candidate prompt
canary_additional = requests_per_day × canary_weight × candidate_overhead_tokens × input_price

# A/B mode: half of traffic sees candidate prompt
ab_additional = requests_per_day × 0.5 × candidate_overhead_tokens × input_price

# Shadow mode: doubles all API calls (both variants fire for every request)
shadow_additional = base_daily  # same cost again

# Pattern cost (canary mode example)
pattern_cost = base_daily + canary_additional

# Shadow total
shadow_total = base_daily × 2
```

---

## GPT-4o Projections ($2.50 / 1M input, $10.00 / 1M output)

**Base cost per request:** 500 × $2.50/1M + 200 × $10.00/1M = $0.00125 + $0.002 = **$0.00325**

### Canary Mode (5% of traffic, +50 input tokens for candidate)

| Scale | Base Daily | Additional (canary) | Total Daily | Additional per Month |
|---|---|---|---|---|
| 1K req/day | $3.25 | +$0.006 | $3.26 | +$0.19 |
| 10K req/day | $32.50 | +$0.06 | $32.56 | +$1.88 |
| 100K req/day | $325.00 | +$0.63 | $325.63 | +$18.75 |

### A/B Mode (50% of traffic, +50 input tokens for candidate)

| Scale | Base Daily | Additional (A/B) | Total Daily | Additional per Month |
|---|---|---|---|---|
| 1K req/day | $3.25 | +$0.06 | $3.31 | +$1.88 |
| 10K req/day | $32.50 | +$0.63 | $33.13 | +$18.75 |
| 100K req/day | $325.00 | +$6.25 | $331.25 | +$187.50 |

### Shadow Mode (100% dual-fire, full duration)

| Scale | Base Daily | Additional (shadow) | Total Daily | Additional per Month |
|---|---|---|---|---|
| 1K req/day | $3.25 | +$3.25 | $6.50 | +$97.50 |
| 10K req/day | $32.50 | +$32.50 | $65.00 | +$975.00 |
| 100K req/day | $325.00 | +$325.00 | $650.00 | +$9,750.00 |

---

## Claude Sonnet Projections ($3.00 / 1M input, $15.00 / 1M output)

**Base cost per request:** 500 × $3.00/1M + 200 × $15.00/1M = $0.0015 + $0.003 = **$0.0045**

### Canary Mode (5%, +50 input tokens)

| Scale | Base Daily | Additional | Total Daily |
|---|---|---|---|
| 1K req/day | $4.50 | +$0.008 | $4.51 |
| 10K req/day | $45.00 | +$0.075 | $45.08 |
| 100K req/day | $450.00 | +$0.75 | $450.75 |

### Shadow Mode

| Scale | Base Daily | Additional | Total Daily |
|---|---|---|---|
| 1K req/day | $4.50 | +$4.50 | $9.00 |
| 10K req/day | $45.00 | +$45.00 | $90.00 |
| 100K req/day | $450.00 | +$450.00 | $900.00 |

---

## GPT-4o-mini Projections ($0.15 / 1M input, $0.60 / 1M output)

**Base cost per request:** 500 × $0.15/1M + 200 × $0.60/1M = $0.000075 + $0.00012 = **$0.000195**

### Canary Mode (5%, +50 input tokens)

| Scale | Base Daily | Additional | Total Daily |
|---|---|---|---|
| 1K req/day | $0.20 | +$0.0004 | $0.20 |
| 10K req/day | $1.95 | +$0.004 | $1.95 |
| 100K req/day | $19.50 | +$0.04 | $19.54 |

### Shadow Mode

| Scale | Base Daily | Additional | Total Daily |
|---|---|---|---|
| 1K req/day | $0.20 | +$0.20 | $0.40 |
| 10K req/day | $1.95 | +$1.95 | $3.90 |
| 100K req/day | $19.50 | +$19.50 | $39.00 |

---

## How to Calculate for Your Own Usage

1. **Find your base cost per request:**
   ```
   cost_per_req = (avg_input_tokens × input_price_per_token)
                + (avg_output_tokens × output_price_per_token)
   ```
   Where `input_price_per_token = model_input_price / 1_000_000`

2. **Choose your rollout mode:**
   - Canary: multiply cost_per_req by `requests_per_day × canary_weight × candidate_overhead_fraction`
   - A/B: same formula but `weight = 0.5`
   - Shadow: additional cost = `base_daily_cost` (doubles everything)

3. **Calculate your experiment window cost:**
   ```
   experiment_cost = additional_daily_cost × experiment_days
   ```

4. **Compare to the cost of a regression incident:**
   - Estimate: what's the hourly revenue impact of a quality regression?
   - A 1-hour incident at 10K req/day is worth far more than a month of canary overhead
   - The break-even for canary mode is essentially immediate for any revenue-generating system

---

## Key Insights

**Canary is almost free.** At 5% traffic and +50 input tokens overhead, canary mode adds ~$0.04–$1.88 per month per scale tier. The break-even with a single prevented incident is immediate — even a 15-minute quality regression affecting 10K req/day typically costs more than months of canary overhead.

**Shadow mode is expensive — but sometimes the right call.** For safety-critical prompts (PII handling, medical, legal), shadow mode's doubled cost is acceptable because zero users ever see unvalidated candidate output. Budget shadow periods to be short: 3–7 days for most cases.

**A/B mode sits between.** The +2% overhead for GPT-4o at 100K req/day ($6.25/day) is manageable for experiments that run 7–14 days. Don't run A/B indefinitely — once you have statistical significance, promote or rollback.

**Which model matters most.** Shadow mode cost scales linearly with model price. Sonnet's $0.0045/req base cost means shadow at 100K req/day is $450/day in additional spend. For high-volume shadow periods on expensive models, consider reducing shadow duration or moving to canary as soon as you have enough signal.

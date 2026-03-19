# Cost Analysis: Online Eval Monitoring

Online eval monitoring adds cost — it doesn't save tokens or reduce API calls. The value case isn't cost reduction; it's quality regression detection before it drives user churn. The math below helps you decide whether that insurance is worth the overhead at your scale.

---

## Assumptions

| Parameter | Value | Justification |
|-----------|-------|---------------|
| Avg production input tokens | 500 | Typical RAG/chat query with context |
| Avg production output tokens | 200 | Medium-length response |
| Eval (LLM-as-judge) input tokens | 700 | Original input (200) + output (200) + judge prompt (300) |
| Eval output tokens | 50 | Score + brief reasoning (e.g., "Score: 0.8. The response answers the question but omits...") |
| LLM-as-judge sampling rate | 5% | Default for expensive scorers; heuristic scorers run at 100% with near-zero cost |
| Heuristic scorer cost | $0 | Format checks, length validation, keyword presence — no API calls |

_If your judge prompt is leaner (just "Rate 0-1: does this answer the question?"), eval input tokens could be 400-500. Adjust the formula section to recalculate._

---

## Pricing (verified March 2026)

| Model | Input | Output |
|-------|-------|--------|
| GPT-4o | $2.50/1M tok | $10.00/1M tok |
| Claude Sonnet | $3.00/1M tok | $15.00/1M tok |
| GPT-4o-mini | $0.15/1M tok | $0.60/1M tok |

---

## Pattern Cost Impact

This pattern adds cost proportional to: `(sampling_rate × eval_call_cost)` per production request.

Two cost components:
1. **Production requests** — same as without the pattern
2. **Eval calls** — additional LLM calls on sampled traces

**Assumption:** Eval calls use the same model as production (most conservative). Using a cheaper judge model (e.g., GPT-4o-mini as judge) dramatically reduces eval overhead.

---

## Formulas

```
production_cost_per_req = (avg_input_tokens × input_price) + (avg_output_tokens × output_price)

eval_cost_per_eval = (eval_input_tokens × input_price) + (eval_output_tokens × output_price)

additional_cost_per_req = sampling_rate × eval_cost_per_eval

total_daily_cost = requests_per_day × (production_cost_per_req + additional_cost_per_req)

pattern_overhead_per_day = requests_per_day × additional_cost_per_req
```

---

## GPT-4o Projections

_Production calls on GPT-4o. LLM-as-judge also on GPT-4o. 5% sampling._

```
production_cost_per_req = (500 × $2.50/1M) + (200 × $10.00/1M) = $0.00125 + $0.00200 = $0.00325
eval_cost_per_eval      = (700 × $2.50/1M) + (50  × $10.00/1M) = $0.00175 + $0.00050 = $0.00225
additional_per_req      = 0.05 × $0.00225 = $0.0001125
```

| Scale | Base Cost/Day | Additional Cost/Day | Total/Day | Overhead % |
|-------|--------------|---------------------|-----------|------------|
| 1K req/day | $3.25 | +$0.11 | $3.36 | +3.5% |
| 10K req/day | $32.50 | +$1.13 | $33.63 | +3.5% |
| 100K req/day | $325.00 | +$11.25 | $336.25 | +3.5% |

---

## Claude Sonnet Projections

_Production calls on Claude Sonnet. LLM-as-judge on GPT-4o (cheaper judge). 5% sampling._

```
production_cost_per_req = (500 × $3.00/1M) + (200 × $15.00/1M) = $0.00150 + $0.00300 = $0.00450
eval_cost_per_eval      = (700 × $2.50/1M) + (50  × $10.00/1M) = $0.00175 + $0.00050 = $0.00225  [judge on GPT-4o]
additional_per_req      = 0.05 × $0.00225 = $0.0001125
```

| Scale | Base Cost/Day | Additional Cost/Day | Total/Day | Overhead % |
|-------|--------------|---------------------|-----------|------------|
| 1K req/day | $4.50 | +$0.11 | $4.61 | +2.5% |
| 10K req/day | $45.00 | +$1.13 | $46.13 | +2.5% |
| 100K req/day | $450.00 | +$11.25 | $461.25 | +2.5% |

---

## GPT-4o-mini Projections

_Production calls on GPT-4o-mini. LLM-as-judge also on GPT-4o-mini. 5% sampling._

```
production_cost_per_req = (500 × $0.15/1M) + (200 × $0.60/1M) = $0.000075 + $0.000120 = $0.000195
eval_cost_per_eval      = (700 × $0.15/1M) + (50  × $0.60/1M) = $0.000105 + $0.000030 = $0.000135
additional_per_req      = 0.05 × $0.000135 = $0.00000675
```

| Scale | Base Cost/Day | Additional Cost/Day | Total/Day | Overhead % |
|-------|--------------|---------------------|-----------|------------|
| 1K req/day | $0.20 | +$0.01 | $0.21 | +3.5% |
| 10K req/day | $1.95 | +$0.07 | $2.02 | +3.5% |
| 100K req/day | $19.50 | +$0.68 | $20.18 | +3.5% |

---

## How to Calculate for Your Own Usage

1. **Determine your average token counts.** Check your provider's usage dashboard for median input/output tokens per request.

2. **Choose your judge model.** Using a cheaper model for eval (e.g., GPT-4o-mini as judge when running GPT-4o in production) cuts eval overhead by ~16×.

3. **Set your judge prompt size.** A minimal judge prompt ("Does this answer the question? Score 0-1.") runs on ~400 eval input tokens. A detailed rubric might need 1,000+ tokens.

4. **Pick your sampling rate.** Default 5% for LLM-based judges. Increase if your traffic volume is < 500 req/day and you need more samples for reliable drift detection.

5. **Plug into the formula:**
   ```
   daily_overhead = requests_per_day × sampling_rate × eval_cost_per_eval
   ```

6. **Add heuristic scorers for free.** If you add format/length/keyword checks at 100% sampling, those add near-zero marginal cost and give broad coverage.

---

## Key Insights

**Overhead is always ~3.5% of base cost at 5% sampling.** The ratio is fixed: `sampling_rate × (eval_tokens / production_tokens)`. At 5% sampling with ~1,000 eval tokens vs ~700 production tokens, you're paying 3.5% on top.

**Using a cheaper judge model is the primary cost lever.** GPT-4o-mini as judge vs GPT-4o production reduces eval overhead from $0.11/day to $0.007/day at 1K req/day. That's a 16× reduction on eval costs alone.

**The break-even is one avoided silent regression.** A quality regression running for 3 days at 10K req/day costs in user trust, support load, and potential churn — numbers that dwarf $3.39/day in eval costs. Online eval monitoring is one of the few observability patterns where the ROI case is obvious even at small scale.

**Heuristic scorers are practically free.** At 100% sampling, format/length/safety keyword checks add < 1ms overhead and no API cost. Running these on every request gives broad coverage; reserve the 5% LLM-as-judge budget for deep quality signals.

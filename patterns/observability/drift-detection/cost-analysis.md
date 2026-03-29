# Cost Analysis: Drift Detection

Drift detection is unusual in the cost landscape: **the statistical layer adds no API calls and thus near-zero direct cost**. The only cost pathway is the optional LLM-as-judge semantic layer, which fires only when a statistical alert triggers — typically a rare event (0–5 times per day in a stable production system).

The economic case for drift detection is therefore about **avoided costs**, not direct costs: catching a model regression before it compounds saves hours of debugging, customer churn from quality degradation, and the cost of manually reviewing outputs.

---

## Assumptions

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Avg input tokens/request | 500 | Typical mid-length prompt |
| Avg output tokens/request | 400 | Moderate response |
| Alert frequency (stable) | 2 alerts/day | Baseline: one weekly drift event with an MTTD of 3.5 days |
| Alert frequency (high traffic) | 4 alerts/day | Higher traffic → faster window fill → more frequent checks |
| LLM-as-judge call size | 2,000 input + 500 output tokens | Batch of 10 flagged samples per alert |
| Statistical layer extra calls | 0 | All distribution analysis is local/in-process |

**Pricing used (2026):**

| Model | Input | Output |
|-------|-------|--------|
| GPT-4o | $2.50/1M tok | $10.00/1M tok |
| Claude Sonnet | $3.00/1M tok | $15.00/1M tok |
| GPT-4o-mini | $0.15/1M tok | $0.60/1M tok |

---

## Cost Projection: Statistical Layer Only (No LLM-as-Judge)

The statistical drift detector adds **$0.00/day in API costs** regardless of scale. All computation is local: CircularBuffer writes and sort-based distribution stats.

| Scale | Additional API Cost | Infrastructure Cost |
|-------|---------------------|---------------------|
| 1K req/day | $0.00/day | ~$0.00 (CPU negligible) |
| 10K req/day | $0.00/day | ~$0.00 |
| 100K req/day | $0.00/day | ~$0.001/day (CPU: ~3s total compute at 28µs/obs) |

---

## Cost Projection: Statistical + LLM-as-Judge (GPT-4o)

The LLM-as-judge layer fires only on alerts. At stable production traffic, alerts are rare.

**Formula:**
```
Alert cost/day = alert_frequency × (judge_input_tokens × input_price + judge_output_tokens × output_price)
               = alerts/day × (2000 × $2.50/1M + 500 × $10/1M)
               = alerts/day × ($0.005 + $0.005)
               = alerts/day × $0.01
```

| Scale | Alert Freq | LLM-as-Judge Cost | ROI vs. No Pattern |
|-------|-----------|-------------------|--------------------|
| 1K req/day | 2/day | +$0.02/day | Catch regression in hours, not weeks |
| 10K req/day | 2/day | +$0.02/day | Same alert cadence; negligible vs. API spend |
| 100K req/day | 4/day | +$0.04/day | ~$1.20/month for full semantic drift analysis |

---

## Cost Projection: Statistical + LLM-as-Judge (Claude Sonnet)

| Scale | Alert Freq | LLM-as-Judge Cost | ROI |
|-------|-----------|-------------------|-----|
| 1K req/day | 2/day | +$0.02/day | Negligible |
| 10K req/day | 2/day | +$0.02/day | Negligible |
| 100K req/day | 4/day | +$0.05/day | ~$1.50/month |

---

## Cost Projection: Statistical + LLM-as-Judge (GPT-4o-mini, cost-optimized)

At roughly 1/15th the cost of GPT-4o for judge calls:

| Scale | Alert Freq | LLM-as-Judge Cost | Notes |
|-------|-----------|-------------------|-------|
| 1K req/day | 2/day | ~$0.001/day | Effectively free |
| 10K req/day | 2/day | ~$0.001/day | |
| 100K req/day | 4/day | ~$0.002/day | GPT-4o-mini adequate for classification tasks |

---

## How to Calculate for Your Usage

1. **Determine alert frequency:** Start with 2 alerts/day as a baseline. In practice, a stable production system goes weeks without alerts. A system in active development may see more.
2. **Choose LLM-as-judge tier:** GPT-4o-mini is usually adequate for drift classification (categorizing *what* changed). GPT-4o provides better semantic nuance but costs 15x more.
3. **Plug in your judge call size:** If you sample 5 flagged inputs instead of 10, halve the input token estimate.
4. **Formula:**
   ```
   monthly_cost = alerts_per_day × 30 × (input_tokens × input_$/1M_tok / 1M + output_tokens × output_$/1M_tok / 1M)
   ```
5. **Add statistical layer cost: $0** — it's pure in-process compute.

---

## Key Insights

**Break-even scale:** Effectively all scales. At $0.02–$0.05/day for the LLM-as-judge layer, the pattern pays for itself the first time it catches a model regression before it reaches 1% of users. A single quality incident typically costs hours of investigation time; the detection layer costs fractions of a cent per incident.

**Which model tier matters:** For the statistical layer, model choice is irrelevant (no API calls). For LLM-as-judge, GPT-4o-mini typically provides sufficient classification quality at 1/15th the cost of GPT-4o. Upgrade to GPT-4o only if you need nuanced semantic categorization of *what* drifted.

**Alert frequency is the key variable:** The cost projection above assumes 2–4 alerts/day. In practice:
- A stable, pinned-model system may see 0–1 alerts/week
- A system on rolling model updates may see 1–3 alerts/day during update windows
- A system with rapidly shifting input distributions (seasonal, viral) may see 3–5 alerts/day

Set alert frequency based on your model's update cadence and your input distribution's variance, not these defaults.

# Cost Analysis: PII Detection

## Assumptions

PII detection is primarily a **compute cost** pattern, not a token cost pattern. Unlike retry or caching patterns, PII detection doesn't add extra API calls or significantly change token counts. The cost impact is:

1. **Compute overhead**: Sub-millisecond regex processing per request (see benchmarks)
2. **Token delta**: Placeholders (`[SSN_1]`, `[EMAIL_1]`) are typically similar length to original PII — net token impact is negligible
3. **Infrastructure**: The detection layer runs in-process; no additional services required for regex-only detection
4. **Risk avoidance**: The primary ROI is avoiding regulatory fines, not reducing API spend

### Baseline Assumptions

| Parameter | Value | Justification |
|-----------|-------|---------------|
| Avg input tokens | 500/request | Typical chat/query input |
| Avg output tokens | 300/request | Typical completion response |
| PII prevalence | ~5% of requests | Based on Cyberhaven Labs data (11% of data is confidential; ~5% contains structured PII) |
| Avg PII entities per affected request | 2 | Mix of emails, names, phone numbers |
| Placeholder token delta | +2 tokens/entity | `[EMAIL_1]` is ~3 tokens vs `john@example.com` ~5 tokens — net savings, but conservatively assume +2 for longer placeholder types |
| Detection compute cost | ~$0.001/1M requests | Sub-millisecond processing, negligible |

### Model Pricing (verified February 2026)

| Model | Input | Output |
|-------|-------|--------|
| GPT-4o | $2.50/1M tokens | $10.00/1M tokens |
| Claude Sonnet 4.5/4.6 | $3.00/1M tokens | $15.00/1M tokens |
| GPT-4o-mini | $0.15/1M tokens | $0.60/1M tokens |

## Cost Projections

### GPT-4o

| Scale | Base Cost | With PII Detection | Additional Cost | Compliance Risk Without |
|-------|-----------|--------------------|-----------------|-----------------------|
| 1K req/day | $4.25/day | $4.25/day | +$0.00/day | GDPR: up to €20M per incident |
| 10K req/day | $42.50/day | $42.51/day | +$0.01/day | HIPAA: $100–$50K per violation |
| 100K req/day | $425.00/day | $425.10/day | +$0.10/day | Breach notification: $150–$350 per record |

### Claude Sonnet

| Scale | Base Cost | With PII Detection | Additional Cost | Compliance Risk Without |
|-------|-----------|--------------------|-----------------|-----------------------|
| 1K req/day | $6.00/day | $6.00/day | +$0.00/day | GDPR: up to €20M per incident |
| 10K req/day | $60.00/day | $60.01/day | +$0.01/day | HIPAA: $100–$50K per violation |
| 100K req/day | $600.00/day | $600.10/day | +$0.10/day | Breach notification: $150–$350 per record |

### GPT-4o-mini

| Scale | Base Cost | With PII Detection | Additional Cost | Compliance Risk Without |
|-------|-----------|--------------------|-----------------|-----------------------|
| 1K req/day | $0.26/day | $0.26/day | +$0.00/day | GDPR: up to €20M per incident |
| 10K req/day | $2.55/day | $2.55/day | +$0.00/day | HIPAA: $100–$50K per violation |
| 100K req/day | $25.50/day | $25.51/day | +$0.01/day | Breach notification: $150–$350 per record |

## Formulas

```
Base daily cost = requests/day × (avg_input_tokens × input_price + avg_output_tokens × output_price) / 1,000,000

Token delta = requests/day × pii_prevalence × avg_entities × token_delta_per_entity

Additional token cost = token_delta × input_price / 1,000,000

Compute cost = requests/day × $0.000000001  (negligible)

Total additional cost = additional_token_cost + compute_cost

Risk-adjusted ROI = (probability_of_incident × expected_fine) - total_additional_cost
```

**Example (GPT-4o, 10K req/day):**
```
Base cost = 10,000 × (500 × $0.0000025 + 300 × $0.000010) = 10,000 × ($0.00125 + $0.003) = $42.50/day

Token delta = 10,000 × 0.05 × 2 × 2 = 2,000 additional tokens/day

Additional cost = 2,000 × $0.0000025 = $0.005/day ≈ $0.01/day
```

## How to Calculate for Your Own Usage

1. **Estimate your PII prevalence**: Run the detector on a sample of 1,000 recent requests. Count what percentage contain PII. This is your `pii_prevalence`.
2. **Measure token delta**: Compare token counts of original vs. redacted text for PII-containing requests. Average the difference — this is your `token_delta_per_entity`.
3. **Plug into the formula**: Replace `avg_input_tokens`, `avg_output_tokens`, and `requests/day` with your actual numbers.
4. **Factor in regulatory exposure**: Multiply the probability of a compliance incident by your estimated fine/breach cost. Even a 0.1% annual probability of a $1M fine makes the pattern's near-zero cost a clear win.

## Key Insights

**The cost of this pattern is effectively zero.** PII detection adds sub-millisecond compute and negligible token delta. At 100K req/day on GPT-4o, the additional cost is ~$0.10/day ($36.50/year). The pattern pays for itself the moment it prevents a single compliance inquiry.

**The ROI framing is risk avoidance, not cost reduction.** Unlike caching or routing patterns where ROI = dollars saved, PII detection's ROI = potential fines avoided. GDPR penalties can reach €20M or 4% of global turnover. HIPAA violations range from $100 to $50,000 per occurrence. The IBM Cost of a Data Breach Report consistently places the average breach cost above $4M. Against those numbers, a pattern that costs $0.10/day is not a cost decision — it's a compliance decision.

**Model choice doesn't change the calculus.** Whether you're on GPT-4o ($42.50/day base at 10K req) or GPT-4o-mini ($2.55/day base), the PII detection overhead is negligible relative to the base cost. The decision to implement PII detection is independent of model pricing.

**The real cost is engineering time.** Building and maintaining the detection pipeline — custom recognizers, allow lists, monitoring, and periodic audits — takes engineering effort. The ongoing cost is ~2–4 hours/month for tuning and monitoring, not compute or API spend.

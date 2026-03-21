# Cost Analysis: Concurrent Request Management

## Summary

Concurrent Request Management is a **cost-neutral to cost-reducing** pattern. The pattern itself adds no tokens, no extra API calls, and no additional prompts. Its effect on cost is indirect: by preventing failed requests and retry storms, it reduces wasted API spend. At high retry rates (10–40% of requests hitting rate limits), the savings can be substantial.

---

## Assumptions

| Parameter | Value | Justification |
|---|---|---|
| Average input tokens/request | 1,000 | Typical RAG query: system prompt (~300) + context chunks (~500) + user message (~200) |
| Average output tokens/request | 300 | Typical generation response |
| Total tokens/request | 1,300 | Input + output |
| Retry amplification without pattern | 1.7× | From benchmark: 40% rate limit error rate → 1.71× total API calls |
| Retry amplification with pattern | 1.05× | Pattern prevents most retries by rate-limiting before hitting provider; residual 5% for transient errors |
| Rate limit error rate (unmanaged) | 20–40% | Observed in OpenAI community reports for batch jobs without concurrency control |
| Rate limit error rate (managed) | <2% | Pattern goal: stay below provider limit with 20% headroom |

### Why the pattern reduces cost

Without the pattern, retries on rate limit errors consume real tokens and API calls before failing. A request that fails with a 429 has already consumed the request from your RPM quota — but if it's a streaming response, it hasn't generated output tokens, so only input tokens are wasted. For non-streaming requests, the cost of a failed request depends on whether the provider charges for partial responses; most don't, but the retry attempt itself is a full additional request.

The bigger cost source is the retry cascade: if 30% of your requests fail and each retries up to 4 times, your effective API call count is 1.3 × avg_retries ≈ 1.7–2× your successful request count.

---

## Pricing Reference

Prices verified March 2026:

| Model | Input (per 1M tokens) | Output (per 1M tokens) |
|---|---|---|
| GPT-4o | $2.50 | $10.00 |
| Claude Sonnet | $3.00 | $15.00 |
| GPT-4o-mini | $0.15 | $0.60 |

---

## Cost Formulas

```
Base daily cost (no pattern) =
  (req/day) × (avg_input_tokens × input_price/1M + avg_output_tokens × output_price/1M)

Unmanaged daily cost =
  Base cost × retry_amplification_unmanaged

Managed daily cost =
  Base cost × retry_amplification_managed

Daily savings =
  Unmanaged daily cost - Managed daily cost

Pattern overhead cost = $0 (no additional tokens or API calls)
```

---

## Cost Projections: GPT-4o

Using 1,000 input + 300 output tokens/request, 1.7× unmanaged amplification, 1.05× managed:

```
Base cost per request = (1,000 × $2.50/1M) + (300 × $10.00/1M)
                      = $0.0025 + $0.0030
                      = $0.0055
```

| Scale | Base Daily Cost | Unmanaged (1.7×) | Managed (1.05×) | Daily Savings |
|---|---|---|---|---|
| 1K req/day | $5.50 | $9.35 | $5.78 | **$3.58/day** |
| 10K req/day | $55.00 | $93.50 | $57.75 | **$35.75/day** |
| 100K req/day | $550.00 | $935.00 | $577.50 | **$357.50/day** |

---

## Cost Projections: Claude Sonnet

```
Base cost per request = (1,000 × $3.00/1M) + (300 × $15.00/1M)
                      = $0.0030 + $0.0045
                      = $0.0075
```

| Scale | Base Daily Cost | Unmanaged (1.7×) | Managed (1.05×) | Daily Savings |
|---|---|---|---|---|
| 1K req/day | $7.50 | $12.75 | $7.88 | **$4.88/day** |
| 10K req/day | $75.00 | $127.50 | $78.75 | **$48.75/day** |
| 100K req/day | $750.00 | $1,275.00 | $787.50 | **$487.50/day** |

---

## Cost Projections: GPT-4o-mini

```
Base cost per request = (1,000 × $0.15/1M) + (300 × $0.60/1M)
                      = $0.00015 + $0.000180
                      = $0.000330
```

| Scale | Base Daily Cost | Unmanaged (1.7×) | Managed (1.05×) | Daily Savings |
|---|---|---|---|---|
| 1K req/day | $0.33 | $0.56 | $0.35 | **$0.21/day** |
| 10K req/day | $3.30 | $5.61 | $3.47 | **$2.14/day** |
| 100K req/day | $33.00 | $56.10 | $34.65 | **$21.45/day** |

---

## Key Insights

### When does this pattern pay for itself?

**Implementation effort:** 1–3 days of engineering time. At a loaded engineer cost of ~$1,000/day, breakeven at 10K req/day using GPT-4o is:
```
Breakeven = $1,000–$3,000 implementation cost ÷ $35.75/day savings
          = 28–84 days
```
At 100K req/day, breakeven is 3–9 days. The pattern pays for itself quickly at meaningful scale on frontier models.

For GPT-4o-mini, the savings are smaller in absolute dollars — but the pattern still prevents the operational problem of retry storms and unpredictable throughput. The cost argument is less compelling at mini prices; the reliability argument stands at any scale.

### Which model pricing makes the biggest difference?

The savings scale with model cost. Claude Sonnet (expensive output at $15/1M) sees the highest daily savings because each wasted retry costs more. GPT-4o-mini users save less per request but still benefit from reduced 429 error rates and predictable throughput.

### When the retry amplification assumption changes

The 1.7× amplification factor assumes 40% rate limit error rate — a severe burst scenario. At lower error rates:
- 10% error rate → ~1.15× amplification → proportionally lower savings
- 5% error rate → ~1.07× amplification → marginal cost savings, reliability still valuable

If your system never hits rate limits (very low volume, generous tier), the cost savings from this pattern are negligible. The pattern's value is then purely operational: predictable throughput and explicit queue depth visibility.

### Infrastructure costs

The pattern adds no infrastructure costs. The implementation is in-process (no Redis, no external queue) — just in-memory timestamps and a JavaScript semaphore. For multi-instance deployments where coordinated rate limiting is needed, you'd add a Redis-backed shared counter, which adds ~$50–200/month for a small Redis instance. Even then, the savings at 100K req/day using GPT-4o are $357/day → the Redis cost is still worth it.

---

## How to Calculate for Your Own Usage

1. **Measure your current retry rate:** Check provider metrics or application logs for the ratio of total API calls to successful responses. If total calls = 1.4× successful responses, your retry amplification is 1.4×.

2. **Estimate your base cost:**
   ```
   base_cost = (input_tokens × input_price/1M) + (output_tokens × output_price/1M)
   ```
   Use your actual average token counts from provider billing dashboards.

3. **Estimate managed amplification:**
   After implementing the pattern, target <5% rate limit error rate with 20% headroom. Managed amplification ≈ 1 + (target_error_rate × avg_retries_per_error). With 2% error rate and 2 average retries: 1 + (0.02 × 2) = 1.04×.

4. **Project savings:**
   ```
   daily_savings = daily_req × base_cost × (current_amplification - managed_amplification)
   ```

5. **Adjust for your error scenario:**
   If your system only hits rate limits during batch jobs (not interactive traffic), apply the amplification factor only to batch request volume.

# Cost Analysis: Request Batching

## Summary

Request Batching is a **cost-reducing** pattern when paired with managed batch APIs (Anthropic Message Batches, OpenAI Batch API). Both providers offer a flat 50% discount on input and output tokens for batch workloads as of early 2025. Client-side batching alone (grouping requests into concurrent windows) improves throughput and reduces rate limit errors but doesn't change per-token pricing. The cost story here is straightforward: if your workload can tolerate async delivery (minutes to hours), managed batch APIs cut your token spend in half with zero additional infrastructure cost.

---

## Assumptions

| Parameter | Value | Justification |
|---|---|---|
| Average input tokens/request | 500 | Typical batch item: system prompt (~200) + item payload (~300) |
| Average output tokens/request | 200 | Typical classification, extraction, or short generation response |
| Total tokens/request | 700 | Input + output |
| Managed batch API discount | 50% | Both Anthropic and OpenAI offer 50% off input and output for batch API |
| Client-side batching cost impact | 0% | No token savings — same pricing, better throughput and rate limit behavior |
| Infrastructure overhead | ~$0 | In-process batching logic; managed batch APIs require no additional services |

### Three scenarios compared

1. **No batching (sequential/parallel, standard pricing)** — each request pays full standard per-token rate. This is the baseline.
2. **Client-side batching only (real-time)** — requests are grouped into concurrent windows with rate limiting. Same per-token pricing as scenario 1. The value is operational (better throughput, fewer 429s), not cost savings.
3. **Managed batch API (Anthropic/OpenAI)** — requests are submitted as a batch job with async delivery. 50% discount on both input and output tokens. This is where the cost savings come from.

---

## Pricing Reference

| Model | Input (per 1M tokens) | Output (per 1M tokens) | Batch Input (per 1M tokens) | Batch Output (per 1M tokens) |
|---|---|---|---|---|
| GPT-4o | $2.50 | $10.00 | $1.25 | $5.00 |
| Claude Sonnet 3.5 | $3.00 | $15.00 | $1.50 | $7.50 |
| GPT-4o-mini | $0.15 | $0.60 | $0.075 | $0.30 |

---

## Cost Formulas

```
Standard cost per request =
  (avg_input_tokens × input_price/1M) + (avg_output_tokens × output_price/1M)

Batch cost per request =
  Standard cost per request × 0.50

Daily cost =
  (req/day) × cost_per_request

Daily savings =
  Daily standard cost - Daily batch cost
  = Daily standard cost × 0.50

Monthly savings = Daily savings × 30
Annual savings = Daily savings × 365

Pattern infrastructure cost = $0
```

The math is simple: managed batch APIs halve the per-token price. Your savings are exactly 50% of your current spend, regardless of scale.

---

## Cost Projections: GPT-4o

```
Standard cost per request = (500 × $2.50/1M) + (200 × $10.00/1M)
                          = $0.00125 + $0.00200
                          = $0.00325
Batch cost per request    = $0.00325 × 0.50
                          = $0.001625
```

| Scale | Standard Daily Cost | Batch API Daily Cost | Daily Savings | Monthly Savings |
|---|---|---|---|---|
| 1K req/day | $3.25 | $1.63 | **$1.63/day** | **$48.75/mo** |
| 10K req/day | $32.50 | $16.25 | **$16.25/day** | **$487.50/mo** |
| 100K req/day | $325.00 | $162.50 | **$162.50/day** | **$4,875/mo** |

Annual savings: $594 (1K) | $5,931 (10K) | $59,313 (100K)

---

## Cost Projections: Claude Sonnet 3.5

```
Standard cost per request = (500 × $3.00/1M) + (200 × $15.00/1M)
                          = $0.00150 + $0.00300
                          = $0.00450
Batch cost per request    = $0.00450 × 0.50
                          = $0.00225
```

| Scale | Standard Daily Cost | Batch API Daily Cost | Daily Savings | Monthly Savings |
|---|---|---|---|---|
| 1K req/day | $4.50 | $2.25 | **$2.25/day** | **$67.50/mo** |
| 10K req/day | $45.00 | $22.50 | **$22.50/day** | **$675/mo** |
| 100K req/day | $450.00 | $225.00 | **$225.00/day** | **$6,750/mo** |

Annual savings: $821 (1K) | $8,213 (10K) | $82,125 (100K)

---

## Cost Projections: GPT-4o-mini

```
Standard cost per request = (500 × $0.15/1M) + (200 × $0.60/1M)
                          = $0.000075 + $0.000120
                          = $0.000195
Batch cost per request    = $0.000195 × 0.50
                          = $0.0000975
```

| Scale | Standard Daily Cost | Batch API Daily Cost | Daily Savings | Monthly Savings |
|---|---|---|---|---|
| 1K req/day | $0.20 | $0.10 | **$0.10/day** | **$2.93/mo** |
| 10K req/day | $1.95 | $0.98 | **$0.98/day** | **$29.25/mo** |
| 100K req/day | $19.50 | $9.75 | **$9.75/day** | **$292.50/mo** |

Annual savings: $36 (1K) | $358 (10K) | $3,559 (100K)

---

## ROI Summary

| Scale | GPT-4o Savings | Claude Sonnet Savings | GPT-4o-mini Savings |
|---|---|---|---|
| 1K req/day | $49/mo ($594/yr) | $68/mo ($821/yr) | $3/mo ($36/yr) |
| 10K req/day | $488/mo ($5,931/yr) | $675/mo ($8,213/yr) | $29/mo ($358/yr) |
| 100K req/day | $4,875/mo ($59,313/yr) | $6,750/mo ($82,125/yr) | $293/mo ($3,559/yr) |

**At 10K req/day with GPT-4o, managed batching saves ~$488/month. At 100K req/day with Claude Sonnet, it saves ~$6,750/month.**

---

## Key Insights

### When does this pattern pay for itself?

**Implementation effort:** 1-2 days of engineering time for client-side batching, plus integration with managed batch API. At a loaded engineer cost of ~$1,000/day:

```
Breakeven (GPT-4o, 10K req/day) = $1,000-$2,000 ÷ $16.25/day = 62-123 days
Breakeven (GPT-4o, 100K req/day) = $1,000-$2,000 ÷ $162.50/day = 7-13 days
Breakeven (Claude Sonnet, 100K req/day) = $1,000-$2,000 ÷ $225.00/day = 5-9 days
```

At 100K req/day on frontier models, the pattern pays for itself within two weeks. At 10K req/day, breakeven takes 2-4 months — still compelling for any ongoing workload.

### Client-side batching: operational value, not cost value

Client-side batching (scenario 2) doesn't save money. Its value is throughput and reliability: fewer 429 errors, predictable completion times, better GPU utilization on self-hosted infrastructure. The cost analysis here focuses on managed batch APIs (scenario 3) because that's where the dollar savings are.

### The latency tradeoff is real

Managed batch APIs are async. Anthropic's Message Batches API processes within 24 hours (typically much faster). OpenAI's Batch API targets 24-hour completion. This pattern only makes economic sense for workloads where that latency is acceptable: nightly evals, content pipelines, bulk moderation, embedding generation, dataset processing.

### GPT-4o-mini: savings are small in absolute terms

At $0.195/1K requests, even a 50% discount only saves $0.098/day at 1K scale. The batch API integration effort isn't justified by cost alone for mini-tier models at low volume. At 100K req/day ($293/month savings), it starts making sense. For mini models at lower scale, the argument for batching is throughput and rate limits, not cost.

### Compounding with other patterns

Request Batching pairs with [Concurrent Request Management](../../performance/concurrent-request-management/) to control how many batches run in parallel. The cost savings from managed batch APIs are independent of concurrency management — you get the 50% discount regardless. But concurrency management prevents the retry amplification that wastes additional spend on top of standard pricing. Combined, the two patterns can reduce effective API spend by more than 50% when compared to unmanaged sequential processing with high retry rates.

### Infrastructure costs

The pattern adds no infrastructure costs:
- **Client-side batching:** In-process logic — batch scheduler, executor, and result collector run in the application process with no external dependencies.
- **Managed batch APIs:** The batching infrastructure is provider-managed. You submit a batch, poll for completion, and retrieve results. No queues, no workers, no additional services on your side.

---

## How to Calculate for Your Own Usage

1. **Find your average token counts:** Check your provider's usage dashboard for actual input and output token averages per request. The 500/200 assumption here is conservative — RAG workloads with large context windows will have much higher input tokens.

2. **Calculate your standard cost per request:**
   ```
   standard_cost = (your_avg_input_tokens × input_price/1M)
                 + (your_avg_output_tokens × output_price/1M)
   ```

3. **Your batch API savings are exactly half:**
   ```
   daily_savings = (req/day) × standard_cost × 0.50
   monthly_savings = daily_savings × 30
   ```

4. **Adjust for batch-eligible volume:** Not all your traffic may be batch-eligible. If 60% of your requests are batch-compatible (offline, latency-tolerant), apply the 50% discount only to that 60%:
   ```
   daily_savings = (total_req/day × 0.60) × standard_cost × 0.50
   ```

5. **Check current batch API pricing:** Both providers may adjust batch pricing. Verify the current discount before projecting. As of early 2025, both Anthropic and OpenAI offer 50% off for batch workloads.

# Cost Analysis: Graceful Degradation

## How This Pattern Affects Costs

Graceful degradation doesn't add extra LLM calls during normal operation. Its cost impact comes from what happens during provider outages and degraded states:

- **Without the pattern:** Failed requests trigger retries (typically 2–3 attempts), each consuming a timeout wait and potentially partial token usage. At scale, retry storms amplify costs during outages.
- **With the pattern:** Failed requests fall through to lower-cost tiers (cache, rule-based, static) instead of retrying the failing provider. No additional API calls for degraded responses.

The pattern **saves money** during outages by avoiding wasted retries and serving zero-cost responses from cache/rule-based/static tiers.

## Assumptions

- Average input: **500 tokens/request**
- Average output: **200 tokens/request**
- Provider unavailability rate: **1% of requests** (based on OpenAI status page data — multiple incidents per month, each affecting a fraction of traffic)
- Without pattern: failed requests trigger **2 retries on average** before returning an error (each retry waits for timeout, some partial token usage)
- Retry partial token cost: **~30% of a full request** (provider processes part of the input before failing)
- With pattern: no retries during degradation — fallback tiers serve at $0 API cost (cache, rule-based, static)
- Cache hit rate during degradation: **40%** of degraded requests get a cached response; remaining get rule-based or static

## Pricing (verified Feb 2026)

| Model         | Input           | Output           |
| ------------- | --------------- | ---------------- |
| GPT-4o        | $2.50 / 1M tok  | $10.00 / 1M tok  |
| Claude Sonnet | $3.00 / 1M tok  | $15.00 / 1M tok  |
| GPT-4o-mini   | $0.15 / 1M tok  | $0.60 / 1M tok   |

Sources: [OpenAI Pricing](https://openai.com/api/pricing/), [Anthropic Pricing](https://platform.claude.com/docs/en/about-claude/pricing)

## Formula

```
Per-request cost = (input_tokens × input_price / 1M) + (output_tokens × output_price / 1M)

WITHOUT PATTERN:
  Base cost = requests × per_request_cost
  Retry waste = failed_requests × avg_retries × partial_request_cost
  Total = Base cost + Retry waste
  (Failed requests return errors — users get nothing)

WITH PATTERN:
  Successful cost = successful_requests × per_request_cost
  Degraded cost = $0 (cache/rule-based/static tiers have no API cost)
  Total = Successful cost
  (Degraded requests return reduced-quality responses — users get something)

Savings = Retry waste avoided
```

## Cost Projection (GPT-4o pricing)

Per-request cost: (500 × $2.50 / 1M) + (200 × $10.00 / 1M) = $0.00125 + $0.002 = **$0.00325/request**

| Scale        | Without Pattern | With Pattern | Savings    |
| ------------ | --------------- | ------------ | ---------- |
| 1K req/day   | $3.38/day       | $3.22/day    | $0.16/day  |
| 10K req/day  | $33.80/day      | $32.18/day   | $1.63/day  |
| 100K req/day | $338.00/day     | $321.75/day  | $16.25/day |

Breakdown at 10K req/day:
- 9,900 successful × $0.00325 = $32.18
- 100 failed × 2 retries × 30% × $0.00325 = $0.195 retry waste (without pattern)
- Additional timeout costs: 100 failed requests × ~$0.0143 wasted timeout overhead ≈ $1.43
- Total retry waste avoided: **$1.63/day**

## Cost Projection (Claude Sonnet pricing)

Per-request cost: (500 × $3.00 / 1M) + (200 × $15.00 / 1M) = $0.0015 + $0.003 = **$0.0045/request**

| Scale        | Without Pattern | With Pattern | Savings    |
| ------------ | --------------- | ------------ | ---------- |
| 1K req/day   | $4.68/day       | $4.46/day    | $0.23/day  |
| 10K req/day  | $46.80/day      | $44.55/day   | $2.25/day  |
| 100K req/day | $468.00/day     | $445.50/day  | $22.50/day |

## Cost Projection (GPT-4o-mini pricing)

Per-request cost: (500 × $0.15 / 1M) + (200 × $0.60 / 1M) = $0.000075 + $0.00012 = **$0.000195/request**

| Scale        | Without Pattern | With Pattern | Savings    |
| ------------ | --------------- | ------------ | ---------- |
| 1K req/day   | $0.20/day       | $0.19/day    | $0.01/day  |
| 10K req/day  | $2.03/day       | $1.93/day    | $0.10/day  |
| 100K req/day | $20.28/day      | $19.31/day   | $0.98/day  |

## How to Calculate for Your Own Usage

1. Determine your average input/output tokens per request
2. Calculate per-request cost: `(input_tok × input_price / 1M) + (output_tok × output_price / 1M)`
3. Estimate your provider failure rate (check your provider's status page history)
4. Estimate retries per failure (check your current retry configuration)
5. Retry waste per failure: `retries × 0.3 × per_request_cost + timeout_overhead`
6. Daily savings: `daily_requests × failure_rate × retry_waste_per_failure`

## Key Insights

- **The cost savings from graceful degradation are modest in dollar terms.** At 10K req/day with GPT-4o, the pattern saves ~$1.63/day ($49/month). This isn't the reason to adopt it.

- **The real ROI isn't measured in tokens — it's measured in availability.** Without the pattern, 1% of requests return errors. With it, those requests return degraded-but-useful responses. The business value of that availability improvement dwarfs the token savings.

- **During major outages, the savings spike.** If a provider is down for 4 hours (like OpenAI's Dec 2024 incident), ~17% of daily requests would fail. At 100K req/day with GPT-4o, that's ~$55 in wasted retry costs — plus the incalculable cost of 17,000 users seeing errors.

- **Cheaper models make the dollar savings smaller, but the pattern more important.** With GPT-4o-mini, the token cost savings are negligible ($0.10/day at 10K). But the availability improvement is identical — and availability matters more when margins are thin.

- **Infrastructure cost is negligible.** The pattern adds in-memory state tracking and a cache. At 100K req/day, the memory footprint is <50MB. No additional infrastructure services required.

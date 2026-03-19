# Cost Analysis — Context Management

## Summary

Context management reduces input token costs by trimming conversation history to what's relevant. The savings are a direct function of how much history the naive approach carries vs. what the managed approach keeps.

The two key parameters that determine savings: average session length (turns) and average tokens per turn. In a 10-turn conversation where each turn adds ~5K tokens of accumulated context, the raw (unmanaged) context at turn 10 is 50K tokens. With a sliding-window strategy keeping the last 10K tokens of history, you're sending 10K instead of 50K — an 80% input token reduction.

---

## Baseline Assumptions

| Parameter | Value | Rationale |
| --- | --- | --- |
| Model | Claude Sonnet | $3.00/1M input, $15.00/1M output |
| Average session length | 10 turns | Typical for production chat and agent systems |
| Average tokens per turn (in+out) | 500 input / 250 output | Realistic for focused conversations |
| Naive context at turn 10 | ~50,000 tokens | All previous turns accumulated |
| Managed context (sliding-window) | ~22,500 tokens | Last ~9 turns within 20K budget |
| Context reduction | ~55% | (50K − 22.5K) / 50K |
| Output tokens (unchanged) | 250 per turn | Management doesn't affect output |

_These numbers represent a steady-state "midpoint" — early in a session, savings are minimal; late in a long session, savings grow. The 55% reduction is the average across the full session._

---

## Tier 2 Cost Projections (Claude Sonnet Pricing)

### Without Context Management (naive — accumulate all history)

Input cost per request at turn 10: `50,000 tokens × $3.00/1M = $0.150`
Output cost per request: `250 tokens × $15.00/1M = $0.00375`
Total per request: `~$0.154`

| Scale | Input Cost/day | Output Cost/day | Total/day |
| --- | --- | --- | --- |
| 1K req/day | $150.00 | $3.75 | $153.75 |
| 10K req/day | $1,500.00 | $37.50 | $1,537.50 |
| 100K req/day | $15,000.00 | $375.00 | $15,375.00 |

### With Context Management (sliding-window, 20K token budget)

Input cost per request: `22,500 tokens × $3.00/1M = $0.0675`
Output cost per request: `250 tokens × $15.00/1M = $0.00375`
Total per request: `~$0.071`

| Scale | Input Cost/day | Output Cost/day | Total/day |
| --- | --- | --- | --- |
| 1K req/day | $67.50 | $3.75 | $71.25 |
| 10K req/day | $675.00 | $37.50 | $712.50 |
| 100K req/day | $6,750.00 | $375.00 | $7,125.00 |

### Savings Summary

| Scale | Without Pattern | With Pattern | Daily Savings | Monthly Savings |
| --- | --- | --- | --- | --- |
| 1K req/day | $153.75/day | $71.25/day | $82.50/day | ~$2,475/month |
| 10K req/day | $1,537.50/day | $712.50/day | $825.00/day | ~$24,750/month |
| 100K req/day | $15,375.00/day | $7,125.00/day | $8,250.00/day | ~$247,500/month |

_~54% input token reduction translates to ~46% total cost reduction (output tokens are unchanged)._

---

## GPT-4o Equivalent

For teams on GPT-4o (`$2.50/1M input`, `$10.00/1M output`):

| Scale | Without Pattern | With Pattern | Daily Savings |
| --- | --- | --- | --- |
| 1K req/day | $127.50/day | $59.00/day | $68.50/day |
| 10K req/day | $1,275.00/day | $590.00/day | $685.00/day |
| 100K req/day | $12,750.00/day | $5,900.00/day | $6,850.00/day |

---

## Formula

```
naive_input_per_request = avg_context_tokens_at_midpoint × input_price_per_token
managed_input_per_request = managed_context_tokens × input_price_per_token
output_per_request = avg_output_tokens × output_price_per_token

daily_cost_naive = (naive_input_per_request + output_per_request) × requests_per_day
daily_cost_managed = (managed_input_per_request + output_per_request) × requests_per_day
daily_savings = daily_cost_naive - daily_cost_managed
```

### Plugging in your own numbers

1. **Measure your actual context window usage**: Log `context.totalTokens` from `ContextWindow` output. Use p50 as the "managed" baseline.
2. **Estimate naive context**: What would context look like without management? Sum up full conversation history per turn.
3. **Calculate your reduction ratio**: `(naive - managed) / naive`
4. **Apply to your model's pricing**: Multiply input token savings by your model's input token price.

The pattern overhead (cost of calling `build()` itself) is negligible — sub-millisecond at realistic history depths — so it doesn't meaningfully affect the ROI calculation.

---

## Sensitivity

| Variable | Effect on Savings |
| --- | --- |
| Session length (more turns) | Higher savings — more history accumulated without management |
| Tokens per turn (larger messages) | Higher savings — raw context grows faster |
| `reserveForOutput` size | Smaller reserve = more room for messages = fewer dropped messages |
| Strategy choice | Sliding-window and priority have similar savings; summarize can recover slightly more context value but doesn't change token savings significantly |

At very short sessions (1–3 turns), naive and managed contexts are nearly identical — savings are minimal until the conversation accumulates enough history to require trimming.

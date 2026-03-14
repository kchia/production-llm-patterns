# Cost Analysis: Agent Loop Guards

## How This Pattern Affects Costs

Agent Loop Guards don't add LLM calls — they _prevent_ wasted ones. The pattern's cost impact is a **savings** by detecting and halting runaway loops before they exhaust the token budget.

The key question: _How much does a runaway agent loop cost, and how quickly does the guard pay for itself?_

## Assumptions

| Assumption | Value | Justification |
|---|---|---|
| Average input tokens per agent turn | 2,000 | System prompt (~500 tokens) + conversation context (~1,000) + tool definitions (~500) |
| Average output tokens per agent turn | 500 | Tool call JSON + reasoning text |
| Average turns per successful session | 5 | Typical tool-calling agent task (research → process → summarize) |
| Loop rate without guards | 2% | Conservative estimate from production reports (ZenML reports higher in multi-agent systems) |
| Average turns in a loop before manual detection | 50 | Without automated detection, loops run until rate limits or manual kill |
| Average turns saved by guard | 45 | Guard halts at ~5 turns into a detected loop vs. 50 without |
| Guard compute overhead | ~$0.00 | Sub-millisecond per turn; negligible vs. LLM call cost |

## Baseline Model Pricing

| Model | Input | Output |
|---|---|---|
| GPT-4o | $2.50 / 1M tok | $10.00 / 1M tok |
| Claude Sonnet 4 | $3.00 / 1M tok | $15.00 / 1M tok |
| GPT-4o-mini | $0.15 / 1M tok | $0.60 / 1M tok |

## Formulas

```
Cost per turn = (input_tokens × input_price) + (output_tokens × output_price)

Cost per loop (without guard) = cost_per_turn × avg_loop_turns
Cost per loop (with guard) = cost_per_turn × guard_detection_turns

Wasted cost per loop = cost_per_turn × (avg_loop_turns - guard_detection_turns)

Daily savings = requests_per_day × loop_rate × wasted_cost_per_loop

Daily guard cost = ~$0 (compute overhead is sub-millisecond)

Net daily savings = daily_savings - daily_guard_cost ≈ daily_savings
```

### Per-turn cost by model

```
GPT-4o:      (2,000 × $2.50/1M) + (500 × $10.00/1M) = $0.005 + $0.005 = $0.01/turn
Claude Sonnet: (2,000 × $3.00/1M) + (500 × $15.00/1M) = $0.006 + $0.0075 = $0.0135/turn
GPT-4o-mini: (2,000 × $0.15/1M) + (500 × $0.60/1M) = $0.0003 + $0.0003 = $0.0006/turn
```

### Per-loop waste by model

```
GPT-4o:      45 wasted turns × $0.01 = $0.45/loop
Claude Sonnet: 45 wasted turns × $0.0135 = $0.6075/loop
GPT-4o-mini: 45 wasted turns × $0.0006 = $0.027/loop
```

## Cost Projections — GPT-4o

| Scale | Loops/Day (2%) | Daily Waste (No Guard) | Daily Waste (With Guard) | Daily Savings | Monthly Savings |
|---|---|---|---|---|---|
| 1K req/day | 20 | $9.00 | $1.00 | $8.00 | $240 |
| 10K req/day | 200 | $90.00 | $10.00 | $80.00 | $2,400 |
| 100K req/day | 2,000 | $900.00 | $100.00 | $800.00 | $24,000 |

## Cost Projections — Claude Sonnet 4

| Scale | Loops/Day (2%) | Daily Waste (No Guard) | Daily Waste (With Guard) | Daily Savings | Monthly Savings |
|---|---|---|---|---|---|
| 1K req/day | 20 | $12.15 | $1.35 | $10.80 | $324 |
| 10K req/day | 200 | $121.50 | $13.50 | $108.00 | $3,240 |
| 100K req/day | 2,000 | $1,215.00 | $135.00 | $1,080.00 | $32,400 |

## Cost Projections — GPT-4o-mini

| Scale | Loops/Day (2%) | Daily Waste (No Guard) | Daily Waste (With Guard) | Daily Savings | Monthly Savings |
|---|---|---|---|---|---|
| 1K req/day | 20 | $0.54 | $0.06 | $0.48 | $14.40 |
| 10K req/day | 200 | $5.40 | $0.60 | $4.80 | $144 |
| 100K req/day | 2,000 | $54.00 | $6.00 | $48.00 | $1,440 |

## How to Calculate for Your Own Usage

1. **Estimate your per-turn cost:** Multiply your average input tokens by your model's input price, plus average output tokens by output price.
2. **Estimate your loop rate:** Start with 2% if you don't have data. If you've observed loops in production, use your actual rate. Multi-agent systems tend to have higher rates (3-5%).
3. **Estimate turns per undetected loop:** Without guards, how long does a loop run before someone notices? For background agents, this could be 100+ turns. For user-facing agents with timeouts, maybe 20-30.
4. **Estimate guard detection point:** With `maxRepeatedCalls=3`, the guard catches simple loops in 3-5 turns. Cycle detection (`convergenceWindow=5`) catches more complex patterns in 10-15 turns.
5. **Plug into the formula:**
   ```
   Monthly savings = 30 × requests_per_day × loop_rate ×
     per_turn_cost × (undetected_turns - detected_turns)
   ```

## Key Insights

- **The pattern is pure savings** — it doesn't add API calls, only prevents wasted ones. Implementation cost is a few hours of engineering time.
- **Break-even is immediate** at any scale with GPT-4o or Claude Sonnet. Even at 1K req/day, a single prevented loop per day saves more than the engineering investment within the first week.
- **GPT-4o-mini makes loops cheap but not free.** At $0.027/loop, the waste is tolerable at small scale. But at 100K req/day, it's still $1,440/month — and that assumes only 2% loop rate with 50-turn loops. Multi-agent systems with higher loop rates can see much larger waste.
- **The real cost isn't just tokens.** Loops also consume rate limit capacity, block user requests, and can trigger side effects (duplicate tool executions). The token savings are the measurable part; the operational savings are harder to quantify but often larger.
- **Higher loop rates dramatically change the math.** At 5% loop rate (common in complex multi-agent systems), multiply all savings by 2.5x. The ZenML incident ($47,000 in 4 weeks) illustrates what happens at scale without guards.

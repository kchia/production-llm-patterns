# Cost Analysis: Token Budget Middleware

## Assumptions

| Parameter                         | Value                            | Justification                                                      |
| --------------------------------- | -------------------------------- | ------------------------------------------------------------------ |
| Average input tokens per request  | 500                              | Typical for a prompt with system message + user query              |
| Average output tokens per request | 300                              | Mid-range completion (a few paragraphs)                            |
| Middleware compute overhead       | $0                               | Sub-microsecond per request, negligible vs. API costs              |
| Runaway incident frequency        | 1 per month (without middleware) | Conservative — teams with retry logic or agent loops see more      |
| Average runaway incident cost     | $500                             | A stuck loop running for 2-6 hours before detection                |
| Budget enforcement savings        | Prevents 95% of runaway spend    | Middleware catches budget overshoot before it reaches the provider |

These assumptions model a system where token budget middleware adds zero meaningful cost (pure application-layer logic with no external dependencies) but prevents runaway incidents that would otherwise go unchecked.

## Model Pricing (verified February 2026)

| Model             | Input             | Output             |
| ----------------- | ----------------- | ------------------ |
| GPT-4o            | $2.50 / 1M tokens | $10.00 / 1M tokens |
| Claude Sonnet 4.5 | $3.00 / 1M tokens | $15.00 / 1M tokens |
| GPT-4o-mini       | $0.15 / 1M tokens | $0.60 / 1M tokens  |

## Formulas

```
Base daily cost = (requests/day) × (avg_input_tokens × input_price + avg_output_tokens × output_price)

Middleware daily cost = ~$0 (pure in-process logic, no external calls)

Monthly runaway cost (without middleware) = incident_frequency × avg_incident_cost
Monthly runaway savings (with middleware) = runaway_cost × 0.95

Net monthly savings = runaway_savings - middleware_cost
Net daily savings = Net monthly savings / 30
```

## Cost Projections

### GPT-4o

| Scale        | Base Daily Cost | Monthly Runaway Risk | Middleware Savings | Net ROI        |
| ------------ | --------------- | -------------------- | ------------------ | -------------- |
| 1K req/day   | $4.25           | $500/mo ($16.67/day) | -$15.83/day        | Saves ~$475/mo |
| 10K req/day  | $42.50          | $500/mo ($16.67/day) | -$15.83/day        | Saves ~$475/mo |
| 100K req/day | $425.00         | $500/mo ($16.67/day) | -$15.83/day        | Saves ~$475/mo |

At higher scales, runaway incidents are more frequent and more expensive (higher request volume = more tokens burned per hour of stuck loop). At 100K req/day, a single runaway hour could cost $425 × (60/24) = ~$1,063 per hour of uncapped spend.

**Scale-adjusted estimate at 100K req/day:** 2 incidents/month × $2,000 avg = $4,000/month in runaway risk. Middleware saves ~$3,800/month.

### Claude Sonnet 4.5

| Scale        | Base Daily Cost | Monthly Runaway Risk    | Middleware Savings | Net ROI          |
| ------------ | --------------- | ----------------------- | ------------------ | ---------------- |
| 1K req/day   | $6.00           | $700/mo                 | -$665/day savings  | Saves ~$665/mo   |
| 10K req/day  | $60.00          | $700/mo                 | -$665/day savings  | Saves ~$665/mo   |
| 100K req/day | $600.00         | $5,600/mo (2 incidents) | -$5,320/mo savings | Saves ~$5,320/mo |

Claude's higher output pricing ($15/1M vs. $10/1M) means runaway incidents are ~40% more expensive per token, making budget enforcement proportionally more valuable.

### GPT-4o-mini

| Scale        | Base Daily Cost | Monthly Runaway Risk  | Middleware Savings  | Net ROI           |
| ------------ | --------------- | --------------------- | ------------------- | ----------------- |
| 1K req/day   | $0.26           | $30/mo                | -$28.50/mo savings  | Saves ~$28.50/mo  |
| 10K req/day  | $2.55           | $30/mo                | -$28.50/mo savings  | Saves ~$28.50/mo  |
| 100K req/day | $25.50          | $250/mo (2 incidents) | -$237.50/mo savings | Saves ~$237.50/mo |

With GPT-4o-mini's low per-token pricing, runaway incidents cost less in absolute terms. Budget middleware is still net-positive but the urgency is lower — the break-even threshold is roughly $30/month in prevented incidents.

## How to Calculate for Your Own Usage

1. **Find your average request size**: Check your provider dashboard for average input and output tokens per request. If unavailable, estimate: system prompt tokens + user prompt tokens for input, expected response length for output.

2. **Calculate your base daily cost**:

   ```
   daily_cost = (requests_per_day) × (input_tokens × price_per_input_token + output_tokens × price_per_output_token)
   ```

3. **Estimate your runaway risk**:
   - Do your systems use retry logic? (Higher risk)
   - Do you run agent loops? (Much higher risk)
   - Do batch jobs run unattended? (Higher risk)
   - How quickly would someone notice a stuck loop? (Detection time × hourly burn rate = incident cost)

4. **Calculate incident cost**:

   ```
   incident_cost = (requests_per_hour_during_incident × cost_per_request) × hours_until_detected
   ```

5. **Compare**: If `12 × incident_cost > engineering_cost_to_implement`, the middleware pays for itself in the first year.

## Key Insights

- **The pattern's value is asymmetric.** The middleware costs effectively nothing to run (in-process logic, no external dependencies). Its value comes entirely from preventing tail-risk events — runaway incidents that are rare but expensive.
- **Model pricing is the multiplier.** At GPT-4o pricing ($10/1M output), a 6-hour runaway loop at 10K req/day could cost $1,062. At GPT-4o-mini ($0.60/1M output), the same incident costs ~$64. Budget middleware is most urgent with expensive models.
- **Agent and batch systems have the highest ROI.** These systems chain multiple LLM calls per task and can run without human supervision for hours. A stuck agent loop or a batch job processing malformed input can generate thousands of unnecessary API calls.
- **Break-even is almost immediate.** Since the middleware has zero marginal cost, any prevented incident — even a $50 one — makes it net positive. The question isn't "is it worth it?" but "can I afford to not have it?"

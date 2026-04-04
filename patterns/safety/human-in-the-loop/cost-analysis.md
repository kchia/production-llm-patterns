# Cost Analysis: Human-in-the-Loop

> Updated pricing as of April 2026. Note: Prices updated from PLAYBOOK baseline.
> - GPT-4o: $2.50/1M input, $10.00/1M output (was $2.50/$10.00 — no change)
> - Claude Sonnet: $3.00/1M input, $15.00/1M output (was $3.00/$15.00 — no change)
> - GPT-4o-mini: $0.15/1M input, $0.60/1M output (unchanged)

## Cost Model Summary

Human-in-the-Loop is unusual among patterns in this repo: **it adds near-zero LLM token costs**. The risk classifier is rule-based (confidence score + four risk dimensions), requiring no additional LLM calls. The cost profile is dominated by two factors:

1. **Infrastructure:** Durable state store (Redis or PostgreSQL) for checkpoint persistence — typically $30–50/month flat
2. **Reviewer labor:** Human review time × escalation rate × reviewer hourly cost

The ROI case is about avoided incident costs, not token savings.

## Assumptions

| Parameter | Value | Rationale |
|---|---|---|
| Avg input tokens/request | 800 | Typical agent request with context and action payload |
| Avg output tokens/request | 300 | Agent response with reasoning trace |
| Escalation rate | 15% | Sustainable target per production guidance; above this, reviewers rubber-stamp |
| Auto-approve rate | 30% | Default threshold 0.85 with confidence ~ N(0.78, 0.12) — see benchmark results |
| Team-review rate | 55% | Remaining after auto-approve and escalation |
| Pattern token overhead | 0% | Rule-based classifier adds no tokens |
| State store monthly cost | $40 | Redis managed instance or small PostgreSQL |
| Reviewer time per item | 3 min | Conservative estimate for a team-review item |
| Reviewer hourly cost | $75 | Mid-level engineer or dedicated reviewer |
| Avg incident cost avoided | $5,000 | Conservative; EY Global survey: avg AI failure costs $4.4M/company/year |

## Formulas

```
Base agent cost (LLM only) =
  requests/day × (avg_input × input_price + avg_output × output_price) / 1,000,000

Pattern LLM cost = Base agent cost × 1.0  (no multiplier — zero token overhead)

Pattern infrastructure cost = $40/month = $1.33/day (flat, scale-independent)

Reviewer labor cost/day =
  requests/day × team_review_rate × (review_time_min / 60) × hourly_rate
  + requests/day × escalation_rate × (review_time_min / 60 × 2) × hourly_rate
  (escalation items take 2× longer)

Total additional cost/day = infrastructure/day + reviewer_labor/day

Monthly incident rate avoided (estimate) =
  requests/day × escalation_rate × error_rate_without_HITL × business_days
  (this is what you're buying)
```

## Cost Projections: LLM Costs (Token-only)

Since the pattern adds no tokens, LLM cost impact is $0.00 across all scales and models. Shown for completeness.

| Scale | GPT-4o additional | Claude Sonnet additional | GPT-4o-mini additional |
|---|---|---|---|
| 1K req/day | $0.00/day | $0.00/day | $0.00/day |
| 10K req/day | $0.00/day | $0.00/day | $0.00/day |
| 100K req/day | $0.00/day | $0.00/day | $0.00/day |

## Total Additional Cost Projections (Infrastructure + Reviewer Labor)

Assuming 3 min/team-review item, 6 min/escalation item, $75/hr reviewer.

**At 1K requests/day:**
- Team-review items: 1,000 × 55% = 550/day × (3/60)h × $75 = $20.63/day
- Escalation items: 1,000 × 15% = 150/day × (6/60)h × $75 = $11.25/day
- Infrastructure: $1.33/day
- **Total: ~$33/day ($990/month)**

**At 10K requests/day:**
- Team-review items: 10,000 × 55% = 5,500/day × (3/60)h × $75 = $206/day
- Escalation items: 10,000 × 15% = 1,500/day × (6/60)h × $75 = $112/day
- Infrastructure: $1.33/day
- **Total: ~$319/day ($9,570/month)**

**At 100K requests/day:**
- Note: 55% team-review rate at this scale means 55,000 reviewer decisions/day — economically infeasible for most orgs. "When This Advice Stops Applying" threshold.
- Human review at this scale requires aggressive auto-approve tuning (>95% auto-approve rate), or switching to LLM-as-a-judge for intermediate review tier.
- Illustrative: if auto-approve rate raised to 90%: 10,000 review items/day
- Team-review items: 100,000 × 7% = 7,000/day × (3/60) × $75 = $262/day
- Escalation items: 100,000 × 3% = 3,000/day × (6/60) × $75 = $225/day
- Infrastructure: $1.33/day
- **Total (tuned): ~$488/day ($14,640/month)**

## Cost Summary Table (GPT-4o, tuned thresholds at 100K)

| Scale | Additional Cost | ROI vs. No Pattern |
| ------------ | --------------- | ------------------ |
| 1K req/day | +$33/day (+$990/mo) | Break-even at 1 prevented incident every 5 months ($5K avg incident cost) |
| 10K req/day | +$319/day (+$9,570/mo) | Break-even at ~2 prevented incidents/month; ROI if error rate >0.3% on agent actions |
| 100K req/day | +$488/day (+$14,640/mo) | Requires raising auto-approve threshold to ≥90%; ROI if error rate >0.01% on consequential actions |

## How to Calculate for Your Own Usage

**Step 1: Set your escalation rate.**
Start at 15% if unknown. Check benchmark results for your confidence distribution — if auto-approve rate is 30%, that means 70% of items need review, which is likely too high for any team.

**Step 2: Calculate daily review volume.**
`Review items/day = requests/day × (1 - auto_approve_rate)`
At 10K req/day with 70% auto-approve: 3,000 items/day. Is your team resourced for 3,000 decisions/day?

**Step 3: Compute reviewer labor cost.**
`Labor/day = review_items/day × avg_review_minutes/60 × reviewer_hourly_rate`

**Step 4: Estimate your avoided incident cost.**
Look at your last 3 months of agent incidents. What did the average incident cost (engineering time, customer impact, refunds, SLA penalties)? Multiply by the expected reduction rate (typically 60–80% of escalation-tier incidents are caught).

**Step 5: Compare.**
If `avoided_incident_value/month > reviewer_labor/month + infrastructure/month`, the pattern pays for itself.

## Key Insights

- **Reviewer cost, not token cost, is the variable.** At 10K req/day with 30% auto-approve, you need a team capacity of ~3,000 review decisions/day. The math only works if you have a dedicated review function, or if you aggressively calibrate thresholds to push auto-approve above 85%.
- **Auto-approve rate is the primary cost lever.** Moving from 30% to 70% auto-approve at 10K req/day reduces reviewer labor from $319/day to $96/day. Calibration investment pays off directly in reviewer cost reduction.
- **LLM model choice doesn't affect this pattern's cost.** The pattern adds zero tokens. Your model selection decision should be based on the agent's core task requirements, not HITL overhead.
- **At 100K req/day, this pattern requires architectural changes.** Pure human review at this scale needs LLM-as-a-judge as an intermediate tier, with humans only on escalation tier (3–5% of volume). That changes the cost model significantly.
- **Infrastructure cost is negligible.** $40/month state store is noise relative to reviewer labor at any meaningful scale.

# Cost Analysis: State Checkpointing

State Checkpointing is a **cost-saving** pattern. Its primary impact on API costs is reduction: when a workflow resumes from a checkpoint, completed steps don't re-run, avoiding their token costs. The pattern does add a small infrastructure overhead (checkpoint store), but this is typically negligible compared to LLM token costs.

---

## Assumptions

| Parameter | Value | Justification |
|-----------|-------|---------------|
| Average steps per workflow | 8 | Typical agent workflow; shorter single-step flows don't need checkpointing |
| Average input tokens per step | 1,500 | System prompt + conversation history + task context |
| Average output tokens per step | 300 | Tool call or reasoning output |
| Tokens per request (total) | 14,400 input + 2,400 output | 8 steps × (1,500 input + 300 output) |
| Workflow failure rate | 10% | Conservative estimate for multi-step workflows with provider dependencies |
| Average step at failure | Step 5 of 8 | Uniform distribution; on average, failed workflows wasted 4 steps before checkpointing |
| Restart-from-scratch cost multiplier (no checkpointing) | 1.0625× | Failures re-run avg 4/8 = 50% of steps on retry; 10% failure rate × 50% wasted steps = 5% extra cost |
| Resume-from-checkpoint cost multiplier | 1.00× | Checkpointed workflows resume without re-running completed steps; negligible overhead |
| Checkpoint store cost | $5/month flat | Redis or PostgreSQL at moderate scale; amortized across all workflows |

---

## Pricing (as of 2025-Q1)

| Model | Input | Output |
|-------|-------|--------|
| GPT-4o | $2.50 / 1M tokens | $10.00 / 1M tokens |
| Claude Sonnet | $3.00 / 1M tokens | $15.00 / 1M tokens |
| GPT-4o-mini | $0.15 / 1M tokens | $0.60 / 1M tokens |

---

## Cost Formulas

```
# Base cost per workflow (tokens only)
base_cost = (avg_input_tokens × input_price) + (avg_output_tokens × output_price)

# Without checkpointing: failures cause partial re-runs
no_checkpoint_cost = base_cost × (1 + failure_rate × avg_wasted_fraction)
  = base_cost × (1 + 0.10 × 0.50)
  = base_cost × 1.05

# With checkpointing: failures resume without re-running completed steps
with_checkpoint_cost = base_cost × 1.00  (no wasted re-runs)
  + store_cost_per_workflow               (tiny infrastructure overhead)

# Daily cost
daily_no_checkpoint = requests_per_day × no_checkpoint_cost
daily_with_checkpoint = requests_per_day × base_cost + (store_cost / 30)

# Daily savings
savings_per_day = daily_no_checkpoint - daily_with_checkpoint
```

**Per-workflow costs (GPT-4o):**
```
base_cost = (14,400 × $2.50/1M) + (2,400 × $10.00/1M)
          = $0.036 + $0.024
          = $0.060

without_checkpoint = $0.060 × 1.05 = $0.0630
with_checkpoint    = $0.060 × 1.00 = $0.0600 + ~$0.000003 (store overhead)

savings_per_workflow = $0.0030 (5% reduction)
```

---

## Projections: GPT-4o

| Scale | Daily Cost (No Checkpoint) | Daily Cost (With Checkpoint) | Daily Savings | Monthly Savings |
|-------|--------------------------|------------------------------|---------------|-----------------|
| 1K req/day | $63.00 | $60.17 | $2.83 | ~$85 |
| 10K req/day | $630.00 | $601.67 | $28.33 | ~$850 |
| 100K req/day | $6,300.00 | $6,016.67 | $283.33 | ~$8,500 |

_Store cost: $5/month flat, amortized as $0.17/day._

---

## Projections: Claude Sonnet

| Scale | Daily Cost (No Checkpoint) | Daily Cost (With Checkpoint) | Daily Savings | Monthly Savings |
|-------|--------------------------|------------------------------|---------------|-----------------|
| 1K req/day | $79.80 | $75.97 | $3.83 | ~$115 |
| 10K req/day | $798.00 | $759.67 | $38.33 | ~$1,150 |
| 100K req/day | $7,980.00 | $7,596.67 | $383.33 | ~$11,500 |

_Per-workflow base cost: (14,400 × $3/1M) + (2,400 × $15/1M) = $0.0432 + $0.036 = $0.0792_

---

## Projections: GPT-4o-mini

| Scale | Daily Cost (No Checkpoint) | Daily Cost (With Checkpoint) | Daily Savings | Monthly Savings |
|-------|--------------------------|------------------------------|---------------|-----------------|
| 1K req/day | $3.77 | $3.59 | $0.18 | ~$5.50 |
| 10K req/day | $37.70 | $35.90 | $1.80 | ~$54 |
| 100K req/day | $377.00 | $359.17 | $17.83 | ~$535 |

_Per-workflow base cost: (14,400 × $0.15/1M) + (2,400 × $0.60/1M) = $0.00216 + $0.00144 = $0.0036_

---

## Key Insights

**The savings scale with model cost, not request volume alone.** At 10K req/day, checkpointing saves $28/day on GPT-4o but only $1.80/day on GPT-4o-mini. The store infrastructure costs roughly the same regardless of model. This means checkpointing is more ROI-positive for expensive models.

**The break-even is almost immediate.** At 1K req/day on GPT-4o, monthly savings are ~$85 vs. a $5/month Redis instance. The implementation pays for itself within the first week of operation.

**Failure rate is the key lever.** The 10% assumption is conservative. In practice, multi-step workflows hitting rate limits, provider timeouts, or process restarts will fail more. A 20% failure rate doubles the savings. A 5% rate halves them.

**The assumptions here are for a typical 8-step agent workflow.** Shorter workflows (3–4 steps) see smaller absolute savings. Longer workflows (15–20 steps) with high per-step token counts see significantly larger savings — and are exactly the use case where checkpointing matters most.

---

## How to Calculate for Your Own Usage

1. **Count your actual workflow steps.** Count the LLM calls in a typical workflow execution.
2. **Measure your token usage.** Log `input_tokens` and `output_tokens` from your provider responses for a sample of requests.
3. **Estimate your failure rate.** Check your current workflow completion rate: `completed / (completed + failed)`.
4. **Estimate average step at failure.** If you don't know, use 50% of total steps as a conservative estimate.
5. **Plug in:**
   ```
   wasted_fraction = avg_step_at_failure / total_steps   (e.g., 5/8 = 0.625)
   extra_cost_rate = failure_rate × wasted_fraction       (e.g., 0.10 × 0.625 = 0.0625)
   daily_savings = daily_requests × base_cost × extra_cost_rate
   ```
6. **Compare against store cost.** Redis on a single small instance runs $10–30/month. PostgreSQL may already be in your stack with no marginal cost. If monthly savings > store cost, checkpointing pays for itself.

# Cost Analysis: Prompt Version Registry

## How This Pattern Affects Costs

The Prompt Version Registry is a **metadata-management pattern**, not a request-processing pattern. It doesn't add extra LLM calls, tokens, or retries. Its cost impact comes from two areas:

1. **Infrastructure cost** — storing versions, serving lookups, running the registry
2. **Indirect cost avoidance** — faster incident response (less time running bad prompts), ability to rollback without redeploy (avoiding bad-prompt-running-while-pipeline-completes costs)

### Direct Cost Components

| Component | Cost Basis | Estimate |
|-----------|-----------|----------|
| Version storage | ~500 bytes per version (template + metadata + hash) | Negligible — 10K versions = ~5MB |
| Runtime resolution | ~1µs CPU per resolve (from benchmarks) | Negligible at any scale |
| Cache memory | ~200 bytes per cached entry | Negligible — 100 cached prompts = ~20KB |

The registry itself adds **effectively zero marginal cost** per request. The cost is engineering time to integrate and maintain.

### Indirect Cost Impact: Bad Prompt Duration

The real value is reducing how long a bad prompt runs in production. Without a registry, rolling back a prompt requires a code deploy (15–30 minutes for typical CI/CD). With a registry, rollback is an alias change (seconds).

**Cost of a bad prompt per minute running:**

```
bad_prompt_cost_per_min = (requests_per_min) × (avg_tokens × token_price) × waste_multiplier
```

Where `waste_multiplier` captures that bad outputs may need reprocessing, refunds, or manual correction.

## Assumptions

| Parameter | Value | Justification |
|-----------|-------|---------------|
| Average input tokens/request | 500 | Typical prompt with context injection |
| Average output tokens/request | 200 | Standard LLM response |
| Bad prompt frequency | 1 per month | Based on teams changing prompts weekly |
| Time to rollback without registry | 20 minutes | CI/CD pipeline time |
| Time to rollback with registry | 1 minute | Alias change |
| Waste multiplier for bad prompt | 1.5x | Some outputs need correction/reprocessing |
| Infrastructure cost | $0/month | In-memory for small scale; $5–20/month for database-backed at scale |

## Cost Projection Tables

### GPT-4o ($2.50/1M input, $10.00/1M output)

| Scale | Base Daily Cost | Registry Overhead | Bad Prompt Savings/Month | Net Monthly Impact |
|-------|----------------|-------------------|--------------------------|-------------------|
| 1K req/day | $3.25/day | ~$0/day | $1.03 saved | **-$1.03/month** (saves) |
| 10K req/day | $32.50/day | ~$0/day | $10.30 saved | **-$10.30/month** (saves) |
| 100K req/day | $325.00/day | ~$0/day | $103.00 saved | **-$103.00/month** (saves) |

### Claude Sonnet ($3.00/1M input, $15.00/1M output)

| Scale | Base Daily Cost | Registry Overhead | Bad Prompt Savings/Month | Net Monthly Impact |
|-------|----------------|-------------------|--------------------------|-------------------|
| 1K req/day | $4.50/day | ~$0/day | $1.43 saved | **-$1.43/month** (saves) |
| 10K req/day | $45.00/day | ~$0/day | $14.25 saved | **-$14.25/month** (saves) |
| 100K req/day | $450.00/day | ~$0/day | $142.50 saved | **-$142.50/month** (saves) |

### GPT-4o-mini ($0.15/1M input, $0.60/1M output)

| Scale | Base Daily Cost | Registry Overhead | Bad Prompt Savings/Month | Net Monthly Impact |
|-------|----------------|-------------------|--------------------------|-------------------|
| 1K req/day | $0.20/day | ~$0/day | $0.06 saved | **-$0.06/month** (saves) |
| 10K req/day | $1.95/day | ~$0/day | $0.62 saved | **-$0.62/month** (saves) |
| 100K req/day | $19.50/day | ~$0/day | $6.19 saved | **-$6.19/month** (saves) |

## Formulas

### Base daily cost

```
base_daily = requests_per_day × (500 × input_price/1M + 200 × output_price/1M)
```

### Bad prompt waste (per incident)

```
waste_minutes = rollback_time_without_registry - rollback_time_with_registry
              = 20 - 1 = 19 minutes

requests_during_waste = (requests_per_day / 1440) × waste_minutes

waste_cost = requests_during_waste × (500 × input_price/1M + 200 × output_price/1M) × 0.5
```

The `× 0.5` factor: not all requests during a bad prompt produce completely wasted output. Some are partially useful, some are fully wasted. 50% waste rate is conservative.

### Monthly savings

```
monthly_savings = waste_cost_per_incident × incidents_per_month
               = waste_cost × 1
```

## How to Calculate for Your Own Usage

1. **Find your base daily cost:** `requests/day × (avg_input_tokens × your_input_price/1M + avg_output_tokens × your_output_price/1M)`
2. **Estimate your rollback time without a registry:** How long does your CI/CD pipeline take? That's your exposure window.
3. **Estimate bad prompt frequency:** How often do prompt changes cause quality regressions? Even 1/quarter makes the math work at scale.
4. **Calculate waste:** `(requests_per_minute × rollback_time_saved_in_minutes) × cost_per_request × waste_fraction`
5. **Add infrastructure cost:** $0 for in-memory, $5–20/month for database-backed, $50–200/month for managed platforms (PromptLayer, Braintrust)

## Key Insights

- **The registry has near-zero direct cost.** It doesn't add tokens, API calls, or significant compute. The cost story is entirely about incident response speed.
- **Value scales linearly with request volume.** At 100K req/day with GPT-4o, saving 19 minutes of bad-prompt exposure saves ~$103/month — more than enough to justify even a managed platform.
- **The real value isn't in the dollar savings — it's in the debugging capability.** Being able to answer "which prompt was running at 3:47 PM?" is worth more than the cost savings, but it's harder to quantify.
- **Cheaper models reduce the cost argument but not the operational argument.** With GPT-4o-mini, monthly savings are small ($0.06–$6.19), but the inability to debug or rollback is equally painful regardless of token price.
- **Break-even is immediate** — the pattern costs nothing to run and saves on the first incident.

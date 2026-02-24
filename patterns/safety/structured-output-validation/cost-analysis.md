# Cost Analysis: Structured Output Validation

## Assumptions

| Parameter                                   | Value             | Justification                                                                                                                                            |
| ------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Average input tokens/request                | 800               | Typical structured output prompt: system instructions (~300 tokens) + user query (~200 tokens) + schema instructions (~300 tokens appended by validator) |
| Average output tokens/request               | 200               | Structured JSON response — most structured outputs are compact (10-50 fields)                                                                            |
| Schema instruction overhead                 | ~300 tokens input | The `toPromptInstructions()` output adds ~300 tokens describing the expected JSON schema                                                                 |
| Baseline failure rate (no validation)       | 10%               | Conservative estimate based on research: 7-60% for complex schemas, ~1% for simple schemas with provider JSON mode                                       |
| Retry success rate                          | 70%               | With specific error feedback, most retries succeed. Research shows error-guided retries significantly outperform blind retries                           |
| Average retries per failed request          | 1.3               | 70% succeed on first retry (1 retry), 30% of remaining succeed on second retry (2 retries), rest exhausted                                               |
| Requests needing repair (no extra API call) | 3%                | Subset of failures where JSON repair fixes the issue without retrying                                                                                    |

### Pattern Cost Mechanics

The validation pattern affects costs through two mechanisms:

1. **Added input tokens:** Schema instructions appended to every prompt (~300 tokens/request)
2. **Retry API calls:** Failed validations trigger retries with error feedback. Each retry is a full API call with slightly more input tokens (original prompt + error feedback, ~200 extra tokens)

The pattern does NOT add output tokens to successful requests — it only validates what the model already returns.

### Formulas

```
Base cost per request = (input_tokens × input_price) + (output_tokens × output_price)

Schema overhead per request = schema_tokens × input_price
  = 300 × input_price

Retry cost per retry = ((input_tokens + schema_tokens + feedback_tokens) × input_price) + (output_tokens × output_price)
  = ((800 + 300 + 200) × input_price) + (200 × output_price)

Expected retries per request = failure_rate × (1 - repair_rate) × avg_retries_per_failure
  = 0.10 × 0.97 × 1.3 = 0.126 retries/request

Daily pattern cost = (requests/day × schema_overhead) + (requests/day × expected_retries × retry_cost)

Daily cost WITHOUT pattern = requests/day × base_cost
  (but failures produce unusable output — the "cost" is wasted base calls)

Wasted calls without pattern = requests/day × failure_rate × base_cost
```

## Cost Projections: GPT-4o ($2.50/1M input, $10.00/1M output)

|                                   | Without Pattern | With Pattern  | Difference  | Notes                                           |
| --------------------------------- | --------------- | ------------- | ----------- | ----------------------------------------------- |
| **Base cost/request**             | $0.0040         | $0.0040       | —           | 800 input + 200 output tokens                   |
| **Schema overhead/request**       | —               | $0.00075      | +$0.00075   | 300 extra input tokens                          |
| **Retry cost/retry**              | —               | $0.0053       | —           | 1300 input + 200 output tokens                  |
| **Expected retry cost/request**   | —               | $0.00066      | +$0.00066   | 0.126 retries × $0.0053                         |
| **Effective cost/request**        | $0.0040         | $0.00441      | +$0.00041   | +10.3% per request                              |
| **Wasted cost (unusable output)** | 10% of base     | ~0.3% of base | -9.7% saved | Repair + retry recovers most failures           |
|                                   |                 |               |             |                                                 |
| **1K req/day**                    | $4.00           | $4.41         | +$0.41/day  | Net positive: saves ~$0.39/day in wasted calls  |
| **10K req/day**                   | $40.00          | $44.10        | +$4.10/day  | Net positive: saves ~$3.88/day in wasted calls  |
| **100K req/day**                  | $400.00         | $441.00       | +$41.00/day | Net positive: saves ~$38.80/day in wasted calls |

**Break-even:** The pattern costs +10.3% per request but eliminates ~9.7% of wasted calls. Net additional cost is ~0.6% — effectively cost-neutral. The ROI is in reliability, not cost savings.

## Cost Projections: Claude Sonnet ($3.00/1M input, $15.00/1M output)

| Scale                       | Without Pattern | With Pattern | Difference         |
| --------------------------- | --------------- | ------------ | ------------------ |
| Base cost/request           | $0.0054         | $0.0054      | —                  |
| Schema overhead/request     | —               | $0.00090     | +$0.00090          |
| Retry cost/retry            | —               | $0.0069      | —                  |
| Expected retry cost/request | —               | $0.00087     | +$0.00087          |
| Effective cost/request      | $0.0054         | $0.00617     | +$0.00077 (+14.3%) |
|                             |                 |              |                    |
| 1K req/day                  | $5.40           | $6.17        | +$0.77/day         |
| 10K req/day                 | $54.00          | $61.70       | +$7.70/day         |
| 100K req/day                | $540.00         | $617.00      | +$77.00/day        |

**Note:** Higher output pricing ($15/1M) makes retries more expensive. Net cost after accounting for eliminated wasted calls: +4.0%.

## Cost Projections: GPT-4o-mini ($0.15/1M input, $0.60/1M output)

| Scale                       | Without Pattern | With Pattern | Difference          |
| --------------------------- | --------------- | ------------ | ------------------- |
| Base cost/request           | $0.00024        | $0.00024     | —                   |
| Schema overhead/request     | —               | $0.000045    | +$0.000045          |
| Retry cost/retry            | —               | $0.00032     | —                   |
| Expected retry cost/request | —               | $0.000040    | +$0.000040          |
| Effective cost/request      | $0.00024        | $0.000325    | +$0.000085 (+35.4%) |
|                             |                 |              |                     |
| 1K req/day                  | $0.24           | $0.33        | +$0.09/day          |
| 10K req/day                 | $2.40           | $3.25        | +$0.85/day          |
| 100K req/day                | $24.00          | $32.50       | +$8.50/day          |

**Note:** The percentage overhead is highest for mini models because the schema instruction tokens (fixed cost) are a larger proportion of the already-cheap base cost. In absolute dollars, the cost is trivial — $8.50/day at 100K requests. Mini models also tend to have higher structured output failure rates, so the actual retry count may be higher (increasing both cost and value).

## Key Insights

1. **The pattern is effectively cost-neutral for frontier models.** At GPT-4o pricing, the +10.3% overhead is almost entirely offset by eliminating wasted calls from validation failures. The net cost is reliability, not dollars.

2. **Retries dominate the cost, not schema instructions.** Schema overhead is ~$0.75/day at 1K GPT-4o requests. Retries are ~$0.66/day. Reducing the failure rate (better prompts, simpler schemas) has more cost impact than reducing schema instruction size.

3. **Higher output pricing amplifies retry cost.** Claude Sonnet's $15/1M output pricing makes each retry ~30% more expensive than GPT-4o. For retry-heavy workloads, output token pricing matters more than input pricing.

4. **Mini models have the highest percentage overhead but lowest absolute cost.** The +35% overhead sounds alarming but amounts to $0.09/day at 1K requests. Mini models are also where validation matters most — higher baseline failure rates mean more value from the pattern.

5. **The real ROI is in preventing downstream damage, not API savings.** A malformed output that reaches a database, triggers a wrong tool call, or produces an incorrect user-facing response has costs far exceeding the API call that produced it. The pattern's value is correctness, not token economics.

## How to Calculate for Your Own Usage

1. **Measure your baseline failure rate.** Log `JSON.parse` failures for a week before implementing the pattern. This is your actual failure rate (the 10% assumption above may be higher or lower for your schema and model).

2. **Estimate your schema instruction size.** Run `schema.toPromptInstructions()` and count tokens. Use your tokenizer or estimate ~1.3 tokens per word.

3. **Plug into the formula:**

   ```
   Daily overhead = (requests/day × schema_tokens × input_price)
                  + (requests/day × failure_rate × 0.97 × 1.3 × retry_cost)

   Daily savings = requests/day × failure_rate × base_cost_per_request

   Net daily cost = Daily overhead - Daily savings
   ```

4. **Adjust retry parameters.** If your failure rate is <2%, consider `maxRetries: 1`. If >20%, consider `maxRetries: 3` — but also investigate why the rate is so high (schema complexity, model capability, prompt quality).

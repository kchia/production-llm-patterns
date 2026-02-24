# Structured Output Validation

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

LLMs return free-form text even when you ask for JSON. Without validation, malformed output propagates through the pipeline — a missing field crashes a downstream service, an extra field leaks into a database, or silently wrong values produce incorrect results nobody catches until a user reports them days later.

The failures aren't just "the JSON didn't parse." They also include— incomplete JSON from truncated messages, missing required fields, multiple JSON objects returned when one was expected. In multi-agent systems, one malformed output cascades through dependency chains, contaminating shared context and producing system-wide faults.

And the edge cases are subtle. For example, when a model hits `max_tokens` mid-generation, the response terminates mid-JSON — the `finish_reason` says `"length"` instead of `"stop"`, and your parser receives an unparseable fragment. When a model refuses an unsafe request, the refusal doesn't conform to your defined schema. When a provider silently updates a model version, output formatting can regress overnight without any code change.

## What I Would Not Do

It's tempting to wrap the LLM call in `JSON.parse()` and catching the error. If it fails, retry. This creates a compounding problem: a system needing 3 attempts on average to get parseable output triples its API costs and response times. One documented case had triple-stacked retries — application retries, library retries, and client SDK retries — all firing independently on the same failures, turning a [10-25%](https://github.com/567-labs/instructor/issues/1855) parse failure rate into a latency and cost disaster.

The second common approach is regex extraction — scan the raw text for something that looks like JSON, pull it out, and parse that. This works until the model wraps JSON in markdown code blocks (` ```json ... ``` `), a common behavior that breaks naive extraction. And regex can't tell you whether the extracted JSON actually matches the schema you expected — it just tells you the braces balanced.

The more subtle failure: trusting provider-native "JSON mode" as a complete solution. [OpenAI's Structured Outputs](https://openai.com/index/introducing-structured-outputs-in-the-api/) claims 100% schema compliance, but users report [~1% random invalid JSON](https://community.openai.com/t/invalid-json-response-when-using-structured-output/1121650) even in strict mode. And the latency cost is real — mean latency jumps from ~7 seconds (tool calling) to [~28 seconds](https://python.useinstructor.com/blog/2024/08/20/should-i-be-using-structured-outputs/) (structured outputs), with spikes up to 137 seconds. Anthropic's structured outputs have similar constraints: no recursive schemas, nesting depth limits. Provider guarantees are a strong foundation, but they're not sufficient alone. The application layer still needs to validate what it receives — truncated responses from token limits, model refusals that bypass the schema, and provider-side regressions all get past constrained decoding.

## When You Need This

- Any LLM output feeds into a programmatic consumer — APIs, databases, downstream services, tool calls
- Parse failures are burning retry budget and inflating API costs
- There's been a production incident caused by unexpected LLM output format
- The system depends on specific fields being present and correctly typed in LLM responses
- Agent systems where malformed output means malformed tool calls that produce cascading failures
- Multiple models or providers are in use, each with different output formatting behavior

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **Agents → Critical.** An agent's tool calls are structured output — every malformed JSON means a failed action, and a failed action mid-loop can cascade through the entire task. Without validation, one bad parse kills a multi-step workflow that might have consumed dozens of API calls to reach that point. I wouldn't want an agent in production without this.
- **RAG → Required.** Retrieved context gets formatted into structured responses — extracted entities, citations with metadata, ranked results. If the output schema breaks, the retrieval work is wasted. Not as immediately catastrophic as agents (the user can still get a text response), but I wouldn't be comfortable getting paged without validation in place.
- **Streaming → Required.** Structured data in streams (function calls, tool use results, metadata alongside tokens) needs schema compliance per chunk. A malformed chunk mid-stream can break the client parser and kill the connection. The tricky part: partial JSON is valid mid-stream but invalid as a complete response, so validation has to account for streaming state.
- **Batch → Required.** Thousands of items processed in a single run. A 10% schema failure rate at 100K items means 10K failures to reprocess — and without validation catching them inline, those bad outputs propagate into downstream data stores. The cost isn't urgency (no user is waiting), it's volume: small failure rates compound into large cleanup jobs.

## The Pattern

### Architecture

The core idea: wrap every LLM call that expects structured output in a parse → repair → validate → retry pipeline. The schema is the source of truth — it defines what valid output looks like, generates the prompt instructions, and provides the validation logic. Every result carries metadata about whether it parsed cleanly, needed repair, or required retries.

```
                         ┌──────────────────────┐
                         │   LLM Call + Schema   │
                         │   (prompt includes    │
                         │    schema context)     │
                         └──────────┬───────────┘
                                    ▼
                         ┌──────────────────────┐
                         │   Raw Text Output     │
                         └──────────┬───────────┘
                                    ▼
                         ┌──────────────────────┐
                    ┌─── │   Step 1: Parse       │ ───── JSON ok ────┐
                    │    │   (JSON.parse / json)  │                   │
                    │    └──────────────────────┘                   ▼
                    │ parse error                          ┌──────────────┐
                    ▼                                      │  Step 3:     │
             ┌──────────────┐                              │  Validate    │
             │  Step 2:     │                              │  (schema     │
             │  Repair      │── repaired ok ──────────────→│   check)     │
             │  (fix JSON)  │                              └──────┬───────┘
             └──────┬───────┘                                     │
                    │ repair failed               ┌───────────────┤
                    ▼                              │               │
             ┌──────────────┐               valid  ▼        invalid ▼
             │  Retry with  │         ┌──────────────┐  ┌──────────────┐
             │  error       │◄────────│  Return      │  │  Retry with  │
             │  feedback    │  budget │  typed       │  │  validation  │
             └──────┬───────┘  left   │  result +    │  │  errors as   │
                    │               │  metadata    │  │  feedback     │
                    ▼               └──────────────┘  └──────┬───────┘
             ┌──────────────┐                                │
             │  Budget      │                          budget exceeded
             │  exhausted → │◄───────────────────────────────┘
             │  fallback    │
             └──────────────┘

        Every result includes:
        ┌───────────────────────────────────────────┐
        │  { data, raw, retries, repaired,          │
        │    validationErrors, parseMethod }         │
        └───────────────────────────────────────────┘
```

Retry counts and threshold values shown are illustrative — actual values depend on model reliability, schema complexity, and latency budget.

**Core abstraction** — the `OutputValidator`:

```typescript
interface OutputSchema<T> {
  parse(raw: string): T; // throws on invalid
  toJsonSchema(): Record<string, unknown>; // for prompt injection
  toPromptInstructions(): string; // human-readable schema description
}

interface ValidationResult<T> {
  success: boolean;
  data?: T; // typed result if valid
  raw: string; // original LLM output
  retries: number; // how many attempts it took
  repaired: boolean; // whether repair was applied
  validationErrors?: string[]; // what went wrong (for logging)
  parseMethod: "direct" | "repaired" | "retry";
}

interface ValidatorConfig {
  maxRetries: number;
  repair: boolean;
  onRetry?: (errors: string[], attempt: number) => void;
  onValidationFailure?: (result: ValidationResult<unknown>) => void;
}
```

The validator wraps an LLM provider call. On each attempt: parse the raw output, optionally run repair if parse fails, validate against the schema. If validation fails, construct error feedback (the specific validation errors, formatted for the model) and retry with the original prompt plus the error context. The model sees exactly what went wrong and gets a chance to self-correct.

**Configurability:**

| Parameter               | Default        | Purpose                                                                                             |
| ----------------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| `maxRetries`            | `2`            | Maximum retry attempts after initial call (so 3 total attempts)                                     |
| `repair`                | `true`         | Whether to attempt JSON repair before retrying                                                      |
| `stripMarkdown`         | `true`         | Whether to strip markdown code fences before parsing                                                |
| `includeSchemaInPrompt` | `true`         | Whether to append JSON schema instructions to the prompt                                            |
| `errorFeedbackFormat`   | `'structured'` | How to format validation errors for model retry — `'structured'` (JSON list) or `'natural'` (prose) |
| `onRetry`               | `undefined`    | Callback fired before each retry attempt — receives errors and attempt number                       |
| `onValidationFailure`   | `undefined`    | Callback fired when all attempts exhausted — receives final `ValidationResult`                      |

These defaults are starting points. Schema complexity, model capability, and latency budget all shift the right values — a simple 3-field schema rarely needs retries, while a deeply nested schema with enum constraints might need `maxRetries: 3` or more.

**Key design tradeoffs:**

| Decision                         | Choice                                                                                     | Rationale                                                                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repair before retry              | Attempt repair first, then retry only if repair also fails validation                      | Repair is typically sub-millisecond vs. retry being a full LLM round-trip (~seconds). Attempting repair first saves the most expensive operation (another API call) for cases where simple JSON fixes aren't enough.              |
| Error feedback to model          | Feed specific validation errors back on retry, not just "try again"                        | A model told "field `age` must be a number, got string `'twenty-five'`" can self-correct. A model told "invalid JSON" can't. Specific feedback reduces retry count by giving the model actionable information.                    |
| Schema as source of truth        | Schema generates both validation logic and prompt instructions                             | Keeps the prompt and validation in sync — if the schema changes, the prompt instructions update automatically. Eliminates the class of bugs where the prompt describes one format and the validator expects another.              |
| No provider-specific integration | Works with any provider; doesn't call OpenAI's JSON mode or Anthropic's structured outputs | Keeps the pattern portable across providers and models. Provider-native structured output can be layered underneath as an optimization, but the application-layer validation remains the safety net.                              |
| Validation errors as strings     | Return human-readable error strings, not error objects                                     | Error strings get fed back to the model as retry context. Human-readable format serves double duty: useful for model retry and useful for logging/debugging. Structured error objects would need serialization before either use. |
| Metadata on every result         | Every `ValidationResult` includes `retries`, `repaired`, `parseMethod`                     | Enables downstream observability without coupling to a specific metrics library. The consumer decides what to track — the validator just reports what happened.                                                                   |

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

Every validation layer introduces its own failure modes. The pattern that's supposed to catch bad output can itself become the problem.

| Failure Mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Detection Signal                                                                                                                                                                                                                             | Mitigation                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Retry budget exhaustion under load** — validation failures consume retry budget across many requests simultaneously. At 10K req/day with a 10% failure rate, that's 1K requests each making 2-3 retry attempts, roughly tripling API costs for those requests (assuming similar token counts per attempt) and adding latency.                                                                                                                                                                         | Retry rate spikes; API cost increases disproportionate to traffic growth; p99 latency jumps during high-failure periods                                                                                                                      | Set a global retry budget (e.g., max 15% of requests can retry) independent of per-request limits; monitor retry rate as a percentage of total traffic; circuit-break retries when the rate exceeds threshold — accept the validation failure rather than compounding costs                                                       |
| **Schema-prompt drift** — the schema evolves (new required fields, changed types) but the prompt instructions or model system message aren't updated to match. The model keeps generating the old format, validation rejects it, retries burn budget on a structurally doomed request.                                                                                                                                                                                                                  | Validation failure rate increases gradually after schema changes; retry success rate drops (retries fail on the same errors as the first attempt); the specific validation errors cluster around recently-changed fields                     | Generate prompt instructions from the schema automatically (not manually); include schema version in logs; alert when retry success rate drops below 50% (retries are no longer helping)                                                                                                                                          |
| **Overly strict schemas rejecting valid output** — the schema constrains more than the use case requires. A field typed as `enum: ['low', 'medium', 'high']` rejects `'moderate'` — a semantically valid response that the model reasonably produced.                                                                                                                                                                                                                                                   | Validation failure rate is high but downstream consumers would accept the rejected responses; manual review of rejected outputs shows semantically correct but schema-non-conformant data                                                    | Review rejected outputs periodically; distinguish structural failures (bad JSON) from semantic failures (valid JSON, wrong values); loosen enums to string types with post-validation normalization where appropriate                                                                                                             |
| **Error feedback loop divergence** — feeding validation errors back to the model causes it to overcorrect. Retry 1 says "field `score` must be 0-100, got 150"; retry 2 returns `score: 0` (technically valid but wrong). The model oscillates between different wrong outputs without converging on the right one.                                                                                                                                                                                     | Retry attempts produce different validation errors each time (not the same error repeating); final output after retries has lower semantic quality than the first attempt; retry success rate is high but downstream quality metrics degrade | Cap retries at 2-3 (diminishing returns beyond that); include the original prompt context in retry, not just the error; log both the first attempt and the final attempt for quality comparison; consider that if the first attempt failed structurally, the model may not be capable of the schema — fall back rather than retry |
| **Repair layer masking model degradation** _(silent)_ — the JSON repair step silently fixes broken output, so validation passes and no alerts fire. But the model is producing increasingly malformed JSON over time (maybe due to a provider model update, or prompt drift). The repair layer hides this degradation because it keeps "succeeding." Over months, you're running a repair-dependent system without knowing it, and when repair can't fix a new class of error, failures spike suddenly. | Repair rate (percentage of requests needing repair) trends upward over weeks; compare validation pass rate with and without repair enabled — growing gap means increasing repair dependency                                                  | Track repair rate as a first-class metric; alert when repair rate exceeds a threshold (e.g., >5% of requests); log what the repair fixed (missing quotes, trailing commas, truncation) to understand the failure pattern; periodically disable repair in shadow mode to measure true model compliance                             |
| **Validation latency compounding** — each retry adds a full LLM round-trip. A request that retries twice takes 3x the base latency. Under load, this creates a bimodal latency distribution: successful first-attempt requests are fast, retried requests are 2-3x slower.                                                                                                                                                                                                                              | p50 latency is normal but p95/p99 spikes significantly; latency histogram shows clear bimodal distribution; timeout rate increases                                                                                                           | Set a total time budget per request (not just retry count); abort retries if the cumulative latency would exceed the SLA; use repair aggressively to avoid the retry round-trip where possible                                                                                                                                    |
| **Schema complexity exceeding model capability** — the schema is valid and reasonable, but the model can't reliably produce output matching it. Deeply nested objects, large enums, conditional fields — the model's structured output capability has a ceiling that the schema exceeds.                                                                                                                                                                                                                | Validation failure rate is consistently high for specific schemas regardless of prompt changes; simpler schemas for the same model succeed reliably; failure rate varies significantly across models for the same schema                     | Benchmark schema complexity against model capability before deploying; flatten nested schemas where possible; split complex schemas into multiple simpler calls; set a complexity budget (max depth, max fields) and validate schemas against it at registration time                                                             |

## Observability & Operations

**Key metrics:**

| Metric                          | Description                                                  | Target          |
| ------------------------------- | ------------------------------------------------------------ | --------------- |
| `validation.success_rate`       | Percentage of requests that pass validation on first attempt | >90%            |
| `validation.repair_rate`        | Percentage of requests needing JSON repair                   | <5%             |
| `validation.retry_rate`         | Percentage of requests requiring at least one retry          | <10%            |
| `validation.retry_success_rate` | Of requests that retry, what percentage eventually succeed   | >70%            |
| `validation.exhausted_rate`     | Percentage of requests that exhaust all retries              | <1%             |
| `validation.latency_ms`         | Total validation time including retries (p50, p95, p99)      | Depends on SLA  |
| `validation.parse_method`       | Distribution of `direct` / `repaired` / `retry` over time    | Trending stable |

**Alerting:**

| Severity           | Condition                                                                         | Meaning                                                                            |
| ------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Warning            | `validation.success_rate` drops below 85% over 15-minute window                   | Something changed (model update, schema drift, prompt change)                      |
| Warning            | `validation.repair_rate` exceeds 10% over 1-hour window                           | Model is producing increasingly malformed JSON (connects to silent degradation FM) |
| Critical           | `validation.exhausted_rate` exceeds 5% over 5-minute window                       | Validation is failing at a rate that impacts users                                 |
| Critical           | `validation.retry_rate` exceeds 30% over 15-minute window                         | Likely a systematic failure (schema-prompt drift, model regression), not random    |
| Warning (low-side) | `validation.retry_rate` drops to 0% for >24 hours after previously being non-zero | Validation may have been silently bypassed or schemas loosened too far             |

These thresholds are starting points. Actual values depend on baseline failure rates for the specific model and schema, SLA requirements, and traffic patterns.

- **Runbook:**
  - **When `exhausted_rate` spikes:** (1) Check provider status — is the model returning degraded output? (2) Check recent schema changes — did a required field get added without updating prompts? (3) Check `validation.retry_success_rate` — if retries are also failing on the same errors, this is systematic, not random. (4) Check `parse_method` distribution — shift from `direct` to `repaired` to `retry` tells you where the pipeline is breaking down.
  - **When `repair_rate` trends upward:** (1) Log what the repair is fixing (trailing commas? truncation? missing quotes?). (2) Check if a model version changed — provider updates can silently regress JSON formatting. (3) Run validation without repair in shadow mode to measure true model compliance. (4) If repair rate exceeds 10%, investigate root cause rather than relying on repair.
  - **When `retry_success_rate` drops below 50%:** Retries are no longer helping — the model can't produce the expected schema. (1) Check schema complexity (field count, nesting, enums). (2) Compare failure rates across models if multi-provider. (3) Simplify the schema or split into multiple calls. (4) Consider falling back to a more capable model for that specific schema.

## Tuning & Evolution

**Tuning levers:**

| Parameter               | Guidance                                                                                                                                                                            | Safe Range                    | Dangerous Extreme                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------- |
| `maxRetries`            | Start at 2; reduce to 1 if retry success rate is >80%; increase to 3 if schema is complex and retry success rate is 50-70%                                                          | 0–3                           | >5 (compounding latency and cost with minimal improvement)              |
| `repair`                | Keep enabled unless repair rate is >15% (at that point, repair is masking a real problem). Disable in shadow mode monthly to reveal true model compliance                           | `true` / `false`              | Permanently disabled without monitoring (hides recoverable failures)    |
| `errorFeedbackFormat`   | `'structured'` works better for models that follow JSON instructions well; `'natural'` for models that struggle with nested JSON feedback. Test both and compare retry success rate | `'structured'` or `'natural'` | N/A                                                                     |
| `includeSchemaInPrompt` | Disable if using provider-native structured outputs (schema is already in the API call). Saves ~300 tokens per request                                                              | `true` / `false`              | N/A                                                                     |
| Schema granularity      | Splitting a 20-field schema into 2-3 smaller schemas often improves first-attempt success rate more than any config change                                                          | 3–15 fields per schema        | >30 fields (exceeds most models' reliable structured output capability) |

**Drift signals:**

| Signal                                       | Meaning                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `repair_rate` trending upward over weeks     | Model compliance is degrading, likely due to provider model updates                              |
| `retry_success_rate` declining               | Error feedback is becoming less effective, or schema has drifted from what the model can produce |
| `validation.latency_ms` p99 increasing       | More requests are hitting the retry path, indicating growing failure rates                       |
| New validation error types appearing in logs | Model is failing in ways the schema didn't anticipate                                            |

Review cadence: weekly check on `repair_rate` and `retry_success_rate` trends; monthly review of rejected output samples.

- **Silent degradation:**
  - **Month 3:** Repair rate has crept from 2% to 8%. No alerts fired because all requests eventually pass validation. But the system is now repair-dependent — a new class of malformed JSON that repair can't fix will cause a sudden failure spike. The signal: trending `repair_rate` chart shows steady upward slope.
  - **Month 6:** A provider model update changed how the model handles a specific field type. The schema still validates, but the semantic quality of a field has degraded — `confidence_score` used to be 0.0-1.0, now it's always 0.85-0.95 (the model learned a safe default). Validation passes, but the field has lost information value. The signal: field value distributions have compressed or shifted. Catching this requires eval-level monitoring, not just schema validation.
  - **Proactive checks:** Run a monthly "validation health report" — disable repair in shadow mode for 1% of traffic, measure true first-attempt pass rate. Compare against baseline from deployment. If the gap between repaired and unrepaired pass rates is growing, the model is getting worse at structured output and repair is hiding it.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers.

| Scale        | Additional Cost | ROI vs. No Pattern                                                                   |
| ------------ | --------------- | ------------------------------------------------------------------------------------ |
| 1K req/day   | +$0.41/day      | Effectively cost-neutral — saves ~$0.39/day in wasted calls from validation failures |
| 10K req/day  | +$4.10/day      | +10.3% overhead offset by ~9.7% wasted call elimination; net ~0.6%                   |
| 100K req/day | +$41.00/day     | Same ratio at scale — real ROI is preventing downstream damage from bad output       |

## Testing

See test files in `src/ts/__tests__/` and `src/py/tests/`. Run with `npm test` (TypeScript) or `pytest` (Python).

- **Unit tests (23):** JSON utility functions (stripMarkdownFences, extractJson, repairJson), JsonObjectSchema parsing, type validation, enum validation, optional fields, non-object rejection, prompt instruction generation, JSON schema generation
- **Failure mode tests (10):** One test per failure mode from the table above — retry budget exhaustion (verifies maxRetries respected, onRetry callback fires per retry, onValidationFailure fires when exhausted), schema-prompt drift (type mismatch detection with field-specific errors), overly strict schemas (enum rejection), error feedback loop divergence (verifies feedback included in retry prompts), repair layer masking degradation (verifies repaired flag in metadata, clean parses report repaired=false), validation latency compounding (verifies totalLatencyMs tracking across retries), schema complexity exceeding model capability (consistent errors on wrong structure)
- **Integration tests (10):** Full pipeline end-to-end — markdown-wrapped JSON, JSON with surrounding prose, JSON repair, truncated JSON handling, retry with model self-correction, prompt augmentation with schema, prompt not augmented when disabled, provider error propagation, complete multi-retry flow with callbacks
- **What to regression test:** Repair rate trending upward (test with repair metrics), retry success rate (should stay above 50%), validation failure rate after schema changes

## When This Advice Stops Applying

- **Pure chat interfaces where output goes directly to human eyes.** If there's no programmatic consumer parsing the response, validation adds overhead without protecting anything. A human reader can handle a slightly off-format response just fine.
- **Creative writing or open-ended generation.** The output format is intentionally free-form — imposing structure on creative text contradicts the purpose. Validation here constrains what should be unconstrained.
- **Early prototyping before the schema has stabilized.** Validation slows iteration when the shape is still changing daily. I'd want to lock the schema first, then add validation — otherwise the validation layer becomes the bottleneck for experimentation.
- **Provider-guaranteed structured outputs covering the full schema.** If using OpenAI's strict mode or Anthropic's constrained outputs and the schema fits within their constraints (no recursion, within size limits), the provider handles compliance at the token level. Application-layer validation becomes a redundant check — still worth having as defense in depth, but the cost-benefit shifts. The pattern stops being critical and becomes a safety net.
- **When the validation overhead exceeds the cost of occasional failures.** For low-stakes, low-volume use cases where a malformed response just means retrying once, the full validation pipeline (schema definition, error mapping, retry logic, metrics) may be overengineering the problem.

<!-- ## Companion Content

- Blog post: [Structured Output Validation — Deep Dive](https://prompt-deploy.com/structured-output-validation) (coming soon)
- Related patterns:
  - [Graceful Degradation](../../resilience/graceful-degradation/) — what to do when validation fails and retries are exhausted; the fallback chain picks up where this pattern gives up
  - [Tool Call Reliability](../../orchestration/tool-call-reliability/) — applies validation specifically to LLM-generated tool/function calls; depends on this pattern's schema validation layer
  - [Prompt Injection Defense](../prompt-injection-defense/) — validates output safety, not just structure; complementary concern (structure + safety = full output validation)
  - [Eval Harness](../../testing/eval-harness/) — tests that validation rules catch the right failures; the eval harness verifies the schema is right, this pattern enforces it at runtime
  - [PII Detection](../pii-detection/) — validates output content for sensitive data; structural validation and content validation work together -->

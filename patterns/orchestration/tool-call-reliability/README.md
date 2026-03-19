# Tool Call Reliability

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

LLMs generate tool calls with wrong argument types, missing required fields, hallucinated function names, or malformed JSON — and they do it confidently. Without reliability patterns, a non-trivial share of tool calls fail silently or visibly at parse time, and another fraction fail with valid-but-wrong arguments that produce downstream errors with no clear signal.

The numbers are stark. [Sierra AI's tau-bench](https://sierra.ai/blog/benchmarking-ai-agents) showed GPT-4o achieving ~61% single-trial success on tool-use tasks. When consistency is required across 8 trials — representing a real-user session — that drops to ~25%. An agent with 85% per-step accuracy only completes a 10-step task correctly about 20% of the time; compound failures at each tool call link the chain. [Salesforce's MCP-Universe benchmark](https://arxiv.org/pdf/2508.14704) found the best model (GPT-5) succeeding on only 43.7% of real-world multi-tool tasks, with most models below 30%.

What breaks in production looks like this: the model calls a tool with `"count": "5"` instead of `"count": 5`, and the downstream function silently coerces or silently fails. It calls a function name it hallucinated — `get_customer_by_id` — when the actual tool is `fetch_customer`. It returns valid JSON for the tool call but uses a string for a required boolean field. Before OpenAI [introduced constrained decoding](https://openai.com/index/introducing-structured-outputs-in-the-api/) in 2024, `gpt-4-0613` fell below 40% on complex JSON schema evals; with strict mode enabled, that number reaches 100% (for syntactic schema conformance — semantic errors like wrong values still require a validation layer). The gap between a raw model and a validated one is real.

There's also a scale problem. Anthropic's [advanced tool use engineering post](https://www.anthropic.com/engineering/advanced-tool-use) documented that a traditional 5-server setup consumed ~55K tokens just in tool definitions before the first user message — Jira alone took ~17K tokens. Above roughly 30 tools, tool descriptions begin overlapping and selection accuracy degrades. Beyond 5–6 sequential tool calls in a chain, context saturation causes the model to fill in gaps from earlier steps with fabricated values.

Security matters here too. [Answer.AI documented](https://www.answer.ai/posts/2026-01-20-toolcalling.html) that Claude, Gemini, and Grok could all be prompted to call tools they were never given — and without server-side allowlist validation, those calls would execute. The fix is one line of code, but it's not the default behavior.

## What I Would Not Do

The first instinct is to reach for catch-and-retry: wrap the tool call in a try/catch, catch the JSON parse error, and re-run the same prompt. I've seen this ship to production, and it's deceptively dangerous.

Here's specifically what breaks. Catch-and-retry doesn't tell the model _why_ the call failed. The model regenerates from the same context and produces the same malformed call again — it doesn't know the error was structural. You burn retry budget on format failures that a schema validator would have caught immediately. At 5% parse failure rate and a 3-retry limit, you've tripled your API costs for those requests while delivering the same error to users.

The deeper problem: a retry loop with no validation layer can't distinguish a transient API error (worth retrying) from a structural schema violation (worth fixing upstream in the tool definition). They look identical from a catch block. At production load, this blind retry logic causes the exact retry storms that Retry with Budget was designed to prevent.

Equally naive: trusting that strict mode or constrained decoding alone solves the problem. Constrained decoding guarantees syntactically valid JSON — it doesn't guarantee the arguments are semantically correct. The model can still pass the wrong value for a field, call the right tool with the right types but logically incorrect data, or call a tool that's valid-by-schema but inappropriate for the current task state.

## When You Need This

- Your LLM generates function or tool calls and you've seen parse failures or wrong-argument errors in logs
- Tool call failures cause user-visible errors or silently corrupt downstream state
- Tool calls consume retry budget with format errors rather than actual transient failures
- You have more than ~10 tools in context, or the model is choosing tools inconsistently
- Agents making sequential tool calls — failure at step 3 of 8 loses all work from steps 1 and 2
- Any deployment where tool execution has side effects (writes, API calls, state changes)

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **Agents → Critical.** An agent's entire action surface is tool calls. Without validation, every malformed call either crashes the loop or executes with wrong arguments and corrupts state. I wouldn't ship an agent system without this — the failure mode is too broad and too silent.
- **RAG → Recommended.** RAG systems with function calling (metadata filtering, hybrid retrieval, structured queries) benefit meaningfully from validated tool calls, but the blast radius of a failure is smaller — usually a missed retrieval, not corrupted data. I'd notice the gap within the first month of production load.
- **Batch → Recommended.** Batch jobs running overnight don't have a user waiting, but a 20% tool call failure rate at scale means a significant share of jobs fail silently or produce wrong results. Worth implementing before costs compound.
- **Streaming → Optional.** Streaming systems rarely use complex tool calling; their critical concerns are latency and connection stability. Tool call validation is worth adding if tool use is a core part of the streaming flow, but it's not the first thing I'd reach for.

## The Pattern

### Architecture

```
1. User Request
         │
         ▼
   [LLM Provider] ◄── repair + error context
         │                        ▲
         ▼                        │
   tool_call response              │ (max N retries)
         │                        │
         ▼                        │
2. [Tool Call Validator]           │
   ┌─────┴──────────┐              │
[Allowlist      [Schema            │
  Check]         Check]            │
   └─────┬──────────┘              │
         │                        │
    ┌────┴─────┐                   │
 [Valid]   [Invalid]───────────────┘
    │           │
    │      [Exhausted]
    │           │
    │      [Log + Fallback]
    ▼
3. [Execute Tool]
         │
         ▼
   [Tool Result]
         │
         ▼
   [Next Step]
```

_Thresholds (max retries, schema strictness) are illustrative — tune to your SLA and provider._

The core abstraction is a `ToolCallValidator` that sits between the LLM response and tool execution. It runs three checks in sequence:

1. **Allowlist check** — is the tool name one that was actually provided in the context? Rejects hallucinated tool names before they reach the execution layer.
2. **Schema check** — does the argument payload match the JSON schema for the tool? Catches type mismatches, missing required fields, and enum violations.
3. **Repair loop** — on failure, sends structured error feedback back to the model with the validation errors included, then re-requests the tool call. Capped at `maxRepairAttempts` to prevent retry storms.

### Core Abstraction

```typescript
interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, JSONSchemaProperty>;
    required?: string[];
  };
}

interface ToolCallResult {
  valid: boolean;
  toolName: string;
  arguments: Record<string, unknown>;
  errors?: ValidationError[];
  repairAttempts: number;
}

class ToolCallValidator {
  constructor(config: ValidatorConfig);
  validate(toolCall: RawToolCall, tools: ToolSchema[]): Promise<ToolCallResult>;
  repair(
    toolCall: RawToolCall,
    errors: ValidationError[],
    tools: ToolSchema[],
    messages: Message[]
  ): Promise<ToolCallResult>;
}
```

### Configurability

| Parameter            | Default           | Effect                                                 | Dangerous Extreme                                         |
| -------------------- | ----------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| `maxRepairAttempts`  | `2`               | How many times to re-request a corrected tool call     | >3: retry storms on persistent format failures            |
| `strictAllowlist`    | `true`            | Reject tool calls for names not in the provided schema | `false`: allows hallucinated tool calls to execute        |
| `schemaStrictness`   | `'required-only'` | Validate only required fields, or all fields           | `'all'`: may reject valid partial calls                   |
| `repairFeedbackMode` | `'structured'`    | How to convey validation errors back to the model      | `'verbose'`: large repair messages consuming token budget |
| `onRepairFailure`    | `'throw'`         | Behavior when all repair attempts fail                 | `'silent-drop'`: silently loses the tool call             |

_These defaults are starting points. Your SLA, provider characteristics, and whether tools have side effects will shift several of them._

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

### Key Design Tradeoffs

**Schema validation vs. constrained decoding.** Constrained decoding (OpenAI `strict: true`) guarantees syntactically valid JSON; it doesn't guarantee semantic correctness. Schema validation in this layer catches semantic errors that constrained decoding misses. The two complement each other — use both when available.

**Repair vs. fallback.** Sending validation errors back to the model for repair is effective but costs tokens. The repair message must be concise enough that it doesn't saturate context on its own. For simple schemas, structured error messages ("field 'count' expected integer, got string") work well. For complex multi-level schemas, a fallback (returning a structured error to the caller) is often cheaper than multiple repair attempts.

**Allowlist strictness.** Making the allowlist check mandatory prevents the [Answer.AI-documented hallucination attack](https://www.answer.ai/posts/2026-01-20-toolcalling.html) where models call tools not in the provided schema. The cost is a slightly higher implementation burden: the validator needs the full tool schema at call time. Worth it for any system where tools have side effects.

**Tool count management.** For systems with >30 tools, the repair loop alone isn't sufficient — the model struggles to select the right tool in the first place. The complementary fix is dynamic tool selection (loading only relevant tools per request). That's an architectural concern beyond this pattern's scope, but worth noting: validation fixes malformed calls, not selection failures.

## Failure Modes

| Failure Mode                                                                                                                          | Detection Signal                                                                                    | Mitigation                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Repair loop exhaustion — model can't fix the call in N attempts                                                                       | `repairAttempts == maxRepairAttempts` logged per request; rising error rate in validation dashboard | Increase `maxRepairAttempts` temporarily; investigate tool schema clarity; add few-shot examples showing correct call format |
| Schema drift — tool definition updated in code without updating the validator's schema copy                                           | Sudden spike in schema validation failures for a specific tool name; valid calls start failing      | Derive validator schemas from a single source of truth (e.g., Zod schema → both TypeScript types and validation rules)       |
| Allowlist bypass — tool added at runtime without updating the allowlist                                                               | Hallucinated tool calls succeed silently; downstream function calls undocumented behavior           | Rebuild allowlist from the schema registry at each request; never hardcode the allowed set separately                        |
| Repair token exhaustion — repair messages grow large for complex schemas                                                              | Total token count per request rising; repair messages consuming context                             | Cap repair message length; truncate error detail for complex schemas; fallback after first repair attempt                    |
| Silent degradation: repair loop masks upstream prompt quality decay                                                                   | Repair rate rising slowly over weeks (from 3% → 12%) without triggering any alert                   | Alert on `repair_rate > 5%` sustained over 24h; review prompt and tool schema at Month 3 and Month 6                         |
| Over-validation — strict schema rejects partially correct calls that would have succeeded                                             | Tool call success rate drops after stricter validation is deployed; user-visible failures increase  | Loosen `schemaStrictness` to `'required-only'`; audit rejected calls before tightening schema                                |
| Model version drift — provider model update shifts default tool call behavior, raising baseline repair rate without any schema change | Repair rate jumps after a provider release or model alias change; no schema or prompt changed       | Pin model version in production; shadow-test new model versions against tool call evals before rolling over                  |

## Observability & Operations

**Key metrics:**

| Metric                               | Unit                              | What It Signals                                                                                 |
| ------------------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `tool_call_parse_failure_rate`       | % of requests                     | Model producing malformed JSON for tool calls; should be near 0 with constrained decoding       |
| `tool_call_schema_failure_rate`      | % of requests                     | Semantic validation failures (wrong types, missing fields)                                      |
| `tool_call_repair_rate`              | % of requests requiring ≥1 repair | Overall tool call quality; rising rate signals prompt or schema regression                      |
| `tool_call_repair_success_rate`      | % of repairs that succeed         | Model's ability to self-correct; drop signals schema is ambiguous or tools are poorly described |
| `tool_call_allowlist_rejection_rate` | Count/hr                          | Hallucinated tool calls; nonzero rate warrants immediate investigation                          |
| `tool_call_latency_p99`              | ms                                | Repair loop adds latency; watch p99 for repair-path cost                                        |
| `repairs_per_request`                | mean                              | Mean repair attempts; rising mean signals degradation in prompt quality                         |

**Alerting:**

| Alert                        | Condition                                       | Severity | First Check                                                                         |
| ---------------------------- | ----------------------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| High schema failure rate     | `schema_failure_rate > 10%` sustained 15 min    | Warning  | Was a tool schema recently changed? Check deployment diff                           |
| Critical schema failure rate | `schema_failure_rate > 25%` sustained 5 min     | Critical | Rollback recent schema or prompt changes; check if provider changed response format |
| Allowlist rejection nonzero  | `allowlist_rejection_rate > 0` any 5 min window | Warning  | Review prompt injection or malicious input patterns; audit rejected tool names      |
| Repair success rate drop     | `repair_success_rate < 50%` sustained 30 min    | Warning  | Tool schemas may be ambiguous; add few-shot correction examples                     |
| Repair rate creep            | `repair_rate > 8%` sustained 24h                | Warning  | Silent quality decay in progress; review prompt and tool definitions                |

_These thresholds are starting points — adjust based on your traffic profile, acceptable failure rate, and whether tools have irreversible side effects._

**Runbook:**

1. **High schema failure rate (Warning):**
   - Check: was a tool schema or system prompt changed in the last deploy?
   - Check: did the LLM provider release a model update?
   - If schema changed: rollback to previous schema and validate in staging with the new schema first
   - If no schema change: sample 20 rejected calls and analyze the failure pattern — is it one field or many?

2. **Allowlist rejection (any):**
   - Sample all rejected calls within the last hour
   - Check whether rejections cluster around a specific user session (possible injection attempt)
   - Check whether tool name is close to a real tool name (typo in schema definition)
   - If security-relevant: escalate to security review

3. **Repair success rate drop:**
   - Pull a sample of failed repairs; categorize by error type
   - Review tool descriptions for ambiguity — especially any tools recently added
   - Add targeted few-shot examples to the repair prompt showing correct format for failing field types

## Tuning & Evolution

**Tuning levers:**

| Lever                              | Effect                                                                                      | Safe Range                        | Dangerous Extreme                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------- |
| `maxRepairAttempts`                | Higher = more self-correction, more latency                                                 | 1–3                               | >3 burns retry budget; adds >2s to p99 latency                      |
| `schemaStrictness`                 | `'required-only'` is permissive; `'all'` is strict                                          | Start at `'required-only'`        | `'all'` on complex optional fields will over-reject valid calls     |
| `repairFeedbackMode`               | `'structured'` provides minimal context; `'verbose'` provides full schema in repair message | `'structured'` for most use cases | `'verbose'` on deep nested schemas can double per-repair token cost |
| Tool schema descriptions           | Clear, typed, with examples → fewer failures                                                | —                                 | Ambiguous descriptions with no examples drive repair rate above 10% |
| Few-shot examples in repair prompt | Correct examples for commonly-failing fields reduce repair failure rate                     | 1–2 examples for complex fields   | Excessive examples push context cost higher than the repair saves   |

**Drift signals:**

- **Repair rate rising week-over-week** — a 3% rate is fine at launch; 8% six months later signals tool definition or prompt drift
- **New error types appearing in repair logs** — a new field type or enum value was added to a tool schema without updating examples in the system prompt
- **Specific tool's failure rate diverging from the fleet** — that tool's schema is ambiguous or its description has become inconsistent with how it's actually used

**Review cadence:** Check repair rate and allowlist rejection rate monthly for the first three months, then quarterly once the system stabilizes.

**Silent degradation at Month 3 / Month 6:**

The failure mode nobody notices: repair rate drifts from 3% → 8% → 14% over six months as prompts evolve, new tools are added, and model updates shift default behavior. No single change triggers an alert, but the cumulative effect is that a growing share of tool calls require multiple attempts — users experience latency creep, and costs rise ~15–20% with no corresponding feature change. The detection signal is a repair rate trend line, not a threshold breach. I'd set a sustained `repair_rate > 8%` alert (24-hour window) and review tool schemas at Month 3 and Month 6 proactively, independent of alerts.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers.

| Scale        | Additional Cost (5% repair rate) | ROI vs. No Pattern                                                        |
| ------------ | -------------------------------- | ------------------------------------------------------------------------- |
| 1K req/day   | +$0.18/day                       | Immediate — prevents failed agent sessions worth multiple API calls       |
| 10K req/day  | +$1.75/day                       | Immediate — ~2.86% overhead; repair rate drift from 5%→15% adds $5.25/day |
| 100K req/day | +$17.50/day                      | High — watch repair rate monthly; 5%→15% drift adds $35/day unnoticed     |

_GPT-4o pricing (Mar 2026): $2.50/1M input, $10.00/1M output. See [cost-analysis.md](cost-analysis.md) for full projections._

## Testing

How to verify this pattern works correctly. See test files in `src/ts/` and `src/py/`.

- **Unit tests:** Parse failures (malformed JSON, non-object), schema validation (missing required fields, wrong types, invalid enums, non-integer for integer fields), allowlist check (hallucinated name rejected, disabled mode pass-through), required-only vs. all-fields strictness modes, configuration handling
- **Failure mode tests:** One test per failure mode row — repair loop exhaustion (throw vs. return-error policy), allowlist bypass prevention (zero repair attempts used), over-validation detection (required-only passes optional type errors), repair success on second attempt, silent degradation rate tracking across multiple calls
- **Integration tests:** Full happy-path flow (parse → allowlist → schema → valid result), repair from malformed JSON to valid result, concurrent validation (N parallel calls don't interfere), ToolCallValidationError carries full result for diagnostics

**How to run (TypeScript):**

```bash
cd src/ts && npm install && npm test
```

**How to run (Python):**

```bash
cd src/py && pip install pytest pytest-asyncio && python -m pytest tests/ -v
```

## When This Advice Stops Applying

- Systems without tool or function calling — no tool calls to validate
- Simple tool schemas where validation is trivial (single parameter, string only, no required fields) — the validation layer adds overhead without meaningful protection
- Human-in-the-loop workflows where a person verifies every tool call before execution — human review catches what validation misses
- Prototypes where tool call errors are acceptable and manually corrected
- When the model provider offers constrained decoding with strict schema mode and your schemas are simple enough that semantic errors are the only remaining concern — constrained decoding may be sufficient without this additional layer

<!-- ## Companion Content

- Blog post: [Tool Call Reliability — Deep Dive](https://prompt-deploy.com/tool-call-reliability) (coming soon)
- Related patterns:
  - [Structured Output Validation](../../safety/structured-output-validation/) (#2, S1) — tool call reliability is structured output validation applied specifically to function calls
  - [Agent Loop Guards](../agent-loop-guards/) (#17, S5) — guards against loops caused by repeated failed tool calls
  - [State Checkpointing](../state-checkpointing/) (#25, S7) — saves state before tool execution for recovery
  - [Prompt Injection Defense](../../safety/prompt-injection-defense/) (#15, S5) — injection can manipulate tool call arguments
  - [Retry with Budget](../../resilience/retry-with-budget/) (#5, S2) — retries for transient tool call failures -->

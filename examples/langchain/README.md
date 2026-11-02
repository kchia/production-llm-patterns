# Framework Adapter: LangChain

> **Patterns demonstrated:** [Structured Output Validation](../../patterns/safety/structured-output-validation/) · [Prompt Version Registry](../../patterns/observability/prompt-version-registry/) · [Tool Call Reliability](../../patterns/orchestration/tool-call-reliability/)

LangChain's LCEL (LangChain Expression Language) is good at composing chain steps, but it doesn't solve prompt management, structured output safety, or tool argument validation on its own. The built-in output parsers throw on schema failure but don't budget retries. Prompt templates are typically inlined as constants — there's no built-in concept of versioning them. Tool call arguments arrive at your handler unsanitized.

These three patterns fill those gaps. Together they make a LangChain-based system that's traceable (which prompt version caused a quality shift), structurally safe (schema validation with bounded retries), and reliable under tool-using agents (validated arguments before business logic runs).

---

## Architecture

```
  Request
    │
    ▼
┌───────────────────────────────────────────────────┐
│  Prompt Version Registry                          │
│  registry.fetch(id, version) → PromptTemplate    │
└───────────────────────────────────────────────────┘
    │
    ▼
┌───────────────────────────────────────────────────┐
│  model.withStructuredOutput(schema)               │
│  + invokeWithValidation (retry on schema failure) │
└───────────────────────────────────────────────────┘
    │
    ▼
┌───────────────────────────────────────────────────┐
│  Tool Call Reliability                            │
│  validate tool arguments before invocation        │
│  (catches malformed args from the model)          │
└───────────────────────────────────────────────────┘
```

---

## Key Wiring Points

**Versioned prompt templates are fetched by ID + version**, not imported as string constants. The difference is traceability — when output quality changes, you need to know which template produced which output.

```ts
// Traceable: fetch by version from registry
const template = registry.fetch('summarize', '1.2.0');

// Not traceable: constant inline template
const template = ChatPromptTemplate.fromTemplate('Summarize: {text}');
```

**`withStructuredOutput` is the validation hook, but the retry logic belongs to you.** LangChain doesn't budget validation retries — wrapping the chain invocation with bounded retry is necessary to avoid infinite loops when the model returns malformed JSON.

**Tool argument validation runs in the tool handler**, not after the model call. Catching malformed arguments before they hit your business logic prevents partial execution and makes error attribution straightforward.

---

## Running the Example

```bash
cd examples/langchain
npm install
OPENAI_API_KEY=sk-... npx tsx index.ts
```

---

## What to Watch

| Signal | What it means |
|--------|---------------|
| Structured output retries > 3% | Prompt template needs clearer format instructions |
| Tool arg validation failures | Model is choosing the wrong tool schema; audit tool descriptions |
| Registry miss errors | Stale template version reference in calling code; update the version string |

---

## Pattern References

- [Structured Output Validation](../../patterns/safety/structured-output-validation/README.md) — schema validation, retry-on-invalid, silent failure detection
- [Prompt Version Registry](../../patterns/observability/prompt-version-registry/README.md) — template versioning, change tracking, rollback
- [Tool Call Reliability](../../patterns/orchestration/tool-call-reliability/README.md) — argument validation, retry on malformed calls, reliability metrics

# Recipe: Agent Safety Stack

> **Patterns combined:** [Agent Loop Guards](../../patterns/orchestration/agent-loop-guards/) + [Tool Call Reliability](../../patterns/orchestration/tool-call-reliability/) + [Prompt Injection Defense](../../patterns/safety/prompt-injection-defense/)

Agents are the highest-risk LLM deployment pattern. They make autonomous decisions, call tools with real-world side effects, and run without a human reviewing each step. Without safety controls, a single malformed tool call corrupts state, a stuck loop burns a day's token budget, and an injected instruction can trigger unintended actions. These three patterns compose as a concentric defense: injection defense screens input before the loop starts, loop guards bound execution, and tool call reliability validates every action before it executes.

---

## When This Combination Makes Sense

The trigger isn't optional for agents at any production scale:

- The agent makes tool calls with real-world side effects (database writes, emails sent, APIs called)
- Task complexity is variable — some tasks take 3 steps, others take 30, and there's no fixed upper bound
- The agent processes user-supplied content or retrieves from external sources (indirect injection risk)
- Multiple concurrent agent sessions run without a human watching each one
- A stuck or injected agent could cause financial loss, data corruption, or user-visible harm

Any one of these is enough to need all three patterns. They're not independent safeguards — they protect different attack surfaces in the same system.

---

## How the Three Patterns Compose

The patterns form concentric defense rings around the agent execution loop:

| Ring | Pattern | Scope | What It Stops |
|---|---|---|---|
| Outer | Prompt Injection Defense | Pre-loop input screening | Malicious instructions hijacking agent behavior |
| Middle | Agent Loop Guards | Execution bounds | Infinite loops, excessive cost, time overruns |
| Inner | Tool Call Reliability | Per-tool-call validation | Malformed calls, wrong arguments, unauthorized tools |

### Architecture

```
                    User Input / Task
                           │
          ┌────────────────▼────────────────┐
          │    Prompt Injection Defense      │  ← Outer ring
          │  1. Input sanitization          │
          │  2. Pattern detection           │
          │  3. LLM-based classifier        │
          │  injection detected → reject    │
          └────────────────┬────────────────┘
                           │ (clean input)
                           ▼
          ┌────────────────────────────────────────┐
          │   Agent Loop (with Loop Guards)         │  ← Middle ring
          │                                         │
          │  ┌──────────────────────────────────┐  │
          │  │ per-iteration checks:            │  │
          │  │  • iteration count < max         │  │
          │  │  • token spend < budget          │  │
          │  │  • elapsed time < timeout        │  │
          │  │  • repetition pattern? → break   │  │
          │  └──────────────┬───────────────────┘  │
          │                 │                       │
          │                 ▼                       │
          │          LLM Reasoning Step             │
          │                 │                       │
          │                 ▼                       │
          │  ┌──────────────────────────────────┐  │
          │  │ Tool Call Reliability             │  │  ← Inner ring
          │  │  • allowlist check               │  │
          │  │  • schema validation             │  │
          │  │  • semantic argument check       │  │
          │  │  • structured retry on fail      │  │
          │  └──────────────┬───────────────────┘  │
          │                 │                       │
          │                 ▼                       │
          │          Tool Execution                 │
          │          (with real side effects)       │
          │                 │                       │
          │                 └── feedback to LLM ──→ │
          └──────────────────────────────────┬──────┘
                                             │
                                      Final Response
```

---

## Wiring Code

### TypeScript

```typescript
import { InjectionDefense } from '../patterns/safety/prompt-injection-defense/src/ts/index.js';
import { AgentLoopGuard } from '../patterns/orchestration/agent-loop-guards/src/ts/index.js';
import { ToolCallValidator } from '../patterns/orchestration/tool-call-reliability/src/ts/index.js';

// ── Outer Ring: Injection Defense ─────────────────────────────────────

const injectionDefense = new InjectionDefense({
  sanitize: true,                // strip control tokens and prompt delimiters
  detectionLayers: [
    { type: 'pattern', weight: 1.0 },         // fast, catches known patterns
    { type: 'llm-classifier', weight: 2.0 },  // catches novel attacks
  ],
  injectionThreshold: 0.7,       // combined weighted score that triggers rejection
  onInjectionDetected: (event) => {
    console.warn('Injection attempt detected', {
      score: event.score,
      source: event.source,
    });
    recordSecurityEvent('injection.detected', event);
  },
});

// ── Middle Ring: Loop Guards ───────────────────────────────────────────

const loopGuard = new AgentLoopGuard({
  maxIterations: 25,
  maxTokenBudget: 50_000,         // tokens across all steps in this task
  maxElapsedMs: 120_000,          // 2 minutes total wall time
  repetitionWindowSize: 5,        // look at last 5 steps for patterns
  repetitionThreshold: 0.9,       // similarity score that signals looping
  onLimitApproaching: (event) => {
    console.warn(`Loop guard: ${event.reason} at ${event.pct}%`);
  },
  onLimitExceeded: (event) => {
    recordMetric('agent.loop_guard_triggered', { reason: event.reason });
    throw new AgentBudgetExceededError(event.reason);
  },
});

// ── Inner Ring: Tool Call Reliability ─────────────────────────────────

const toolValidator = new ToolCallValidator({
  allowedTools: ['search', 'read_file', 'write_file', 'send_email', 'query_db'],
  schemas: loadToolSchemas('./tools/schemas.json'),
  retryOnSchemaFailure: true,
  maxRetries: 2,
  onValidationFailure: (event) => {
    console.warn(`Tool call rejected: ${event.toolName}`, {
      reason: event.reason,
      rawCall: event.rawCall,
    });
  },
});

// ── Composed Agent Runner ──────────────────────────────────────────────

export async function runAgent(userInput: string, context: AgentContext) {
  // 1. Screen input before the loop starts.
  const cleanInput = await injectionDefense.screen(userInput);
  if (cleanInput.injectionDetected) {
    throw new InjectionRejectedError('Input failed injection screening');
  }

  // Also screen any documents retrieved from external sources.
  const cleanContext = await Promise.all(
    context.documents.map((doc) => injectionDefense.screenDocument(doc))
  );

  // 2. Run the agent loop under guard constraints.
  const result = await loopGuard.run(async (iteration) => {
    // LLM reasoning step.
    const llmResponse = await callLLM({
      systemPrompt: agentSystemPrompt,
      userMessage: cleanInput.sanitized,
      context: cleanContext,
      toolDefinitions: toolValidator.getAllowedToolDefinitions(),
    });

    if (llmResponse.finishReason === 'stop') {
      return { done: true, result: llmResponse.content };
    }

    if (llmResponse.toolCalls) {
      // 3. Validate each tool call before execution.
      const validatedCalls = await toolValidator.validate(llmResponse.toolCalls);
      const toolResults = await Promise.all(
        validatedCalls.map((call) => executeTool(call))
      );

      // Feed results back to the LLM in the next iteration.
      iteration.feedToolResults(toolResults);
      return { done: false };
    }

    return { done: true, result: llmResponse.content };
  });

  return result;
}
```

### Python

```python
from patterns.safety.prompt_injection_defense.src.py import InjectionDefense, DefenseConfig
from patterns.orchestration.agent_loop_guards.src.py import AgentLoopGuard, LoopGuardConfig
from patterns.orchestration.tool_call_reliability.src.py import ToolCallValidator, ValidatorConfig

# ── Outer Ring: Injection Defense ─────────────────────────────────────

injection_defense = InjectionDefense(
    config=DefenseConfig(
        sanitize=True,
        detection_layers=[
            {"type": "pattern", "weight": 1.0},
            {"type": "llm-classifier", "weight": 2.0},
        ],
        injection_threshold=0.7,
        on_injection_detected=lambda e: record_security_event("injection.detected", e),
    )
)

# ── Middle Ring: Loop Guards ───────────────────────────────────────────

loop_guard = AgentLoopGuard(
    config=LoopGuardConfig(
        max_iterations=25,
        max_token_budget=50_000,
        max_elapsed_ms=120_000,
        repetition_window_size=5,
        repetition_threshold=0.9,
        on_limit_exceeded=lambda e: (_ for _ in ()).throw(
            AgentBudgetExceededError(e.reason)
        ),
    )
)

# ── Inner Ring: Tool Call Reliability ─────────────────────────────────

tool_validator = ToolCallValidator(
    config=ValidatorConfig(
        allowed_tools=["search", "read_file", "write_file", "send_email", "query_db"],
        schemas=load_tool_schemas("tools/schemas.json"),
        retry_on_schema_failure=True,
        max_retries=2,
        on_validation_failure=lambda e: log_warning(
            f"Tool call rejected: {e.tool_name} — {e.reason}"
        ),
    )
)

# ── Composed Agent Runner ──────────────────────────────────────────────

async def run_agent(user_input: str, context: dict) -> str:
    # 1. Screen input and any externally retrieved documents.
    clean_input = await injection_defense.screen(user_input)
    if clean_input.injection_detected:
        raise InjectionRejectedError("Input failed injection screening")

    clean_docs = await asyncio.gather(*[
        injection_defense.screen_document(doc)
        for doc in context.get("documents", [])
    ])

    # 2. Run the agent loop under guard constraints.
    async def agent_step(iteration):
        response = await call_llm(
            system_prompt=AGENT_SYSTEM_PROMPT,
            user_message=clean_input.sanitized,
            context=[d.sanitized for d in clean_docs],
            tool_definitions=tool_validator.get_allowed_definitions(),
        )

        if response.finish_reason == "stop":
            return {"done": True, "result": response.content}

        if response.tool_calls:
            # 3. Validate before executing.
            validated = await tool_validator.validate(response.tool_calls)
            tool_results = await asyncio.gather(*[
                execute_tool(call) for call in validated
            ])
            iteration.feed_tool_results(tool_results)
            return {"done": False}

        return {"done": True, "result": response.content}

    return await loop_guard.run(agent_step)
```

---

## What to Watch

### Metrics to Track

| Metric | What It Signals | Alert If |
|---|---|---|
| `injection.detected` rate | Attack surface exposure | > 0.5% of requests (unusual if legitimate users) |
| `injection.score` p99 | Near-misses on injection threshold | p99 > 0.5 (attackers probing the threshold) |
| `loop.iterations` p99 | Typical task complexity | p99 > 15 (tasks may be under-specified) |
| `loop.guard_triggered` | Stuck or runaway tasks | > 0.5% of sessions |
| `loop.token_spend` p99 | Cost per session | p99 > budget × 0.8 (sessions hitting ceiling) |
| `tool.validation_failures` | Schema or allowlist issues | > 1% of tool calls (model may be confused about tool contracts) |
| `tool.retry_rate` | How often validation requires a re-prompt | > 5% (tool definitions may need clearer descriptions) |

### Combined Failure Modes

**Multi-turn injection accumulation.** A single turn doesn't trigger the injection threshold, but an attacker spreads the injection across five turns. No individual message scores above 0.7; the cumulative instruction assembles correctly in context. The injection defense screens each message independently, not the accumulated conversation. Consider maintaining a session-level injection risk score that aggregates across turns.

**Loop guard trips on legitimate long tasks.** A complex research task legitimately requires 30 iterations — data gathering, analysis, synthesis. The loop guard is set to 25 and triggers prematurely. The guard isn't wrong; the task definition needs decomposition. Track which task types repeatedly hit loop guard limits and use that signal to redesign the task as multiple shorter sub-tasks with checkpointing.

**Tool call schema confusion at high tool counts.** Above ~15 tools, models start confusing similar tool names or mis-assigning arguments across tools. Tool call reliability's schema validator catches the structural errors, but the cost is retry loops — each retry re-prompts the LLM with correction context. Track retry rate by tool count in context. If retry rate climbs above 5% at >15 tools, consider dynamic tool selection (expose only tools relevant to the current task step).

**Indirect injection through tool results.** A tool call returns data from an external source (web search result, database row) that contains injected instructions. The tool call reliability layer validates the outbound call but doesn't screen the returned data. The injected instructions in the tool result influence the next LLM step. Apply `injectionDefense.screenDocument()` to tool results the same way you screen user input.

**Silent cost accumulation across sessions.** Individual sessions each respect the token budget. But a large burst of concurrent sessions — 500 agents running simultaneously — multiplies total spend in a way no per-session guard catches. Monitor aggregate token spend per minute, not just per session, and apply a global rate limit at the infrastructure level.

### Runbook: Loop Guard Triggered

1. Check `loop.guard_triggered.reason` — is it iterations, tokens, time, or repetition?
2. If repetition: pull the last N tool calls and look for cycles (tool A → tool B → tool A). The task may need a planning step before execution.
3. If tokens: check which step consumed the most tokens. Often it's a retrieval call that returned a very long document.
4. If iterations without repetition: the task goal may be ambiguous. Review the system prompt for termination criteria.
5. Consider increasing the limit only after ruling out genuine stuck behavior — a loop guard that fires is usually telling you something real about the task structure.

---

## Tension Between Patterns

**Injection threshold vs. false positive rate.** A lower threshold (0.5) catches more attacks but may reject legitimate instructions that pattern-match to injection syntax. A higher threshold (0.85) misses more attacks. I'd run a week of logging at 0.7 before hardening to 0.6 — the distribution of scores tells you where legitimate traffic clusters vs. attack traffic.

**Loop guard iteration count vs. task complexity.** There's no universal right number. A simple QA agent might never legitimately need more than 5 iterations; a research agent might need 40. Rather than a global max, I'd set per-task-type limits and track them separately. The loop guard's job is to catch runaway behavior, not to cap sophisticated tasks.

**Tool validator retry cost.** Each validation failure that triggers a retry adds a full LLM round-trip — at 1–2 seconds per call, two retries can add 4 seconds to p99 latency. If retry rate climbs above 5%, fix the tool definitions before increasing `maxRetries`. The retry is a signal that the model and the schema are out of alignment.

---

## Related Recipes

- [Resilience Stack](./resilience-stack.md) — retry and circuit breaker for the provider calls that happen inside the agent loop
- [Safe Prompt Iteration](./safe-prompt-iteration.md) — how to safely evolve the agent's system prompt over time
- [Cost Control Stack](./cost-control-stack.md) — model routing within the agent loop to reduce per-step cost

# Integration Guide: Agent Systems

> **Part of [Production LLM Patterns](../../README.md).** This guide shows which patterns to combine for agent systems, in what order to adopt them, and how they wire together in practice.

An agent system is a loop: the LLM observes state, decides to call a tool, uses the tool's result to update state, and repeats until it decides it's done. That autonomy is what makes agents powerful — and what makes them genuinely difficult to operate in production.

The way I think about agent systems in production: you're building a control system for a non-deterministic actor that can take real-world side effects. Every tool call is a potential write — to a database, an API, an inbox. Every loop iteration costs tokens and time — typically 2–8K tokens and 1–5s per step depending on context size and model. The failure modes aren't "the API returned 500"; they're "the agent spent `$47` on a task that should have cost `$0.40`" or "the agent completed successfully but corrupted state at step 6 of 9."

What that means for pattern selection: agent systems are the system type with the most Critical-rated patterns. The control and observability concerns are higher here than in any other system type. Four patterns are genuinely load-bearing — if they're absent, the system can fail in ways that look like success until something downstream breaks.

---

## Pattern Priority for Agents

These designations come from the [Navigation Matrix](../../README.md#navigation-matrix). The way I'd read this table: **Critical** goes in before launch, **Required** should be in place before you're comfortable being paged, **High ROI** pays back quickly once the foundation is solid.

| Pattern                                                                                    | Priority        | Why for Agents                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Agent Loop Guards](../../patterns/orchestration/agent-loop-guards/)                       | **Critical**    | Without turn and token budgets plus convergence detection, a stuck agent burns the full budget before halting. A single runaway session can cost 50–100× a normal session (e.g., a 3-step task that loops 200× before hitting a budget cap burns ~67× the tokens of a normal run).                                                  |
| [Tool Call Reliability](../../patterns/orchestration/tool-call-reliability/)               | **Critical**    | Every agent action is a tool call. Parse failures, wrong argument types, and hallucinated function names all produce failed actions — and failures mid-chain discard all prior work.                                        |
| [Structured Output Validation](../../patterns/safety/structured-output-validation/)        | **Critical**    | Agents produce structured output at every reasoning step: tool selection, argument construction, plan updates. A malformed response at step 3 of a 10-step task corrupts everything downstream.                             |
| [Prompt Injection Defense](../../patterns/safety/prompt-injection-defense/)                | **Critical**    | An injected instruction can trigger tool calls with real-world consequences — sending emails, writing to databases, executing code. The blast radius scales with what tools the agent can access.                           |
| [Structured Tracing](../../patterns/observability/structured-tracing/)                     | **Critical**    | Agent executions are non-deterministic and multi-step. Without span-level traces covering tool calls, reasoning chains, and branching decisions, debugging a wrong outcome is nearly impossible.                            |
| [Multi-Agent Routing](../../patterns/orchestration/multi-agent-routing/)                   | **Critical**    | For systems with multiple specialized agents: a misrouted request doesn't error — it runs in the wrong agent and produces a confidently wrong answer. Worse if that agent has write access.                                 |
| [Adversarial Inputs](../../patterns/testing/adversarial-inputs/)                           | **Critical**    | Agent systems have a broad attack surface: tool calls, context manipulation, instruction hijacking. Standard test cases don't cover adversarial patterns.                                                                   |
| [Retry with Budget](../../patterns/resilience/retry-with-budget/)                          | **Required**    | Agent loops hit provider rate limits and timeouts. Unbounded retries turn transient errors into runaway loops. Budget-bounded retry is the minimum viable resilience layer.                                                 |
| [Circuit Breaker](../../patterns/resilience/circuit-breaker/)                              | **Required**    | When a downstream tool or provider is degraded, an agent without circuit breaking will exhaust its turn budget waiting for timeouts. Each failed tool call consumes turns and tokens.                                       |
| [Graceful Degradation](../../patterns/resilience/graceful-degradation/)                    | **Required**    | When a critical tool becomes unavailable, the agent needs a defined fallback — reduce scope, surface a partial result, or exit cleanly. Without this, the agent oscillates until it hits a hard cap.                        |
| [Token Budget Middleware](../../patterns/cost-control/token-budget-middleware/)            | **Required**    | Agent context windows grow with each turn. Without token budgeting, long-running tasks accumulate context until the window saturates and the agent starts losing earlier reasoning.                                         |
| [Context Management](../../patterns/data-pipeline/context-management/)                     | **Required**    | Multi-turn agents accumulate history that eventually exceeds the context limit. Context management preserves critical state (system prompt, task definition) while compressing stale history.                               |
| [State Checkpointing](../../patterns/orchestration/state-checkpointing/)                   | **Required**    | A failure at step 8 of a 10-step agent task means restarting from step 1 and paying for steps 1–7 again. Checkpointing creates recovery boundaries so retries start from the last good state.                               |
| [Concurrent Request Management](../../patterns/performance/concurrent-request-management/) | **Required**    | Agents that fan out tool calls in parallel create burst load. Without concurrency management, parallel tool calls spike rate limits and cause cascading timeouts.                                                           |
| [Eval Harness](../../patterns/testing/eval-harness/)                                       | **Required**    | Agent quality can't be verified with unit tests on code — success depends on multi-step reasoning paths that vary per run. An eval harness that scores task completion, tool selection, and output quality is the baseline. |
| [Regression Testing](../../patterns/testing/regression-testing/)                           | **Required**    | Every prompt change, tool definition update, or model version change is a regression risk. Agent tasks are end-to-end and non-deterministic — only eval-based regression testing catches behavioral changes.                |
| [Prompt Rollout Testing](../../patterns/testing/prompt-rollout-testing/)                   | **Required**    | Agent prompts are load-bearing. A new system prompt can change tool selection behavior, output format, and reasoning style. Rolling out to 5% of traffic first prevents surprises from reaching all users.                  |
| [Prompt Version Registry](../../patterns/observability/prompt-version-registry/)           | **Required**    | Agent system prompts change frequently. Without versioning, you can't correlate a behavior change to the prompt update that caused it.                                                                                      |
| [Output Quality Monitoring](../../patterns/observability/output-quality-monitoring/)       | **Required**    | Agent quality degrades silently — the system returns responses, but they're wrong in ways that don't trigger errors. Monitoring scores task completion and output quality on production traffic.                            |
| [Online Eval Monitoring](../../patterns/observability/online-eval-monitoring/)             | **Required**    | CI evals cover scripted test cases. Production agents encounter long-tail inputs that test suites miss. Online monitoring scores a sample of real traffic against quality criteria.                                         |
| [PII Detection](../../patterns/safety/pii-detection/)                                      | **Required**    | Agents read from and write to external systems. PII from retrieved context can appear in outputs and be passed to tools — creating exposure paths that didn't exist in simple generation systems.                           |
| [Human-in-the-Loop](../../patterns/safety/human-in-the-loop/)                              | **Required**    | For actions with irreversible consequences (deletions, external API calls, large financial transactions), routing to human review before execution is the right tradeoff.                                                   |
| [Multi-Provider Failover](../../patterns/resilience/multi-provider-failover/)              | **High ROI**    | Provider outages during long-running agent tasks mean losing everything completed so far. Failover to a secondary provider mid-task preserves work in progress.                                                             |
| [Model Routing](../../patterns/cost-control/model-routing/)                                | **High ROI**    | Agents mix tasks: complex reasoning steps need a capable model; simple tool call parsing doesn't. Routing cheap steps to a lightweight model can halve generation costs without quality loss.                               |
| [Latency Budget](../../patterns/performance/latency-budget/)                               | **Recommended** | For user-facing agents (conversational assistants, coding tools), per-turn latency budgets prevent the agent from spending 10 seconds on a turn that should take 2.                                                         |
| [Drift Detection](../../patterns/observability/drift-detection/)                           | **Recommended** | Agent behavior drifts as usage patterns evolve, prompts change, and models update. Drift detection surfaces changes in output distribution before they become user-visible problems.                                        |
| [Prompt Diffing](../../patterns/observability/prompt-diffing/)                             | **Recommended** | Agent prompts are complex and inter-dependent. Diffing lets you see exactly what changed between prompt versions and correlate behavioral changes to specific edits.                                                        |
| [Snapshot Testing](../../patterns/testing/snapshot-testing/)                               | **Recommended** | Catches unexpected changes in output format across prompt or model version changes. Useful when downstream consumers parse agent outputs programmatically.                                                                  |
| [Cost Dashboard](../../patterns/cost-control/cost-dashboard/)                              | **Recommended** | Once token budget middleware is in place, a dashboard makes per-session and per-task costs visible. Especially useful when multiple agent types have different cost profiles.                                               |

---

## System Architecture

An agent system has two primary loops: the **task execution loop** (per request) and the **quality/safety layer** (per step). Both need distinct pattern coverage.

```
  User Request
       │
       ▼
┌─────────────────────────────────────────────────────────────────────┐
│  A. Input Guard Layer                                               │
│     1. Prompt Injection Defense — scan input + retrieved context   │
│     2. PII Detection — flag/redact PII before it enters context    │
│     3. Token Budget — initialize session budget                    │
└─────────────────────────┬───────────────────────────────────────────┘
                          │ clean input
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  B. Routing Layer (multi-agent systems only)                        │
│     Multi-Agent Routing — classify request                         │
│     → confidence ≥ θ: dispatch to specialized agent               │
│     → confidence < θ: fallback to generalist agent                │
└─────────────────────────┬───────────────────────────────────────────┘
                          │ agent assigned
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  C. Agent Execution Loop                                            │
│                                                                     │
│  ┌─────────────────────────────────────────────────┐               │
│  │  Turn N                                         │               │
│  │   1. Budget Gate (Agent Loop Guards)            │               │
│  │      turns < max? tokens < max? converging?     │               │
│  │   2. Context Assembly (Context Management)      │               │
│  │      compress stale history, pin system prompt  │               │
│  │   3. LLM Call (Prompt Version Registry: versioned prompt)       │
│  │   4. Tool Call Validator (Tool Call Reliability)│               │
│  │      allowlist check → schema validate → repair │               │
│  │   5. Tool Execution                             │               │
│  │      (Retry w/ Budget: transient failures)      │               │
│  │      (Circuit Breaker: degraded tools)          │               │
│  │   6. Checkpoint (State Checkpointing)           │               │
│  │      persist step output before next turn       │               │
│  └────────────────────────┬────────────────────────┘               │
│                            │ loop until done or halted             │
└─────────────────────────────────────────────────────────────────────┘
                          │ agent result
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  D. Output Layer                                                    │
│     1. Structured Output Validation — parse + validate final result│
│     2. PII Detection (output) — scan output before returning       │
│     3. Human-in-the-Loop — route to review if action is high-stakes│
└─────────────────────────┬───────────────────────────────────────────┘
                          │ validated response
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  E. Observability (Side Channel)                                   │
│     Structured Tracing — full span tree: each turn + each tool call │
│     Output Quality Monitoring — score task completion + faithfulness│
│     Token Budget Middleware — record actual spend vs. budget        │
│     Agent Loop Guards — record turns, halt reason, convergence score│
└─────────────────────────────────────────────────────────────────────┘
                          │
                          ▼
                   Result + Audit Log
```

---

## Adoption Sequence

The way I'd sequence these: start with what keeps the agent bounded (control layer), then add what makes it safe (safety layer), then visibility (observability), then quality measurement (testing), then recovery (resilience), then optimization. The control layer is load-bearing — I wouldn't ship without it regardless of how simple the agent is.

### Phase 1 — Control Layer (Before First Deployment)

These three patterns are the difference between a demo and something you'd put in production. None of them are optional if the agent runs autonomously.

1. **[Agent Loop Guards](../../patterns/orchestration/agent-loop-guards/)** — Set explicit turn budgets, token budgets, and repetition detection before the agent touches production traffic. The default "trust the model to stop" is not a production strategy. Start conservative: 10 turns, $0.50/session. You can increase later.
2. **[Tool Call Reliability](../../patterns/orchestration/tool-call-reliability/)** — Wrap every tool call dispatch in schema validation with error-context retry. Don't let malformed tool calls silently fail or silently corrupt state. Set up an allowlist of valid tool names; reject anything outside it.
3. **[Structured Output Validation](../../patterns/safety/structured-output-validation/)** — Add output parsing and repair at every point where the agent produces structured output: tool arguments, task plans, final results. The agent's reasoning chain is structured output all the way down.

**What you have:** The agent can't run forever, tool calls are validated before execution, and structured outputs are caught and repaired. The core loop is bounded.

### Phase 2 — Safety Baseline (Before Exposing to Real Users or Real Tools)

4. **[Prompt Injection Defense](../../patterns/safety/prompt-injection-defense/)** — Add injection scanning to both user input and any context the agent retrieves from external sources. An agent reading from emails, web pages, or documents has an indirect injection surface that's often larger than the direct one.
5. **[PII Detection](../../patterns/safety/pii-detection/)** — Add PII detection to both the input path and the output path. Agents that retrieve from external systems or write to external APIs can inadvertently forward PII in ways that simpler systems can't.
6. **[Human-in-the-Loop](../../patterns/safety/human-in-the-loop/)** — Define which tool calls require human confirmation before execution: deletions, sends, financial operations, any action that's hard to reverse. Build the routing logic before the agent has write access to anything real.

**What you have:** The agent is safe to run against real users and real tools. The attack surface is defended and irreversible actions have a confirmation gate.

### Phase 3 — Observability Foundation (First Week of Production)

7. **[Structured Tracing](../../patterns/observability/structured-tracing/)** — Instrument every turn: each LLM call, each tool call, each validation step. You'll need this on the first production issue — "the agent did something wrong" without spans is a debugging nightmare. Record tool names, argument schemas, and validation outcomes as span attributes.
8. **[Token Budget Middleware](../../patterns/cost-control/token-budget-middleware/)** — Set per-session and per-task budgets. Track actual spend per turn. Without this, cost anomalies are invisible until the billing statement arrives.
9. **[Context Management](../../patterns/data-pipeline/context-management/)** — Add context window management early. Agent contexts grow with each turn; without active management, long-running tasks will eventually saturate the window and start losing the system prompt.

**What you have:** Every agent execution is traceable, costs are bounded per session, and context windows don't silently corrupt the agent's behavior on long tasks.

### Phase 4 — Resilience (Month 1)

10. **[State Checkpointing](../../patterns/orchestration/state-checkpointing/)** — Persist the checkpoint after each turn completes. A provider timeout at turn 8 of 10 shouldn't mean starting over. Set the checkpoint granularity to match the cost of re-running a single step.
11. **[Retry with Budget](../../patterns/resilience/retry-with-budget/)** — Add bounded retries on tool calls and LLM calls. Transient rate limits and provider errors are common in long-running agent sessions. Without budgets, a retry cascade at turn 5 can exceed the per-session cost limit.
12. **[Circuit Breaker](../../patterns/resilience/circuit-breaker/)** — When a downstream tool or API is degraded, an agent without a circuit breaker will timeout on every call and exhaust its turn budget waiting. Open the circuit and fail fast when error rates exceed threshold.
13. **[Graceful Degradation](../../patterns/resilience/graceful-degradation/)** — Define the fallback for each failure mode: tool unavailable → reduce task scope; LLM provider down → return partial result; budget exhausted → surface completed steps. "I can't complete this" is a valid output if it includes what was accomplished.
14. **[Concurrent Request Management](../../patterns/performance/concurrent-request-management/)** — If the agent fans out tool calls in parallel (common in research agents, multi-step pipelines), add concurrency limits. Unmanaged fan-out spikes rate limits and causes cascading timeouts under load.

**What you have:** The agent handles the expected failure modes: transient errors are retried, degraded dependencies fail fast, sessions resume after interruption, and parallel tool calls don't cascade into rate limit storms.

### Phase 5 — Quality Measurement (Month 1–2)

15. **[Eval Harness](../../patterns/testing/eval-harness/)** — Build a curated task set covering your agent's core capabilities: 30–50 tasks across domains, with scoring criteria for each. Task completion rate, tool selection accuracy, and output quality are the three dimensions worth tracking from the start.
16. **[Prompt Version Registry](../../patterns/observability/prompt-version-registry/)** — Version every prompt change. Agent system prompts are complex — a single clause change can alter tool selection behavior across all tasks. Without versioning, you can't correlate a behavior regression to the prompt update that caused it.
17. **[Regression Testing](../../patterns/testing/regression-testing/)** — Run the eval harness on every prompt change, tool definition update, and model version change. Agent quality is non-monotonic — improvements in complex reasoning often degrade simple tasks.
18. **[Output Quality Monitoring](../../patterns/observability/output-quality-monitoring/)** — Score production executions for task completion quality. The eval harness covers curated cases; production scores everything. The gap between the two is where the reliability risks live.
19. **[Online Eval Monitoring](../../patterns/observability/online-eval-monitoring/)** — Sample and score live traffic. Agent systems encounter long-tail inputs in production that no test suite anticipates. Online monitoring catches quality degradation before user complaints surface it.

**What you have:** Behavioral changes are detectable before they reach users. The eval harness provides a quality baseline; production monitoring tracks deviation from that baseline over time.

### Phase 6 — Safe Evolution (Month 2+)

20. **[Prompt Rollout Testing](../../patterns/testing/prompt-rollout-testing/)** — Route a small fraction of production traffic to the new prompt before full rollout. Agent prompt changes have system-wide behavioral effects — a 5% canary catches regressions before they hit everyone.
21. **[Adversarial Inputs](../../patterns/testing/adversarial-inputs/)** — Build adversarial test cases covering your specific threat model: injection payloads in tool results, tool call hijacking attempts, context manipulation inputs. These are hard to anticipate without dedicated testing effort.
22. **[Multi-Agent Routing](../../patterns/orchestration/multi-agent-routing/)** — If the system is growing to multiple specialized agents, add routing logic with confidence scoring and a fallback path. A generalist fallback prevents misroutes from producing silent wrong answers.

### Phase 7 — Optimization (Quarter 1+)

23. **[Model Routing](../../patterns/cost-control/model-routing/)** — Once quality monitoring and an eval set are in place, route simpler reasoning steps to a lighter model. Agents mix task types: complex planning needs a capable model; simple tool call parsing and argument extraction often doesn't. The hard part is calibrating what "simple" means — use the eval set.
24. **[Multi-Provider Failover](../../patterns/resilience/multi-provider-failover/)** — Once you've experienced provider outages during long-running sessions, add failover. The complexity isn't worth it early; after one expensive mid-task outage, the tradeoff calculus changes.

---

## Wiring Guide

These snippets show how the core patterns compose. They use the actual implementations from this repo.

### TypeScript: Per-Turn Execution Loop

```typescript
import { AgentLoopGuards } from "../../patterns/orchestration/agent-loop-guards/src/ts/index.js";
import { ToolCallValidator } from "../../patterns/orchestration/tool-call-reliability/src/ts/index.js";
import { OutputValidator } from "../../patterns/safety/structured-output-validation/src/ts/index.js";
import { ContextManager } from "../../patterns/data-pipeline/context-management/src/ts/index.js";
import { CheckpointManager } from "../../patterns/orchestration/state-checkpointing/src/ts/index.js";
import { Tracer } from "../../patterns/observability/structured-tracing/src/ts/index.js";
import { RetryBudget } from "../../patterns/resilience/retry-with-budget/src/ts/index.js";
import { InjectionDefense } from "../../patterns/safety/prompt-injection-defense/src/ts/index.js";

// Wire up once at startup
const guards = new AgentLoopGuards({
  maxTurns: 20,
  maxTokens: 50_000, // per-session ceiling
  repetitionWindow: 3 // halt if last 3 tool calls are identical
});

const toolValidator = new ToolCallValidator({
  allowedTools: TOOL_REGISTRY.names(),
  maxRetries: 2
});

const outputValidator = new OutputValidator({ maxRetries: 2 });

const contextManager = new ContextManager({
  maxTokens: 40_000, // leave 10K headroom for output
  preserveSystemPrompt: true,
  summaryModel: "claude-haiku-4-5" // lightweight model for compression
});

const checkpoints = new CheckpointManager(db, { ttl: 3600 });
const tracer = new Tracer({ serviceName: "agent-service" });
const retryBudget = new RetryBudget({ maxAttempts: 3, budgetTokens: 5_000 });
const injectionDefense = new InjectionDefense({ threshold: 0.8 });

async function runAgentTask(
  taskId: string,
  userInput: string
): Promise<AgentResult> {
  const rootSpan = tracer.startSpan("agent.task", { taskId });

  // 1. Scan input for injection before it enters context
  const inputScan = injectionDefense.scan(userInput);
  if (inputScan.flagged) {
    rootSpan.setAttributes({ "security.injection_blocked": true });
    throw new InjectionBlockedError(inputScan.reason);
  }

  // 2. Load checkpoint if this task was interrupted
  const state =
    (await checkpoints.load(taskId)) ?? AgentState.initial(userInput);
  const messages = contextManager.restore(state.messages);

  try {
    while (!guards.isDone(state)) {
      const turnSpan = tracer.startSpan(
        "agent.turn",
        { turn: state.turnCount },
        rootSpan
      );

      // 3. Check budgets before every turn
      guards.checkBudget(state); // throws BudgetExhaustedError if over limit

      // 4. Compress context if approaching limit
      const fittedMessages = await contextManager.fitToWindow(messages);

      // 5. LLM call with retry budget
      const llmResponse = await retryBudget.execute(() =>
        llmProvider.chat(fittedMessages, VERSIONED_SYSTEM_PROMPT)
      );

      // 6. Validate and execute tool call (if any)
      if (llmResponse.toolCall) {
        const validatedCall = await toolValidator.validate(
          llmResponse.toolCall
        );
        turnSpan.setAttributes({
          "tool.name": validatedCall.name,
          "tool.validation_attempts": validatedCall.attempts
        });

        const toolResult = await TOOL_REGISTRY.execute(validatedCall);
        messages.push({ role: "tool", content: toolResult });
      }

      // 7. Checkpoint after each successful turn
      await checkpoints.save(taskId, {
        messages,
        turnCount: state.turnCount + 1
      });

      state.advance(llmResponse);
      turnSpan.end();
    }

    // 8. Validate final output structure
    const validated = await outputValidator.validate(
      state.finalOutput,
      AgentResultSchema
    );
    rootSpan.setAttributes({
      "task.turns": state.turnCount,
      "task.success": true
    });
    return validated.data;
  } catch (err) {
    rootSpan.recordError(err);
    throw err;
  } finally {
    rootSpan.end();
  }
}
```

### TypeScript: Multi-Agent Routing + Human-in-the-Loop

```typescript
import { AgentRouter } from "../../patterns/orchestration/multi-agent-routing/src/ts/index.js";
import { HumanReviewGate } from "../../patterns/safety/human-in-the-loop/src/ts/index.js";

const router = new AgentRouter({
  agents: AGENT_REGISTRY,
  confidenceThreshold: 0.85,
  fallbackAgent: "generalist"
});

const humanGate = new HumanReviewGate({
  // Actions that require human confirmation before execution
  highStakesPredicate: (toolCall) =>
    HIGH_STAKES_TOOLS.includes(toolCall.name) ||
    (toolCall.name === "api_call" && toolCall.args.method !== "GET"),
  timeoutMs: 300_000, // 5-minute review window
  timeoutBehavior: "reject" // fail safe: reject if reviewer doesn't respond
});

async function handleAgentRequest(request: UserRequest): Promise<AgentResult> {
  // 1. Route to the right agent
  const { agentId, confidence, fallback } = await router.classify(request);
  logger.info("agent.routed", { agentId, confidence, fallback });

  const agent = AGENT_REGISTRY.get(agentId);

  // 2. Run the agent with human-in-the-loop on high-stakes tools
  return agent.run(request, {
    beforeToolExecution: async (toolCall) => {
      const review = await humanGate.check(toolCall);
      if (!review.approved) {
        throw new ToolExecutionBlockedError(toolCall.name, review.reason);
      }
    }
  });
}
```

### Python: Per-Turn Execution Loop

```python
from patterns.orchestration.agent_loop_guards.src.py import AgentLoopGuards, LoopGuardConfig
from patterns.orchestration.tool_call_reliability.src.py import ToolCallValidator, ValidatorConfig
from patterns.safety.structured_output_validation.src.py import OutputValidator
from patterns.data_pipeline.context_management.src.py import ContextManager, ContextConfig
from patterns.orchestration.state_checkpointing.src.py import CheckpointManager
from patterns.observability.structured_tracing.src.py import Tracer
from patterns.resilience.retry_with_budget.src.py import RetryBudget, RetryConfig
from patterns.safety.prompt_injection_defense.src.py import InjectionDefense

# Wire up at startup
guards = AgentLoopGuards(LoopGuardConfig(
    max_turns=20,
    max_tokens=50_000,
    repetition_window=3,
))

tool_validator = ToolCallValidator(ValidatorConfig(
    allowed_tools=TOOL_REGISTRY.names(),
    max_retries=2,
))

output_validator = OutputValidator(max_retries=2)

context_manager = ContextManager(ContextConfig(
    max_tokens=40_000,
    preserve_system_prompt=True,
    summary_model="claude-haiku-4-5",
))

checkpoints = CheckpointManager(db, ttl=3600)
tracer = Tracer(service_name="agent-service")
retry_budget = RetryBudget(RetryConfig(max_attempts=3, budget_tokens=5_000))
injection_defense = InjectionDefense(threshold=0.8)


async def run_agent_task(task_id: str, user_input: str) -> AgentResult:
    with tracer.span("agent.task", task_id=task_id) as root_span:
        # 1. Scan input for injection
        scan = injection_defense.scan(user_input)
        if scan.flagged:
            root_span.set_attributes(injection_blocked=True)
            raise InjectionBlockedError(scan.reason)

        # 2. Load checkpoint if interrupted
        state = await checkpoints.load(task_id) or AgentState.initial(user_input)
        messages = context_manager.restore(state.messages)

        while not guards.is_done(state):
            with tracer.span("agent.turn", turn=state.turn_count, parent=root_span) as turn_span:
                # 3. Check budgets before every turn
                guards.check_budget(state)  # raises BudgetExhaustedError if over

                # 4. Compress context if needed
                fitted_messages = await context_manager.fit_to_window(messages)

                # 5. LLM call with retry budget
                llm_response = await retry_budget.execute(
                    lambda: llm_provider.chat(fitted_messages, VERSIONED_SYSTEM_PROMPT)
                )

                # 6. Validate and execute tool call
                if llm_response.tool_call:
                    validated_call = await tool_validator.validate(llm_response.tool_call)
                    turn_span.set_attributes(
                        tool_name=validated_call.name,
                        validation_attempts=validated_call.attempts,
                    )

                    tool_result = await TOOL_REGISTRY.execute(validated_call)
                    messages.append({"role": "tool", "content": tool_result})

                # 7. Checkpoint after successful turn
                await checkpoints.save(task_id, {
                    "messages": messages,
                    "turn_count": state.turn_count + 1,
                })

                state.advance(llm_response)

        # 8. Validate final output
        validated = await output_validator.validate(state.final_output, AgentResultSchema)
        root_span.set_attributes(turns=state.turn_count, success=True)
        return validated.data
```

### Python: Multi-Agent Routing

```python
from patterns.orchestration.multi_agent_routing.src.py import AgentRouter, RouterConfig
from patterns.safety.human_in_the_loop.src.py import HumanReviewGate, GateConfig

router = AgentRouter(RouterConfig(
    agents=AGENT_REGISTRY,
    confidence_threshold=0.85,
    fallback_agent="generalist",
))

human_gate = HumanReviewGate(GateConfig(
    high_stakes_predicate=lambda tc: (
        tc.name in HIGH_STAKES_TOOLS or
        (tc.name == "api_call" and tc.args.get("method") != "GET")
    ),
    timeout_ms=300_000,
    timeout_behavior="reject",  # fail safe
))


async def handle_agent_request(request: UserRequest) -> AgentResult:
    # 1. Route to the right agent
    route = await router.classify(request)
    logger.info("agent.routed", agent_id=route.agent_id, confidence=route.confidence)

    agent = AGENT_REGISTRY.get(route.agent_id)

    # 2. Run with human review on high-stakes actions
    return await agent.run(
        request,
        before_tool_execution=human_gate.check,
    )
```

---

## Tradeoffs

### What to skip early

**Multi-Agent Routing** — if you have one general-purpose agent, there's nothing to route. Add routing when you have two or more specialized agents with distinct capabilities and a measurable misroute problem.

**Model Routing** — routing decisions require quality signal to calibrate. Without output quality monitoring already running, you can't verify that simple steps are being handled well by the cheaper model. Add this after quality monitoring is in place.

**Multi-Provider Failover** — the added complexity (second provider contract, different tool support across providers, context migration during failover) isn't worth it until you've experienced provider outages and know their actual frequency and duration in your context. The first outage will change the calculus.

**Drift Detection** — high-value once the system is stable and you have a quality monitoring baseline to compare against. Early on, direct quality monitoring and regression testing catch the signal drift detection would find.

**Semantic Caching** — agents rarely benefit. Each turn's prompt includes accumulated history and tool results, so prompts are effectively unique and cache hit rates stay near zero. Skip unless you have a narrow sub-workflow with genuinely repeated inputs.

**Adversarial Inputs testing** — building adversarial test cases requires understanding your actual threat model and attack surface. Skip until the system is stable and injection defense is in place to defend against what you find.

### What to add at scale

**State Checkpointing granularity** — early on, checkpoint per-task is sufficient. At scale with long-running complex agents, sub-task checkpointing (checkpoint after each major reasoning phase, not just after each tool call) becomes important. The cost of re-running three tool calls is different from the cost of re-running 30.

**Eval harness depth** — start with completion scoring ("did the agent finish the task?"). As the system matures and you understand failure modes, add more granular dimensions: tool selection accuracy, intermediate step quality, context handling. Deeper evals are harder to build and maintain; add depth as you identify the failure modes that simple completion scoring misses.

**Circuit Breaker per-tool** — at low request volumes, a single circuit breaker covering all tool calls is fine. At 10K+ sessions/day, a degraded tool (slow search API, rate-limited database) causes widespread timeout cascades. Per-tool circuit breakers let you degrade gracefully on one dependency without affecting agents that don't use it.

### Where patterns create tension

**Agent Loop Guards vs. Long-Running Tasks.** Setting a tight turn budget protects against runaway sessions but can prematurely terminate legitimate long-running work. The right budget depends on your actual task distribution — sample 100 production sessions and measure p95 turn count before setting the production cap. I'd start at 2–3× the p95 and tighten if you see the budget being used as a crutch rather than a safety net.

**State Checkpointing vs. Idempotency.** Resuming from a checkpoint assumes that re-running a tool call from a checkpoint is safe. If tool calls have side effects (API writes, emails sent), resuming can produce duplicates. The mitigation is idempotency keys — pass a deterministic key per tool call so the downstream service can deduplicate. This needs to be designed in from the start, not retrofitted.

**Context Management vs. Long-Task Quality.** Compressing context history to fit the window loses information. For short-term tasks (under 10 turns), this rarely matters. For long-running research or analysis tasks (30+ turns), aggressive compression can cause the agent to forget constraints it established in early turns. The solution is a two-tier context: a pinned region for critical constraints that's never compressed, and a managed region for working history.

**Human-in-the-Loop vs. Latency.** Routing to human review adds significant latency to any action it intercepts. The right threshold isn't "all sensitive actions" but "actions where the cost of a mistake exceeds the cost of human review time." A delete operation that's recoverable in 5 minutes doesn't warrant the same review gate as an external API call that can't be undone.

**Output Quality Monitoring vs. Latency.** Scoring agent outputs with an LLM judge (the most reliable quality signal) adds latency. Keep this out of the critical path — score asynchronously after the response is returned, not inline. If you need synchronous quality gating, use a faster heuristic (output length, keyword checks, schema validation) rather than a full LLM judge.

---

## Related Guides

- [RAG Systems Integration Guide](../rag/) — many production agent systems use retrieval to ground their reasoning. If your agent retrieves from a document corpus, check the RAG guide for the additional data pipeline patterns that apply.
- [Multi-Agent Systems Integration Guide](../multi-agent/) — for systems with multiple specialized agents, coordination patterns, and delegation chains.
- [Batch Systems Integration Guide](../batch/) — if your agents run as offline batch jobs (nightly data processing, bulk document analysis), the Batch guide covers the additional cost and recovery patterns relevant there.

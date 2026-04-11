# Integration Guide: Multi-Agent Systems

> **Part of [Production LLM Patterns](../../README.md).** This guide shows which patterns to combine for multi-agent systems, in what order to adopt them, and how they wire together in practice. For single-agent systems (one agent, many tools), start with the [Agent Systems guide](../agents/) first.

A multi-agent system coordinates multiple specialized agents: an orchestrator that decomposes work, sub-agents that execute subtasks, and a layer that aggregates results. The parallel structure is the whole point — it's what enables research or analysis that would exceed a single context window or take too long sequentially. [Anthropic's production multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) showed 90.2% performance improvement over single-agent Opus on complex queries, with parallel execution cutting research time by up to 90%.

The way I think about multi-agent systems in production: the complexity isn't in any single agent — it's in the boundaries between them. Each agent-to-agent handoff is a trust boundary, a potential injection surface, and a failure propagation point. A [2025 study of 1,600+ production traces across seven multi-agent frameworks](https://arxiv.org/abs/2503.13657) found three major failure clusters: specification failures (~42%), inter-agent misalignment (~37%), and verification gaps (~21%). The agents individually work fine; the coordination layer is where systems break.

What makes multi-agent different from single-agent isn't the agents — it's error amplification. A 5-step orchestration chain where each step has 90% reliability has only 59% end-to-end success (0.9⁵, assuming independent failures — correlated failure modes from shared context or a shared model can shift this in either direction). Sub-agent outputs feed back into the orchestrator context, meaning a bad result at step 2 corrupts everything downstream. Prompt injections planted in content that one agent processes can traverse to the next agent through the handoff — what researchers call chain propagation depth (CPD). When CPD > 1, an attacker who can reach any agent in the system can potentially reach agents with higher privileges. And multi-agent systems consume [~15× more tokens than single-turn chat](https://www.anthropic.com/engineering/multi-agent-research-system) — the figure Anthropic reported for their research workload, with the actual multiplier shifting based on how much parallelism and iteration the task requires — so a misrouted or corrupted execution isn't just wrong, it's expensive.

What that means for pattern selection: multi-agent systems need everything single-agent systems need, plus a coordination layer built around contracts, trust boundaries, and aggregation. The patterns that matter most are the ones that keep the orchestration structure from amplifying failures.

---

## Pattern Priority for Multi-Agent Systems

Multi-agent systems are a specialization of the **Agents** system type in the [Navigation Matrix](../../README.md#navigation-matrix). All patterns marked Critical or Required for agents apply here. This table adds multi-agent specific reasoning — the "why" changes when multiple agents are coordinating, even if the pattern is the same.

### Critical — absence lets failures amplify across the agent chain

| Pattern | Why for Multi-Agent |
|---------|-------------------|
| [Multi-Agent Routing](../../patterns/orchestration/multi-agent-routing/) | The coordination backbone. Without reliable routing, requests reach the wrong specialized agent and produce confidently wrong results — no error signal, just incorrect outputs. A misrouted classification in a 10-agent system doesn't affect one step; it triggers the wrong downstream chain. |
| [Structured Output Validation](../../patterns/safety/structured-output-validation/) | Sub-agents communicate through structured outputs (task plans, intermediate results, tool call arguments). A malformed output from sub-agent A becomes corrupted input to sub-agent B. At step 3 of a 10-step orchestration chain, a bad parse corrupts everything downstream. Define schemas at every agent-to-agent boundary. |
| [Prompt Injection Defense](../../patterns/safety/prompt-injection-defense/) | Every agent that reads external content is an injection surface. What makes multi-agent systems especially vulnerable: a successful injection in a low-privilege sub-agent can propagate to the orchestrator through the task result, and from the orchestrator to every other sub-agent through context. The [confused deputy problem](https://arxiv.org/html/2601.11893v1) scales with chain depth. Scan both inputs and sub-agent outputs before they're passed up or sideways. |
| [Agent Loop Guards](../../patterns/orchestration/agent-loop-guards/) | A runaway sub-agent doesn't just exhaust its own budget — it ties up an orchestrator slot and delays every other parallel task. Set per-agent and per-task budgets independently. The orchestrator needs its own turn limit; each sub-agent needs its own. An orchestrator that spawns 50+ sub-agents for a simple query (an early failure mode in Anthropic's system) is a loop guard problem at the orchestration level. |
| [Structured Tracing](../../patterns/observability/structured-tracing/) | Multi-agent traces are distributed: each agent runs in its own execution context, potentially with its own spans. Without trace correlation (shared trace ID passed through agent boundaries), debugging a wrong final answer is nearly impossible — the failure might be in agent 3 of 8, with no signal visible at the orchestrator level. |
| [Tool Call Reliability](../../patterns/orchestration/tool-call-reliability/) | Sub-agents make tool calls on behalf of the orchestrator. A tool parse failure at sub-agent B aborts its task — and the orchestrator receives an empty or error result it may not be equipped to handle. At chain depth 3+, a silent tool failure corrupts every downstream sub-agent that depends on the result. Validate tool calls at each sub-agent boundary, not just at the orchestrator. |
| [Adversarial Inputs](../../patterns/testing/adversarial-inputs/) | Multi-agent systems have a larger attack surface than single agents: each agent boundary is an indirect injection point. Test both direct injection (malicious user input) and indirect injection (malicious content that a sub-agent retrieves and passes to the orchestrator or sideways to another sub-agent). Chain propagation is hard to discover without deliberate testing, and the failure mode — privilege escalation through a low-trust sub-agent — is a security incident, not a quality bug. |

### Required — the system runs without them, but won't stay production-grade

| Pattern | Why for Multi-Agent |
|---------|-------------------|
| [State Checkpointing](../../patterns/orchestration/state-checkpointing/) | A failure in sub-agent 7 of an 8-agent parallel fan-out shouldn't require re-running all 8. Checkpoint both the orchestrator state (which sub-tasks are complete, which are in-flight) and each sub-agent's intermediate progress. Recovery granularity should match your retry cost per sub-task. |
| [Context Management](../../patterns/data-pipeline/context-management/) | The orchestrator accumulates context from every sub-agent result. Long orchestration chains — research tasks, multi-step analysis — can saturate the orchestrator's context window before all sub-agents complete. Pin task definitions and system constraints in a non-compressible zone; compress sub-agent result summaries. |
| [Retry with Budget](../../patterns/resilience/retry-with-budget/) | Transient errors at the sub-agent level should retry the sub-task, not the whole orchestration. Budget retries per sub-task so a single flaky API call doesn't consume the entire job's retry budget. The orchestrator level needs a separate budget for coordinating retry of failed sub-tasks. |
| [Graceful Degradation](../../patterns/resilience/graceful-degradation/) | Define what happens when a sub-agent fails permanently: skip it and return a partial result, substitute a fallback agent, or surface the partial output with a clear gap indicator. An orchestrator without defined degradation semantics will either hang waiting for a failed sub-agent or produce a silently incomplete result. |
| [Token Budget Middleware](../../patterns/cost-control/token-budget-middleware/) | Multi-agent systems are the highest-cost system type: ~15× more tokens than single-turn chat. Set budgets at three levels — per-agent-invocation, per-orchestration-task, and per-user-session. Without per-invocation budgets, a single verbose sub-agent can exhaust the task budget. Without task-level budgets, a complex query can run an order of magnitude over expected cost before anyone notices. |
| [Human-in-the-Loop](../../patterns/safety/human-in-the-loop/) | In multi-agent systems, consequential actions are often taken by sub-agents acting on delegated authority from the orchestrator. The blast radius of a delegated action (a write, a send, a delete) is the same as if the user triggered it directly — but the authorization chain is longer and harder to audit. Define high-stakes predicates that route to human review regardless of which agent in the chain is about to execute the action. |
| [Eval Harness](../../patterns/testing/eval-harness/) | Multi-agent quality can't be verified by testing sub-agents in isolation — success depends on whether the orchestration produces the right final answer from the right combination of sub-task results. Build eval cases that test end-to-end orchestration quality: task decomposition accuracy, sub-agent selection, result aggregation. |
| [Regression Testing](../../patterns/testing/regression-testing/) | Prompt changes, model updates, or new sub-agents in the pool can alter routing behavior, sub-task decomposition, and result aggregation in non-obvious ways. Run end-to-end eval on every change, not just unit tests on individual agents. |
| [Prompt Version Registry](../../patterns/observability/prompt-version-registry/) | Multi-agent systems have N prompts — one per agent — that all need versioning. A routing regression is as likely to come from a sub-agent's system prompt change as from the router's. Version every agent prompt independently and track them in the registry. |
| [Output Quality Monitoring](../../patterns/observability/output-quality-monitoring/) | Multi-agent quality degrades silently: the system returns results, but the sub-task decomposition is suboptimal, the wrong agents are being invoked, or the aggregation is losing information. Monitor both final output quality and intermediate quality at each agent boundary if you have enough traffic to sample. |
| [Online Eval Monitoring](../../patterns/observability/online-eval-monitoring/) | Offline evals cover scripted orchestration scenarios. Production traffic reveals routing edge cases, novel query types, and sub-agent failure combinations that no test suite anticipates. Score a sample of real orchestrations against quality criteria. |
| [PII Detection](../../patterns/safety/pii-detection/) | Multi-agent systems pass context across agent boundaries. PII retrieved by one sub-agent can appear in the context passed to another, or in the orchestrator's aggregated result. The exposure path is longer and harder to trace than in a single-agent system. |
| [Circuit Breaker](../../patterns/resilience/circuit-breaker/) | When a downstream tool or API is degraded, sub-agents without circuit breakers will timeout on every call, tying up orchestrator slots and blocking parallel tasks. Per-tool and per-dependency circuit breakers let one degraded dependency fail fast without blocking the agents that don't use it. |
| [Prompt Rollout Testing](../../patterns/testing/prompt-rollout-testing/) | Multi-agent systems have N prompts that all affect orchestration behavior — routing classifier, orchestrator system prompt, each sub-agent system prompt. A change to any one can silently shift routing decisions and task decomposition across all orchestrations simultaneously. Canary rollout on a fraction of traffic catches regressions before they affect every task. The blast radius of a bad prompt change is larger here than in single-agent systems, which makes this a production-readiness requirement rather than a nice-to-have. |
| [Concurrent Request Management](../../patterns/performance/concurrent-request-management/) | An orchestrator that fans out to 10 sub-agents in parallel creates 10× the API load of a single request. Under production load with multiple concurrent orchestrations, unmanaged fan-out saturates provider rate limits — a single complex query can exhaust headroom for every other active orchestration. Limit concurrent sub-agent invocations per orchestration and total across all active orchestrations; without these limits, the fan-out pattern turns rate limits into a self-inflicted outage. |

### High ROI — pays back quickly once the foundation is solid

| Pattern | Why for Multi-Agent |
|---------|-------------------|
| [Model Routing](../../patterns/cost-control/model-routing/) | Different sub-agents need different capabilities. A sub-agent doing simple extraction or classification doesn't need a frontier model. An orchestrator that routes sub-task types to appropriately sized models can cut generation cost by 40–60% on workloads with mixed task complexity. Calibrate using the eval harness before deploying routing thresholds. |
| [Multi-Provider Failover](../../patterns/resilience/multi-provider-failover/) | A provider outage mid-orchestration means losing all in-flight sub-agent work. With checkpointing in place, failover lets the orchestrator resume sub-tasks on a secondary provider. Worth adding after you've experienced one provider outage that caused an orchestration to fail mid-task. |

### Recommended — solid practice once the core is in place

| Pattern | Why for Multi-Agent |
|---------|-------------------|
| [Prompt Diffing](../../patterns/observability/prompt-diffing/) | When an orchestration changes behavior between versions, the first question is which agent prompt changed. Diffing surfaces the change quickly across the pool of N agent prompts. |
| [Drift Detection](../../patterns/observability/drift-detection/) | Routing accuracy drifts as user query patterns evolve — queries that fit neatly into agent categories at launch become ambiguous as the user base grows. Drift detection surfaces when routing confidence distributions shift before misroute rates spike. |
| [Snapshot Testing](../../patterns/testing/snapshot-testing/) | Downstream consumers often parse orchestration outputs structurally. Snapshot tests catch unexpected format changes when sub-agent outputs change across prompt or model version upgrades. |
| [Latency Budget](../../patterns/performance/latency-budget/) | For user-facing multi-agent systems (research assistants, coding tools), the orchestration wall-clock time has a user-visible ceiling. A per-task latency budget forces the orchestrator to time-box sub-agent work and return a partial result rather than waiting indefinitely. |
| [Cost Dashboard](../../patterns/cost-control/cost-dashboard/) | Multi-agent costs vary dramatically by orchestration type — a 2-agent query costs far less than a 10-agent fan-out. A dashboard that breaks down cost by orchestration type, sub-agent invocation count, and task complexity makes cost anomalies visible before billing surprises arrive. |

---

## System Architecture

A multi-agent system has three structural layers: the **orchestration layer** (decompose, route, aggregate), the **execution layer** (specialized sub-agents that run in parallel or sequentially), and the **side-channel** (tracing, cost tracking, safety scanning). Failures in the execution layer that aren't handled at the boundary propagate up to the orchestration layer — which is why each agent boundary needs its own validation, not just the system edges.

```
  User Task
       │
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  A. Input Guard Layer                                                │
│     1. Prompt Injection Defense — scan task before entering context  │
│     2. PII Detection — redact before distribution to sub-agents      │
│     3. Token Budget — initialize task-level budget                   │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ clean task
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  B. Orchestrator                                                     │
│     1. Task Decomposition → sub-task definitions with schemas        │
│     2. Agent Routing (Multi-Agent Routing — classify + dispatch)     │
│     3. Agent Loop Guards — turn + token budget per orchestration     │
│     4. State Checkpoint — record completed sub-tasks                 │
└────────┬──────────────────┬───────────────────┬───────────────────── ┘
         │                  │                   │
         ▼                  ▼                   ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  Sub-Agent A │   │  Sub-Agent B │   │  Sub-Agent C │
│  (Research)  │   │  (Analysis)  │   │  (Synthesis) │
│              │   │              │   │              │
│  Loop Guards │   │  Loop Guards │   │  Loop Guards │
│  Tool Calls  │   │  Tool Calls  │   │  Tool Calls  │
│  Injection   │   │  Injection   │   │  Injection   │
│  Scan Output │   │  Scan Output │   │  Scan Output │
│  Validate    │   │  Validate    │   │  Validate    │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │                  │                   │
       └──────────────────┴───────────────────┘
                          │ sub-task results (validated at each boundary)
                          ▼
┌──────────────────────────────────────────────────────────────────────┐
│  C. Aggregation + Output Layer                                       │
│     1. Result merging — reconcile sub-task outputs                   │
│     2. Structured Output Validation — validate final structure       │
│     3. PII Detection (output) — scan before returning                │
│     4. Human-in-the-Loop — route if high-stakes delegation occurred  │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ validated result
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  D. Observability (Side Channel)                                     │
│     Structured Tracing — correlated spans per agent, with trace ID  │
│     Token Budget — per-agent and task-level spend tracking           │
│     Agent Loop Guards — turn counts, halt reasons per agent          │
│     Output Quality — score final result + key sub-task results       │
└──────────────────────────────────────────────────────────────────────┘
                           │
                           ▼
                    Result + Audit Log
```

> The trace ID must be passed through agent boundaries explicitly — it's not automatic. Each sub-agent invocation should receive the parent trace ID as a context parameter and use it to link its spans to the root orchestration span.

---

## Adoption Sequence

The way I'd sequence this: trust boundaries and control first, then observability, then resilience, then quality. The trust layer is load-bearing — without validated contracts at each agent boundary, every phase after it is built on sand.

### Phase 1 — Coordination Layer (Before First Deployment)

These four patterns define the boundary contracts between agents. Nothing else makes sense until these are in place.

1. **[Multi-Agent Routing](../../patterns/orchestration/multi-agent-routing/)** — Define the agent registry, write explicit capability descriptions with decision boundaries (not vague descriptions), set a confidence threshold, and specify a fallback. Start with two or three agents and add more only as the routing classifier can distinguish them reliably.

2. **[Structured Output Validation](../../patterns/safety/structured-output-validation/)** — Define the schema for each agent's output before writing any agent code. These schemas are the contracts — both the orchestrator and the sub-agent agree on them before deployment, not at runtime. Validate at every agent boundary: the orchestrator validates sub-task definitions before distributing, and validates sub-agent results before aggregating.

3. **[Agent Loop Guards](../../patterns/orchestration/agent-loop-guards/)** — Set turn budgets at two levels: the orchestrator level (total orchestration steps) and per-sub-agent (steps within each sub-task). An orchestrator that spawns 50 sub-agents for a query that needs 3 is a routing failure that loop guards at the orchestrator level can catch. Budget conservatively at first — you can increase limits once you know the real task distributions.

4. **[Prompt Injection Defense](../../patterns/safety/prompt-injection-defense/)** — Scan at the task input boundary AND at each sub-agent result boundary. A sub-agent that retrieves from web pages, documents, or databases is an indirect injection surface. Its output can carry injected instructions back to the orchestrator, which will then distribute them to every other sub-agent. Treat every sub-agent result as untrusted input before it enters the orchestrator's context.

**What you have:** The coordination structure is bounded — agents have schemas, routing has fallback paths, loops have budgets, and each boundary is scanned for injections.

### Phase 2 — Safety Baseline (Before Real Tools or Real Data)

5. **[PII Detection](../../patterns/safety/pii-detection/)** — Add at both the orchestrator input boundary (before distributing task context to sub-agents) and the output boundary (before returning results). A sub-agent that retrieves from external systems can surface PII that the orchestrator then includes in the result. The multi-agent handoff creates new exposure paths.

6. **[Tool Call Reliability](../../patterns/orchestration/tool-call-reliability/)** — Each sub-agent that makes tool calls needs tool call validation. A failed tool call mid-sub-task produces an empty result at the orchestrator level — no error, just silence. Validate tool call schemas at each sub-agent, log validation attempts as span attributes, and surface tool failures explicitly in the sub-task result rather than swallowing them.

7. **[Human-in-the-Loop](../../patterns/safety/human-in-the-loop/)** — Define which delegated actions require human confirmation before execution, regardless of which agent in the chain is about to execute them. This is harder to implement here than in single-agent systems because the action happens inside a sub-agent that the user never directly interacted with. The orchestrator needs to intercept before delegating high-stakes actions.

**What you have:** The multi-agent system is safe to run against real tools and real data. PII can't flow unchecked across agent boundaries, tool calls are validated, and irreversible actions have a review gate.

### Phase 3 — Observability Foundation (First Week in Production)

8. **[Structured Tracing](../../patterns/observability/structured-tracing/)** — Instrument every agent boundary: each orchestrator decision, each sub-agent invocation, each tool call. Pass the parent trace ID explicitly to each sub-agent so spans link back to the root orchestration. The first time a user reports "the system gave me a wrong answer," you'll want to know which sub-agent produced the bad intermediate result, not just that the final result was wrong.

9. **[Token Budget Middleware](../../patterns/cost-control/token-budget-middleware/)** — Set per-agent budgets, per-task budgets, and per-session budgets as three independent limits. Anthropic's own system found that early versions spawned excessive sub-agents and exhausted token budgets on parallel redundant work — and they built the system. Per-agent tracking is what makes the over-spend visible before the billing cycle.

10. **[Context Management](../../patterns/data-pipeline/context-management/)** — Add context window management at the orchestrator level first. The orchestrator accumulates results from every sub-agent — in a 10-agent fan-out with verbose results, it can saturate the context window before the final aggregation step. Pin the task definition and constraints in a non-compressible zone; summarize sub-agent results to fit.

**What you have:** Every orchestration is traceable end-to-end, costs are tracked at three granularities, and the orchestrator context won't silently corrupt on long tasks.

### Phase 4 — Resilience (Month 1)

11. **[State Checkpointing](../../patterns/orchestration/state-checkpointing/)** — Checkpoint at the orchestration level (which sub-tasks are complete) and optionally at the sub-task level (for long-running sub-agents). Determine the right granularity: if each sub-task takes 30 seconds and costs $0.50, per-sub-task checkpointing pays for itself on the first failure at sub-task 7 of 10.

12. **[Retry with Budget](../../patterns/resilience/retry-with-budget/)** — Budget retries at the sub-task level, not the orchestration level. A single flaky tool call in sub-agent B shouldn't consume the retry budget for sub-agents A and C. Implement per-sub-task retry budgets with a separate orchestration-level budget for re-dispatching failed sub-tasks.

13. **[Circuit Breaker](../../patterns/resilience/circuit-breaker/)** — Implement per-tool circuit breakers on sub-agents, not just a single system-wide breaker. A degraded search API should cause search-dependent sub-agents to fail fast — it shouldn't affect sub-agents that only use the database. Per-tool circuit breakers let the orchestrator degrade selectively: skip search-dependent tasks and complete what can still run.

14. **[Graceful Degradation](../../patterns/resilience/graceful-degradation/)** — Define degradation semantics for every failure mode: sub-agent timeout → return partial result with gap indicator; provider down → fall back to single-agent mode for simple queries; routing failure → use generalist fallback agent. An orchestrator without defined semantics for partial results will silently drop information or block indefinitely.

15. **[Concurrent Request Management](../../patterns/performance/concurrent-request-management/)** — Limit concurrent sub-agent invocations per orchestration (prevents one complex query from exhausting all provider headroom) and total concurrent sub-agents across all active orchestrations. At 100 concurrent orchestrations with 5 sub-agents each, an unmanaged fan-out creates 500 simultaneous provider requests.

**What you have:** The orchestration layer handles the expected failure modes — sub-tasks retry independently, degraded dependencies fail fast without blocking the full system, partial results are surfaced cleanly, and fan-out load is bounded.

### Phase 5 — Quality Measurement (Month 1–2)

16. **[Eval Harness](../../patterns/testing/eval-harness/)** — Build an eval set that covers end-to-end orchestration quality: does the orchestrator decompose this query correctly? Does the right sub-agent handle each sub-task? Does the aggregation produce the right final answer? Sub-agent unit evals are useful but not sufficient — the interesting failures happen at the coordination layer.

17. **[Prompt Version Registry](../../patterns/observability/prompt-version-registry/)** — Version every agent prompt independently. The orchestrator system prompt, each sub-agent system prompt, and the routing classifier prompt are all load-bearing. A routing regression is as likely to come from a sub-agent prompt change as from the router itself.

18. **[Regression Testing](../../patterns/testing/regression-testing/)** — Run end-to-end orchestration evals on every change: new sub-agent added to the pool, any prompt updated, model version changed for any agent. Multi-agent routing accuracy is non-monotonic — adding a new agent can change routing behavior for existing categories.

19. **[Output Quality Monitoring](../../patterns/observability/output-quality-monitoring/)** — Score final orchestration quality on production traffic. For systems with enough volume, also sample intermediate sub-task results from the most consequential agents. The gap between what the eval harness predicts and what production scores show is where the real failure modes live.

20. **[Online Eval Monitoring](../../patterns/observability/online-eval-monitoring/)** — Sample and score live orchestrations. Production queries are messier than curated evals — longer, more ambiguous, and more likely to fall on routing decision boundaries. Online monitoring catches the quality degradation that offline evals don't.

21. **[Adversarial Inputs](../../patterns/testing/adversarial-inputs/)** — Build an adversarial test suite that exercises both direct injection (malicious user task) and indirect injection (malicious content a sub-agent retrieves and propagates through the handoff). In multi-agent systems, the interesting attacks traverse agent boundaries — a payload that reaches a low-privilege sub-agent but whose output gets distributed to higher-privilege agents. Test the full chain, not just each agent in isolation. The injection defense patterns from Phase 1 need adversarial coverage to know they actually hold.

**What you have:** Orchestration quality is measured end-to-end, regressions are caught on every change, production traffic is sampled and scored, and the chain has been deliberately attacked to verify the injection boundaries hold under pressure.

### Phase 6 — Optimization (Quarter 1+)

22. **[Model Routing](../../patterns/cost-control/model-routing/)** — Once quality monitoring and an eval set are in place, route sub-task types to appropriately sized models. Simple extraction or formatting tasks in a sub-agent don't need a frontier model. Calibrate thresholds against the eval set — the hard part is knowing what "simple" means for your specific sub-agent workload.

23. **[Prompt Rollout Testing](../../patterns/testing/prompt-rollout-testing/)** — Roll out routing classifier changes and sub-agent prompt changes to a fraction of traffic before full deployment. A routing classifier update can silently shift which sub-agents handle which query types across all orchestrations.

24. **[Multi-Provider Failover](../../patterns/resilience/multi-provider-failover/)** — After experiencing a provider outage that disrupted active orchestrations, add failover. The complexity (two provider contracts, context migration between providers mid-orchestration) isn't worth it before you've measured the actual frequency and cost of outages in your context.

---

## Wiring Guide

These snippets show how the core coordination patterns compose. They use the actual implementations from this repo.

### TypeScript: Orchestrator Core Loop

```typescript
import { AgentRouter } from "../../patterns/orchestration/multi-agent-routing/src/ts/index.js";
import { AgentLoopGuards } from "../../patterns/orchestration/agent-loop-guards/src/ts/index.js";
import { OutputValidator } from "../../patterns/safety/structured-output-validation/src/ts/index.js";
import { InjectionDefense } from "../../patterns/safety/prompt-injection-defense/src/ts/index.js";
import { CheckpointManager } from "../../patterns/orchestration/state-checkpointing/src/ts/index.js";
import { Tracer } from "../../patterns/observability/structured-tracing/src/ts/index.js";
import { TokenBudget } from "../../patterns/cost-control/token-budget-middleware/src/ts/index.js";

const router = new AgentRouter({
  agents: AGENT_REGISTRY,
  confidenceThreshold: 0.85,
  fallbackAgent: "generalist"
});

// Per-orchestration limits — separate from per-sub-agent limits
const orchestratorGuards = new AgentLoopGuards({
  maxTurns: 15,          // orchestration steps
  maxTokens: 200_000,    // total task budget (15× single-turn chat average)
  repetitionWindow: 3
});

const checkpoints = new CheckpointManager(db, { ttl: 7200 });
const tracer = new Tracer({ serviceName: "orchestrator" });
const injectionDefense = new InjectionDefense({ threshold: 0.8 });
const taskValidator = new OutputValidator({ maxRetries: 2 });
const tokenBudget = new TokenBudget({ taskLimit: 200_000, agentLimit: 30_000 });

async function runOrchestration(
  taskId: string,
  userTask: string
): Promise<OrchestrationResult> {
  const rootSpan = tracer.startSpan("orchestration.task", { taskId });

  // 1. Scan task input before distributing to sub-agents
  const inputScan = injectionDefense.scan(userTask);
  if (inputScan.flagged) {
    rootSpan.setAttributes({ "security.injection_blocked": true });
    throw new InjectionBlockedError(inputScan.reason);
  }

  // 2. Load checkpoint if interrupted
  const state = (await checkpoints.load(taskId)) ?? OrchestrationState.initial(userTask);

  try {
    while (!orchestratorGuards.isDone(state)) {
      orchestratorGuards.checkBudget(state); // throws BudgetExhaustedError if over

      // 3. Decompose remaining work into sub-tasks
      const subTasks = await decompose(userTask, state.completedSubTasks);

      // 4. Route each sub-task to the right agent, run in parallel
      const subTaskResults = await Promise.allSettled(
        subTasks.map(async (subTask) => {
          const { agentId } = await router.classify(subTask);
          const agent = AGENT_REGISTRY.get(agentId);
          const subSpan = tracer.startSpan(
            "orchestration.sub-agent",
            { agentId, subTaskId: subTask.id },
            rootSpan
          );

          try {
            const result = await agent.run(subTask, {
              // Pass parent trace ID so sub-agent spans link to root
              traceId: rootSpan.traceId,
              tokenBudget: tokenBudget.agentAllocation(agentId)
            });

            // 5. Scan sub-agent output for injection before returning to orchestrator
            const outputScan = injectionDefense.scan(JSON.stringify(result));
            if (outputScan.flagged) {
              subSpan.setAttributes({ "security.output_injection_detected": true });
              throw new InjectionInOutputError(agentId, outputScan.reason);
            }

            // 6. Validate sub-task result against contract schema
            return await taskValidator.validate(result, subTask.outputSchema);
          } finally {
            subSpan.end();
          }
        })
      );

      // 7. Aggregate and checkpoint
      const successfulResults = subTaskResults
        .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
        .map((r) => r.value);

      state.addResults(successfulResults);
      await checkpoints.save(taskId, state.toJSON());

      state.advance();
      rootSpan.setAttributes({
        "orchestration.turn": state.turnCount,
        "orchestration.sub_tasks_completed": state.completedSubTasks.length
      });
    }

    // 8. Validate final aggregated output
    const finalResult = await taskValidator.validate(
      state.aggregatedResult,
      OrchestrationResultSchema
    );

    rootSpan.setAttributes({ "orchestration.success": true, "orchestration.turns": state.turnCount });
    return finalResult.data;
  } catch (err) {
    rootSpan.recordError(err);
    throw err;
  } finally {
    rootSpan.end();
  }
}
```

### TypeScript: Sub-Agent with Boundary Controls

```typescript
import { AgentLoopGuards } from "../../patterns/orchestration/agent-loop-guards/src/ts/index.js";
import { ToolCallValidator } from "../../patterns/orchestration/tool-call-reliability/src/ts/index.js";
import { RetryBudget } from "../../patterns/resilience/retry-with-budget/src/ts/index.js";
import { CircuitBreaker } from "../../patterns/resilience/circuit-breaker/src/ts/index.js";

// Sub-agent has its own guards — independent of the orchestrator's
const subAgentGuards = new AgentLoopGuards({ maxTurns: 8, maxTokens: 30_000 });
const toolValidator = new ToolCallValidator({ allowedTools: RESEARCH_TOOLS, maxRetries: 2 });
const retryBudget = new RetryBudget({ maxAttempts: 3, budgetTokens: 3_000 });
const searchBreaker = new CircuitBreaker({ failureThreshold: 3, recoveryTimeMs: 30_000 });

async function runSubAgent(
  subTask: SubTask,
  options: { traceId: string; tokenBudget: number }
): Promise<SubTaskResult> {
  const span = tracer.startSpan(
    "sub-agent.execution",
    { subTaskId: subTask.id, agentType: "research" },
    options.traceId  // explicitly link to parent trace
  );

  const state = SubAgentState.initial(subTask);

  while (!subAgentGuards.isDone(state)) {
    subAgentGuards.checkBudget(state);

    const response = await retryBudget.execute(() =>
      llmProvider.chat(state.messages, SUB_AGENT_SYSTEM_PROMPT)
    );

    if (response.toolCall) {
      const validatedCall = await toolValidator.validate(response.toolCall);

      // Use per-tool circuit breakers so search failure doesn't block database calls
      const toolResult = await searchBreaker.execute(
        () => TOOL_REGISTRY.execute(validatedCall),
        { fallback: () => ({ error: "search_unavailable", partial: true }) }
      );

      state.addToolResult(toolResult);
    }

    state.advance(response);
  }

  span.end();

  // Return structured output — will be validated at orchestrator boundary
  return {
    subTaskId: subTask.id,
    result: state.finalOutput,
    metadata: { turns: state.turnCount, tokensUsed: state.tokensUsed }
  };
}
```

### Python: Orchestrator Core Loop

```python
from patterns.orchestration.multi_agent_routing.src.py import AgentRouter, RouterConfig
from patterns.orchestration.agent_loop_guards.src.py import AgentLoopGuards, LoopGuardConfig
from patterns.safety.structured_output_validation.src.py import OutputValidator
from patterns.safety.prompt_injection_defense.src.py import InjectionDefense
from patterns.orchestration.state_checkpointing.src.py import CheckpointManager
from patterns.observability.structured_tracing.src.py import Tracer
from patterns.cost_control.token_budget_middleware.src.py import TokenBudget
import asyncio

router = AgentRouter(RouterConfig(
    agents=AGENT_REGISTRY,
    confidence_threshold=0.85,
    fallback_agent="generalist",
))

orchestrator_guards = AgentLoopGuards(LoopGuardConfig(
    max_turns=15,
    max_tokens=200_000,
    repetition_window=3,
))

checkpoints = CheckpointManager(db, ttl=7200)
tracer = Tracer(service_name="orchestrator")
injection_defense = InjectionDefense(threshold=0.8)
task_validator = OutputValidator(max_retries=2)
token_budget = TokenBudget(task_limit=200_000, agent_limit=30_000)


async def run_orchestration(task_id: str, user_task: str) -> OrchestrationResult:
    with tracer.span("orchestration.task", task_id=task_id) as root_span:
        # 1. Scan input before distributing to sub-agents
        scan = injection_defense.scan(user_task)
        if scan.flagged:
            root_span.set_attributes(injection_blocked=True)
            raise InjectionBlockedError(scan.reason)

        # 2. Load checkpoint if interrupted
        state = await checkpoints.load(task_id) or OrchestrationState.initial(user_task)

        while not orchestrator_guards.is_done(state):
            orchestrator_guards.check_budget(state)

            # 3. Decompose remaining work
            sub_tasks = await decompose(user_task, state.completed_sub_tasks)

            # 4. Fan out to sub-agents in parallel
            async def run_sub_task(sub_task):
                route = await router.classify(sub_task)
                agent = AGENT_REGISTRY.get(route.agent_id)
                with tracer.span(
                    "orchestration.sub-agent",
                    agent_id=route.agent_id,
                    sub_task_id=sub_task.id,
                    parent=root_span,
                ) as sub_span:
                    result = await agent.run(
                        sub_task,
                        trace_id=root_span.trace_id,
                        token_budget=token_budget.agent_allocation(route.agent_id),
                    )

                    # 5. Scan sub-agent output for injection propagation
                    output_scan = injection_defense.scan(str(result))
                    if output_scan.flagged:
                        sub_span.set_attributes(output_injection_detected=True)
                        raise InjectionInOutputError(route.agent_id, output_scan.reason)

                    # 6. Validate against contract schema
                    return await task_validator.validate(result, sub_task.output_schema)

            results = await asyncio.gather(
                *[run_sub_task(st) for st in sub_tasks],
                return_exceptions=True,
            )

            successful = [r for r in results if not isinstance(r, Exception)]
            state.add_results(successful)

            # 7. Checkpoint after each orchestration turn
            await checkpoints.save(task_id, state.to_dict())
            state.advance()

        # 8. Validate final aggregated output
        validated = await task_validator.validate(
            state.aggregated_result, OrchestrationResultSchema
        )
        root_span.set_attributes(success=True, turns=state.turn_count)
        return validated.data
```

---

## Tradeoffs

### What to skip early

**Model Routing across sub-agents** — routing decisions require quality signal to calibrate against each agent's capability profile. Without output quality monitoring already running, you can't verify that simple sub-tasks are being handled well by the cheaper model. Add this after quality monitoring has established a baseline.

**Multi-Provider Failover** — the added complexity (second provider contract, context migration mid-orchestration, potential incompatibility in tool support across providers) isn't worth the operational overhead until you've experienced a provider outage that disrupted active orchestrations. The first outage will make the tradeoff calculus clear.

**Drift Detection** — high-value once routing accuracy has a monitoring baseline. Early on, regression testing and output quality monitoring catch the same signal. Add drift detection once you're iterating on prompts and want early warning before quality drops measurably.

**Semantic Caching** — orchestrator fan-out makes caching difficult. The orchestrator's context includes accumulated sub-task results, so the effective prompt is unique to each orchestration state. Only useful for sub-agents that handle genuinely repeated sub-tasks with stable inputs.

### What to add at scale

**Per-sub-agent circuit breakers** — early on, a single circuit breaker at the sub-agent tool call level is fine. At higher orchestration volumes, a degraded dependency (slow vector database, rate-limited search API) causes widespread timeouts for the specific sub-agents that use it. Per-tool circuit breakers let the orchestrator degrade selectively on one dependency without affecting sub-agents that don't use it.

**Sub-task checkpoint granularity** — early on, checkpointing at the orchestration turn level (which sub-tasks are complete) is sufficient. For long-running sub-agents (30+ LLM calls per sub-task), add intra-sub-agent checkpointing. The cost of re-running 30 tool calls is different from the cost of re-running 3.

**Routing classifier retraining** — after accumulating production routing decisions with quality labels, consider fine-tuning the routing classifier on real query distributions. Initial classifiers are calibrated against anticipated query types; production queries often distribute differently. Retraining on misrouted production examples improves both accuracy and confidence calibration.

**Model version pinning and upgrade eval gates** — a model upgrade silently shifts routing decisions, task decomposition, and result aggregation across every agent in the chain. The standard I'd set is to pin explicit model versions per agent (not `latest` aliases) and run the full end-to-end eval harness on every model bump, not just prompt changes. The shifts are rarely catastrophic on any single agent, but they compound across the orchestration and can surface as a subtle quality regression weeks later.

**Data classification propagation across agent boundaries** — in a single-agent system, sensitive data exposure happens at one seam: the agent's context. In multi-agent systems, any sub-agent that reads sensitive data can pass it sideways or upward through the handoff, where it enters contexts that weren't provisioned for that classification. I'd want each sub-agent result tagged with the highest classification level of its inputs, and the orchestrator to enforce handling rules on the aggregate. Without this, the audit path for a data exposure incident is much longer than anyone expects.

### Where patterns create tension

**Agent Loop Guards vs. long research tasks.** A tight turn budget at the orchestrator level prematurely terminates complex research tasks. The right orchestrator budget depends on your actual task distribution — sample 100 production orchestrations and measure p95 turn count before setting the limit. I'd start at 2–3× the p95 and tighten if the budget is being consumed without producing meaningful incremental results.

**Injection scanning vs. latency.** Scanning every sub-agent output for injection adds latency at every agent boundary. For latency-sensitive systems, keep synchronous scanning to the orchestrator input and output boundaries; use asynchronous scanning on sub-agent results and alert on positive detections rather than blocking on them. The tradeoff depends on how untrusted your sub-agents' data sources are.

**State Checkpointing vs. idempotency.** Resuming from a checkpoint assumes re-running a sub-task from the checkpoint state is safe. Sub-agents with side effects (writes, sends, deletes) can duplicate actions on resume. The mitigation is idempotency keys — pass a deterministic key per sub-task so downstream systems can deduplicate. Design this in before sub-agents have write access to anything real.

**Parallel fan-out vs. context window.** Aggregating results from 10 parallel sub-agents can overflow the orchestrator's context window before the final synthesis step. The fix is summarization at the sub-task boundary — have each sub-agent return a compressed result plus a full-detail artifact stored externally (filesystem, database), and have the orchestrator synthesize from summaries. [Anthropic's research system has sub-agents persist their outputs to external storage and pass lightweight references back to the coordinator](https://www.anthropic.com/engineering/multi-agent-research-system) for exactly this reason.

**Routing confidence vs. coverage.** A high confidence threshold (0.90+) prevents misroutes but increases the fallback rate — more queries going to the generalist agent rather than the specialist. A low threshold routes more queries to specialists but accepts more misroutes. Calibrate against your eval set and monitor both misroute rate and fallback rate in production. The right threshold shifts as the agent pool grows.

---

## Related Guides

- [Agent Systems Integration Guide](../agents/) — the single-agent foundation. The multi-agent guide assumes you've already worked through the agent systems patterns. Every pattern in the agent guide applies here; this guide adds what changes at the coordination layer.
- [RAG Systems Integration Guide](../rag/) — many multi-agent systems include a retrieval sub-agent. If any of your sub-agents query a vector store, the RAG guide covers the additional data pipeline patterns relevant to that retrieval path.
- [Batch Systems Integration Guide](../batch/) — if orchestrations run as offline scheduled jobs (nightly analysis, bulk document processing), the batch guide covers recovery and throughput patterns that become critical at batch scale.

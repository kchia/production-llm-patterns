# Agent Loop Guards

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

An agent gets stuck in a loop — calling the same tool repeatedly, oscillating between two states, or recursing without making progress. Without guards, this runs until the token budget is exhausted or the API rate limit kicks in.

This isn't a theoretical concern. [ZenML](https://www.zenml.io/blog/what-1200-production-deployments-reveal-about-llmops-in-2025)'s analysis of production deployments highlighted how multi-agent systems can escalate costs dramatically when recursive loops go undetected. In one documented case, Agent A requested help from Agent B, which asked Agent A for clarification, creating a recursive conversation loop. Neither agent had logic to break the cycle.

Unlike a traditional infinite loop that pegs a CPU, an agent loop is subtle. The agent _looks_ busy — it's making API calls, producing output, calling tools. Logs show activity. Metrics show throughput. But it's burning tokens on circular reasoning.

The failure modes are varied: an LLM misinterprets a termination signal and believes "summarized" isn't truly "done" until it re-summarizes multiple times; a tool call returns an error that the agent retries identically; two agents deadlock requesting clarification from each other. [LangGraph](https://docs.langchain.com/oss/python/langgraph/errors/GRAPH_RECURSION_LIMIT) users report this frequently enough that `GraphRecursionError` is one of their most common production errors.

[OWASP](https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/)'s 2025 Top 10 for LLM Applications categorizes this under "Unbounded Consumption" — and it's also an attack vector. An adversary can craft inputs that trigger recursive agent loops, creating what security researchers call "Denial of Wallet" attacks in pay-per-token systems.

## What I Would Not Do

The naive approach is trusting the LLM to self-terminate. It's tempting to add a system prompt instruction like "stop after completing the task" or "don't repeat yourself" and assume the model will comply. This works in demos. It breaks in production for three reasons.

First, LLMs don't have reliable self-awareness of their own execution history. A model can't count how many times it's called a tool — it processes each turn in context, and context windows are finite. At turn 47, the model may not "remember" turns 1–20 at all.

Second, termination is a _judgment_ call, not a _reasoning_ one. The model needs to decide "I'm done" versus "I should try again," and that decision depends on subtle cues that drift with prompt changes, model updates, and input distribution shifts. A prompt that reliably terminates with GPT-4o might loop with the next model version.

Third, even hard-coding `max_iterations = 50` as a single number doesn't catch the expensive loops. If each iteration costs `$0.10` in tokens, 50 iterations is `$5` per stuck request. At 100 requests/day with a 2% loop rate, that's `$10/day` in waste — `$300/month`. And 50 iterations is still generous enough that many loops burn significant budget before hitting the cap. A single counter doesn't detect _patterns_ — it can't tell the difference between a productive 30-step task and a 30-step loop cycling between two tool calls.

## When You Need This

- The agent makes autonomous tool calls or multi-step decisions without human approval at each step
- Token spend per session is variable and unpredictable — some tasks take 3 turns, others take 30
- The system runs without a human watching each execution (batch processing, background agents, customer-facing assistants)
- There's a financial or operational consequence to a single runaway session — not just wasted tokens, but potentially repeated side effects (duplicate emails, redundant database writes, repeated API calls to external services)
- The agent's task complexity is growing — early versions did simple retrieval, newer versions chain 5+ tools together

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

| System Type   | Priority    | Reasoning                                                                                                                                                                                                                                                                                            |
| ------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agents**    | Critical    | Autonomous tool-calling loops are the defining characteristic of agent systems. Without loop guards, a single stuck agent can exhaust the entire token budget. I wouldn't ship an agent system without this — it's the difference between a demo and something I'd be comfortable getting paged for. |
| **Batch**     | Recommended | Batch systems process many items sequentially or in parallel. A loop in one item can block the pipeline or inflate costs across the entire job. The risk is lower than agents (most batch operations are bounded by design), but any iterative processing step inherits the loop risk.               |
| **Streaming** | Recommended | Streaming systems with iterative processing (e.g., multi-turn tool use during a stream) face loop risk on the critical path. A stuck loop blocks the user's stream and wastes resources. Less common than in pure agent systems, but the impact is high when it happens.                             |
| **RAG**       | Optional    | Standard RAG is single-pass: retrieve, then generate. No loop, no loop risk. But RAG systems that add iterative query refinement or multi-hop retrieval introduce loop potential — in that case, this pattern applies.                                                                               |

## The Pattern

### Architecture

```
  ┌───────────────────────────┐
  │  Agent Runner (while loop)│
  └─────────┬─────────────────┘
            │
            ▼
  ┌───────────────────────────┐
  │ 1. Budget Gate            │
  │ turns < max? tokens < max?│  FAIL
  │ time < max? abort signal? ├───────→ Halt & Report ──→ Metrics
  └─────────┬─────────────────┘
        PASS│
            ▼
  ┌───────────────────────────┐
  │ 2. LLM Call               │
  │ Send context + tools      │
  └─────────┬─────────────────┘
            │
            ▼
  ┌───────────────────────────┐
  │ 3. Convergence Check      │
  │ Repetition detection      │  STUCK
  │ Progress scoring          ├───────→ Halt & Report ──→ Metrics
  │ Cycle detection           │
  └─────────┬─────────────────┘
     PROGRESS│
            ▼
  ┌───────────────────────────┐
  │ 4. Tool Execution         │
  │ Execute tool call(s)      │
  └─────────┬─────────────────┘
            │
            ▼
  ┌───────────────────────────┐
  │ 5. Completion Check       │
  │ No tool calls? Model done?│  DONE
  │                           ├───────→ Return Result ──→ Metrics
  └─────────┬─────────────────┘
    CONTINUE│
            │
            └──→ Loop back to 1
```

The guard wraps the agent's core loop with three enforcement layers, checked at different points in each iteration:

1. **Budget Gate** (pre-LLM call) — hard limits on turns, tokens, and wall-clock time. These are absolute caps that prevent runaway regardless of what the model does. Cheap to check, always runs first.

2. **Convergence Detector** (post-LLM call) — analyzes the model's output for repetition patterns before executing tool calls. Catches loops that are within budget but not making progress. More expensive than budget checks, but prevents wasted tool execution.

3. **Completion Check** (post-tool execution) — determines whether the model has naturally finished. If the model produces a response with no tool calls, the loop exits cleanly.

Illustrative values shown (maxTurns, maxTokens, maxDuration) are starting points — actual thresholds depend on the agent's task complexity, expected turn count distribution, and token cost per call.

### Core Abstraction

```typescript
interface LoopGuardConfig {
  maxTurns: number; // Hard cap on LLM calls per session
  maxTokens: number; // Cumulative token budget across all turns
  maxDurationMs: number; // Wall-clock timeout for entire session
  maxRepeatedCalls: number; // Consecutive identical tool calls before halt
  convergenceWindow: number; // Number of recent turns to check for patterns
  onHalt: (reason: HaltReason, context: LoopContext) => void;
}

interface LoopContext {
  turnCount: number;
  totalTokens: number;
  elapsedMs: number;
  toolCallHistory: ToolCall[];
  haltReason?: HaltReason;
}

type HaltReason =
  | "max_turns"
  | "max_tokens"
  | "max_duration"
  | "repeated_calls"
  | "no_progress"
  | "abort_signal";
```

### Configurability

| Parameter           | Default         | Purpose                                      | Dangerous Extreme                                                 |
| ------------------- | --------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| `maxTurns`          | 25              | Hard cap on LLM round-trips                  | <5 kills complex tasks; >100 allows expensive loops               |
| `maxTokens`         | 100,000         | Cumulative token budget                      | <10K too restrictive; >500K risks $5+ per session                 |
| `maxDurationMs`     | 120,000 (2 min) | Wall-clock timeout                           | <10s breaks real tool calls; >10 min risks zombie sessions        |
| `maxRepeatedCalls`  | 3               | Identical consecutive tool calls before halt | 1 is too aggressive (legitimate retries exist); >10 wastes tokens |
| `convergenceWindow` | 5               | Recent turns to analyze for repetition       | <3 misses patterns; >15 adds latency to detection                 |
| `onHalt`            | log + throw     | Callback when guard halts execution          | Silent swallow loses diagnostic data                              |

These defaults are starting points. The right values depend on average task complexity (simple Q&A vs. multi-tool research), token cost per model (GPT-4o at $2.50/1M input vs. GPT-4o-mini at $0.15/1M), and latency SLA for the calling system.

### Key Design Tradeoffs

**Budget gate vs. convergence detection** — Budget gates are simple and reliable but can't distinguish a productive 25-turn task from a 25-turn loop. Convergence detection catches loops earlier but adds complexity and can produce false positives. The pattern uses both: budget as the absolute safety net, convergence as the early-exit optimization.

**Per-session vs. per-input limits** — [StrongDM's Attractor spec](https://github.com/strongdm/attractor/blob/main/coding-agent-loop-spec.md) distinguishes `max_turns` (session-wide) from `max_tool_rounds_per_input` (per-user-message). This pattern uses per-session limits as the primary mechanism because session boundaries are cleaner. Per-input limits are useful for multi-turn chat agents and can be layered on top.

**Halt vs. degrade** — When a loop is detected, the pattern halts execution and reports the reason rather than trying to "fix" the loop (e.g., by injecting a corrective prompt). Attempts to recover mid-loop are fragile — the model already demonstrated it can't self-regulate in this context. Halting and returning partial results is safer than hoping a nudge will help.

**Repetition detection granularity** — The pattern tracks tool call identity (name + arguments hash) rather than full response text. Response text varies even in loops (the model rephrases), but tool calls with identical arguments are a strong signal. This trades recall for precision — subtle semantic loops won't be caught, but false positives are rare.

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

How this pattern itself can fail. Every solution creates new failure modes.

| Failure Mode                                     | Detection Signal                                                                                                                                                                                                         | Mitigation                                                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Guard too aggressive — kills legitimate work** | Spike in halt rate; user complaints about incomplete tasks; halt reasons cluster on `max_turns` for complex queries                                                                                                      | Analyze halted sessions to find the 95th percentile turn count for successful tasks. Set `maxTurns` to 2x that value. Segment by task complexity if the distribution is bimodal.   |
| **Guard too permissive — loops run too long**    | Mean token spend per session creeping up; p99 session duration increasing; `max_turns` halts are rare but average turn count is high                                                                                     | Reduce `maxTurns` or add convergence detection. Track the distribution of turns per session — if the tail is growing, the guard isn't catching loops early enough.                 |
| **Convergence detector false positives**         | Legitimate multi-step tasks halted with `repeated_calls` or `no_progress`; tasks that retry a tool after fixing an issue get flagged                                                                                     | Widen `convergenceWindow` or add argument-aware deduplication (same tool with different args isn't repetition). Allowlist specific tool names that legitimately repeat.            |
| **Hash collision in tool call dedup**            | Two different tool calls hash to the same value; guard treats novel calls as repetition                                                                                                                                  | Use a high-quality hash function (SHA-256 truncated, not string concatenation). Monitor for `repeated_calls` halts where the actual calls differ — this reveals collisions.        |
| **Silent degradation — guard thresholds drift**  | Over months, as task complexity grows, more legitimate tasks hit `maxTurns`. Halt rate increases gradually (~1% per month) without triggering alerts. Appears as "flaky" user experience rather than systematic failure. | Review halt rate monthly. Compare `maxTurns` against the evolving 95th percentile of successful task completion turns. Set up a drift alert if halt rate exceeds baseline by >50%. |
| **Clock skew in duration tracking**              | In distributed systems, wall-clock timeout fires inconsistently; some sessions run 3x longer than `maxDurationMs`                                                                                                        | Use monotonic clock for duration measurement, not wall-clock time. In distributed settings, prefer turn-based limits over time-based ones.                                         |
| **Abort signal ignored**                         | External abort signal fires but the agent continues executing (e.g., signal arrives mid-tool-execution and isn't checked until the next turn)                                                                            | Check abort signal before _and_ after tool execution, not just at the top of the loop. Use async-safe signal handling.                                                             |

## Observability & Operations

### Key Metrics

| Metric                       | Unit              | Collection Method                                    | What It Tells You                                                                                     |
| ---------------------------- | ----------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `guard.halt_rate`            | % of sessions     | Count halts / total sessions                         | Overall guard health — too high means guard is aggressive, too low might mean guard is too permissive |
| `guard.halt_reason`          | enum distribution | Breakdown of HaltReason values                       | Which limit is firing most — informs tuning priorities                                                |
| `guard.turns_per_session`    | histogram         | Record turnCount from LoopContext at session end     | Baseline for normal behavior; tail growth signals loops not being caught                              |
| `guard.tokens_per_session`   | histogram         | Record totalTokens from LoopContext                  | Tracks cost per session; catches token-heavy sessions before they spike the bill                      |
| `guard.session_duration_ms`  | histogram         | Record elapsedMs from LoopContext                    | Identifies slow sessions; catches zombie agents                                                       |
| `guard.convergence_triggers` | counter           | Increment on `repeated_calls` or `no_progress` halts | Loop detection effectiveness — zero means either no loops or detection isn't working                  |

### Alerting

| Alert                            | Condition                                                        | Severity | Notes                                                                               |
| -------------------------------- | ---------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| Halt rate too high               | `guard.halt_rate` > 5% over 1 hour                               | Warning  | Guard may be too aggressive; legitimate work is being killed                        |
| Halt rate spike                  | `guard.halt_rate` > 15% over 15 min                              | Critical | Possible model regression or prompt change causing widespread loops                 |
| Halt rate too low (suspiciously) | `guard.halt_rate` = 0% for >24 hours with >100 sessions          | Warning  | Guard may not be running or convergence detection is broken — check instrumentation |
| Token budget breaches            | Any session exceeds `maxTokens` × 0.9                            | Warning  | Sessions approaching the budget cap; consider whether `maxTokens` is set correctly  |
| Zero convergence triggers        | `guard.convergence_triggers` = 0 for >7 days with >1000 sessions | Warning  | Convergence detection may not be functioning — verify with synthetic loop test      |

These thresholds are starting points. Adjust based on your baseline halt rate (which depends on task complexity distribution), your SLA for session completion, and your traffic profile (steady vs. bursty).

### Runbook

**When halt rate spikes above 15%:**

1. Check `guard.halt_reason` distribution — is it `max_turns` (budget) or `repeated_calls` (convergence)?
2. If `max_turns`: pull recent halted sessions and examine turn counts. Did task complexity increase? Did a prompt change add more tool-calling steps?
3. If `repeated_calls`: check if a tool endpoint is failing (returning errors the agent retries). Check if a model update changed tool-calling behavior.
4. Temporary mitigation: increase `maxTurns` by 50% while investigating. Don't remove the guard.

**When mean tokens per session creeps up:**

1. Pull the 95th percentile of turns per session for the last 30 days. Is it growing?
2. Compare against `maxTurns` — if p95 is approaching the limit, legitimate tasks are getting more complex.
3. Either increase `maxTurns` or segment tasks by complexity class (simple tasks get lower limits).

**When convergence triggers are zero for >7 days:**

1. Run a synthetic test: send a known-looping input through the agent and verify the guard catches it.
2. Check if the `onHalt` callback is wired to metrics correctly.
3. If detection works in testing but not production: the current loop patterns may be too subtle for the configured `convergenceWindow`. Consider widening it or adding semantic similarity detection.

## Tuning & Evolution

### Tuning Levers

| Lever               | Safe Range            | Effect of Increase                                         | Effect of Decrease                                           |
| ------------------- | --------------------- | ---------------------------------------------------------- | ------------------------------------------------------------ |
| `maxTurns`          | 10–50 for most agents | Allows more complex tasks to complete; costs more per loop | Catches loops faster; risks killing legitimate work          |
| `maxTokens`         | 20K–200K              | Higher per-session budget tolerance                        | Tighter cost control per session                             |
| `maxDurationMs`     | 30s–5min              | Accommodates slow tool calls; risks zombie sessions        | Catches stalled sessions; may timeout legitimate slow tools  |
| `maxRepeatedCalls`  | 2–5                   | Tolerates legitimate retries; delays loop detection        | More aggressive detection; may false-positive on retry logic |
| `convergenceWindow` | 3–10                  | Catches longer cycles; more compute per check              | Faster checks; misses complex patterns                       |

### Drift Signals

| Signal                             | What It Means                                                                                                                                | Action                                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Turns per session p95 growing**  | Task complexity is increasing. If p95 approaches `maxTurns`, the guard will start killing legitimate work.                                   | Re-evaluate `maxTurns` against the new p95. Consider segmenting by task complexity class.                     |
| **New tool calls appearing**       | When new tools are added to the agent, the convergence detector may not have enough history to detect novel loop patterns.                   | Re-evaluate `convergenceWindow` after adding tools. Run synthetic loop tests with the new tool set.           |
| **Model version change**           | Different models have different termination behaviors. A model that reliably self-terminated may loop under a new version.                   | Monitor halt rate closely for 48 hours after a model swap. Compare halt reason distribution before and after. |
| **Halt reason distribution shift** | If `max_tokens` starts dominating where `max_turns` used to, sessions are getting more token-heavy (longer tool responses, larger contexts). | Recalibrate both limits. Consider whether the token budget needs a separate adjustment from the turn budget.  |

### Silent Degradation

**Month 3:** Task complexity has grown incrementally. The p95 turn count has shifted from 8 to 14. The guard's `maxTurns=25` still catches loops, but the gap between "complex legitimate task" and "loop" is narrower. A few users report occasional incomplete results — these are `max_turns` halts on legitimate tasks that now take 26–30 turns. The halt rate is 3%, up from 1%, but hasn't triggered the 5% warning alert.

**Month 6:** The team adds two new tools to the agent. Some tasks now require 35+ turns with the new tools. The `maxTurns=25` guard is killing 8% of sessions. The team notices and bumps `maxTurns` to 50, but doesn't adjust `convergenceWindow`. The wider turn budget means loops now burn 50 turns before halting — 2x the original waste. Meanwhile, the convergence detector with `window=5` can't detect the new cycle pattern (A→B→C→D→E→A) because the cycle length exactly matches the window.

**Proactive checks:** Review halt rate monthly. Compare `maxTurns` against the evolving p95 of successful session turn counts. After adding tools, run the benchmark suite with the new tool set. Set a calendar reminder to re-evaluate `convergenceWindow` quarterly.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers.

| Scale        | Daily Savings (GPT-4o) | ROI vs. No Pattern                                                  |
| ------------ | ---------------------- | ------------------------------------------------------------------- |
| 1K req/day   | +$8.00/day saved       | Pays for implementation in <1 week                                  |
| 10K req/day  | +$80.00/day saved      | $2,400/month in prevented waste                                     |
| 100K req/day | +$800.00/day saved     | $24,000/month — a single prevented loop storm justifies the pattern |

## Testing

See test files in `src/ts/__tests__/index.test.ts` and `src/py/tests/test_index.py`.

Run: `cd src/ts && npm install && npm test`

- **Unit tests:** Default config handling, config merging, natural completion, token tracking across turns, graceful handling of tool execution errors
- **Failure mode tests:** One test per failure mode from the table above — max_turns halt, max_tokens halt, repeated_calls detection, cycle detection (no_progress), duration timeout, abort signal handling, and onHalt callback verification for silent degradation monitoring
- **Integration tests:** Multi-step tool-calling agent completing a realistic task; loop simulation with mock provider's `simulateLoop` mode; concurrent independent guard instances running in parallel (verifying no shared state leakage)

## When This Advice Stops Applying

| Condition                                  | Why This Pattern Doesn't Apply                                                                                                                                                                                                                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Single-step LLM calls with no tool use** | If there's no loop in the architecture, there's no loop to guard. Straightforward prompt-in/response-out systems don't benefit from this pattern; it'd just be dead code.                                                                                                                                |
| **Human-in-the-loop at every step**        | If a person reviews and approves each agent action before it executes, the human _is_ the loop guard. Adding automated guards on top is redundant. This changes if the human approval is async and batched — then loops can accumulate between review cycles.                                            |
| **Inherently bounded pipelines**           | Systems with fixed stages (retrieve → transform → generate → respond) have no conditional loops by construction. The execution graph is a DAG, not a cycle. If this describes the system, loop guards add complexity without value.                                                                      |
| **Prototypes and dev environments**        | When a developer is actively watching each run and can kill the process manually, automated guards aren't worth the implementation cost yet. But the moment the agent runs unattended — even for internal testing — guards become relevant.                                                              |
| **Future model improvements**              | As LLMs develop better self-monitoring capabilities and reliable function-calling termination, some of the detection heuristics in this pattern may become unnecessary. The hard budget caps will likely remain valuable regardless, but convergence detection could shift to model-native capabilities. |

<!-- ## Companion Content

- Blog post: [Agent Loop Guards — Deep Dive](https://prompt-deploy.com/agent-loop-guards) (coming soon)
- Related patterns:
  - [Token Budget Middleware](../../cost-control/token-budget-middleware/) — financial backstop when loop guards fail; the guard catches loops early, the token budget prevents cost catastrophes if the guard misses
  - [Structured Tracing](../../observability/structured-tracing/) — provides the trace context for diagnosing why a loop occurred after the guard halts it
  - [State Checkpointing](../state-checkpointing/) — saves progress so that when a loop is detected and halted, partial work isn't lost
  - [Multi-Agent Routing](../multi-agent-routing/) — loop guards need to apply to each agent independently in a multi-agent system; the routing layer decides which agent runs, the guard ensures each one terminates
  - [Tool Call Reliability](../tool-call-reliability/) — validates tool calls within the loop; a failing tool is a common trigger for agent loops
  - [Human-in-the-Loop](../../safety/human-in-the-loop/) — escalation path when loop detection triggers; instead of just halting, route the stuck agent to a human for resolution -->

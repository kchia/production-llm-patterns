# Adoption Roadmap

A timeline-based guide for adopting production LLM patterns by system maturity. The way I'd think about sequencing: start with what prevents immediate production failures, then build toward what makes the system observable and maintainable over months.

This isn't a checklist. It's a prioritization framework. Every system is different — a RAG pipeline serving internal analysts has different stakes than a customer-facing agent making tool calls. The maturity signals at the bottom of each phase help calibrate what "ready to move on" actually looks like for your situation.

---

## Week 1 — The Absolute Essentials

These are the patterns I'd want in place before calling anything production-ready. They address failure modes that bite immediately — malformed outputs, runaway costs, undetectable errors, and regulatory exposure.

### 1. [Structured Output Validation](../patterns/safety/structured-output-validation/)

**Priority:** Critical for agents, Required for everything else.

LLMs return text. Your application expects a `UserProfile` object or a JSON array. The gap between those two is where most day-one production bugs live. Without validation, a schema change in the prompt or a model update silently breaks downstream code. I'd want this in place before any code depends on the response shape.

**Adoption signal:** You're calling an LLM and parsing the response anywhere in your codebase.

### 2. [PII Detection](../patterns/safety/pii-detection/)

**Priority:** Required for all system types.

This is the pattern where skipping it has legal consequences, not just technical ones. If user-provided inputs flow into prompts — which they usually do — there's a real chance PII ends up in logs, in the prompt itself, or in model training data. I'd treat this as Day 1 infrastructure, not a Month 3 compliance project.

**Adoption signal:** User input touches your LLM pipeline in any form.

### 3. [Structured Tracing](../patterns/observability/structured-tracing/)

**Priority:** Critical for agents, Required for RAG and streaming.

Without structured traces, debugging a production failure is reconstructing a crime scene from witness accounts. You can't tell which prompt was used, what the model returned, or how long each step took. I'd want tracing in place from the first deployment — retrofitting it later means correlating unstructured logs with user reports, which doesn't work well.

**Adoption signal:** You're deploying anything to production and want to understand what happened when something breaks.

### 4. [Retry with Budget](../patterns/resilience/retry-with-budget/)

**Priority:** Required for agents, streaming, and batch.

Provider APIs return 429s and 503s. This is not a question of if — it's a question of frequency. A naive fixed-delay retry loop turns a 5-second outage into a retry storm. The budget component keeps retries bounded so a degraded period doesn't amplify into an outage. I'd put this in place before any real traffic hits the system.

**Adoption signal:** You're making provider API calls with any retry logic at all, or no retry logic because "it rarely fails."

### 5. [Token Budget Middleware](../patterns/cost-control/token-budget-middleware/)

**Priority:** Required for RAG, agents, and batch.

The first time a long conversation or a retrieval pipeline sends 50k tokens to a GPT-4o call, the cost is surprising. Token Budget Middleware is the guardrail that prevents a single request from consuming a day's budget. It also forces the right conversation early: how much context does this feature actually need?

**Adoption signal:** You're in production at any request volume. Cost surprises happen faster than expected.

---

## Month 1 — Core Resilience and Observability

Once the essentials are in place, the next 30 days are about making the system observable and resilient to provider failures. These patterns address what breaks in the second week of production, not the first.

### 6. [Graceful Degradation](../patterns/resilience/graceful-degradation/)

**Priority:** Critical for streaming, Required for RAG and agents.

Provider outages happen. The question is whether your system returns an error or serves something. Graceful degradation defines the answer: a fallback provider, a cached response, or a static message — in that order. I'd want the fallback chain defined before the first outage, not during it.

**Adoption signal:** You've had one provider outage and returned a 500 to users, or you know you will.

### 7. [Circuit Breaker](../patterns/resilience/circuit-breaker/)

**Priority:** Critical for streaming, Required for agents.

When a provider is degraded, retries keep hammering it. The circuit breaker detects systemic failure and fast-fails requests until the provider recovers. Without it, a degraded provider causes cascading latency and retry amplification. It pairs tightly with Retry with Budget — retries handle transient errors, the circuit breaker handles sustained ones.

**Adoption signal:** You've seen retry storms during a provider degradation event, or you have a streaming system where users notice latency spikes.

### 8. [Prompt Injection Defense](../patterns/safety/prompt-injection-defense/)

**Priority:** Critical for agents, Required for RAG and streaming.

If users can influence what goes into your prompts — directly or indirectly through retrieved content — there's an injection surface. For agents making tool calls, the stakes are higher: an injected instruction that triggers a file write or an API call is a live vulnerability. I'd want injection defense in place before any agent handles user-provided or user-influenced content.

**Adoption signal:** Your prompt includes any user-controlled content, or you're doing retrieval-augmented generation with external data.

### 9. [Prompt Version Registry](../patterns/observability/prompt-version-registry/)

**Priority:** Required for RAG and agents.

Prompts are code. If they're not version-controlled, you can't reproduce a failure, roll back a regression, or understand why outputs changed last Tuesday. A prompt registry makes prompt changes first-class deployments. Without it, prompt changes happen out-of-band with code changes, and debugging becomes archaeology.

**Adoption signal:** You've changed a prompt and couldn't tell afterward exactly what changed or when.

### 10. [Eval Harness](../patterns/testing/eval-harness/)

**Priority:** Required for RAG, agents, and batch.

LLM outputs are non-deterministic. "It worked in testing" means almost nothing without a structured eval harness that tests against a fixed dataset and scores outputs consistently. I'd want an eval harness in place before making the first prompt change in production — otherwise, there's no way to know if the change helped or hurt.

**Adoption signal:** You've changed a prompt and deployed it without any systematic way to measure whether it was better.

### 11. [Output Quality Monitoring](../patterns/observability/output-quality-monitoring/)

**Priority:** Required for RAG, agents, and batch.

Tracing tells you what happened. Quality monitoring tells you whether it was good. Without it, output degradation — from model updates, prompt drift, or data quality issues — goes undetected until users complain. The goal isn't catching every bad response; it's detecting systematic degradation before it compounds.

**Adoption signal:** You've shipped a model update or prompt change and had no idea whether quality improved or regressed until user feedback arrived.

---

## Quarter 1 — Full Coverage by System Type

By the end of three months, the core foundation is solid. This phase is about covering the patterns that matter for your specific system type. Every system is different — a RAG pipeline has different priorities than an agent-based system.

### For RAG Systems

**First priority: Data Pipeline**

RAG quality is determined by the retrieval layer, not the generation layer. A well-prompted model can't outperform bad chunks.

| Pattern | Priority | What It Addresses |
|---|---|---|
| [Chunking Strategies](../patterns/data-pipeline/chunking-strategies/) | Critical | Fixed-size chunking breaks semantic boundaries. Outputs degrade without users knowing why. |
| [Embedding Refresh](../patterns/data-pipeline/embedding-refresh/) | Required | Stale embeddings cause retrieval drift as your corpus evolves. |
| [Index Maintenance](../patterns/data-pipeline/index-maintenance/) | Required | Fragmented or dirty indexes silently degrade retrieval precision. |
| [Drift Detection](../patterns/observability/drift-detection/) | Required | Detects when retrieval quality shifts — from corpus updates, embedding model changes, or query pattern drift. |
| [Semantic Caching](../patterns/cost-control/semantic-caching/) | High ROI | Similar queries share responses. Significant cost and latency savings at moderate traffic. |

**Maturity signal:** Chunking Strategies first — it's the leverage point. Everything else improves a foundation that chunking establishes.

### For Agent Systems

**First priority: Control and Safety**

Agents take actions. Control failure has consequences that don't appear in logs until something goes wrong downstream.

| Pattern | Priority | What It Addresses |
|---|---|---|
| [Agent Loop Guards](../patterns/orchestration/agent-loop-guards/) | Critical | Without explicit termination conditions, agents loop indefinitely on ambiguous tasks. |
| [Tool Call Reliability](../patterns/orchestration/tool-call-reliability/) | Critical | Tool calls fail. Without structured retry and error context, agents get stuck or hallucinate recovery steps. |
| [Multi-Agent Routing](../patterns/orchestration/multi-agent-routing/) | Critical | Vague routing prompts cause misrouting that's hard to detect and compounds across steps. |
| [Adversarial Inputs](../patterns/testing/adversarial-inputs/) | Critical | Agents are the highest-risk target for injection and abuse. Systematic adversarial testing surfaces vulnerabilities before attackers do. |
| [Human-in-the-Loop](../patterns/safety/human-in-the-loop/) | Required | For high-stakes agent actions (financial, destructive, irreversible), human confirmation is the last line of defense. |
| [State Checkpointing](../patterns/orchestration/state-checkpointing/) | Required | Multi-step agent tasks fail partway through. Without checkpointing, recovery means restarting from scratch. |
| [Prompt Rollout Testing](../patterns/testing/prompt-rollout-testing/) | Required | Agent prompt changes interact with tool calling in non-obvious ways. Gradual rollout limits blast radius. |

**Maturity signal:** Agent Loop Guards and Tool Call Reliability first — uncontrolled loops and failed tool calls are the most common agent production failures.

### For Streaming Systems

**First priority: Resilience and Latency**

Streaming has zero tolerance for dropped connections and strict latency budgets. Failures are immediately visible to users.

| Pattern | Priority | What It Addresses |
|---|---|---|
| [Multi-Provider Failover](../patterns/resilience/multi-provider-failover/) | Critical | Provider failures drop the stream. Failover switches providers mid-outage without user impact. |
| [Latency Budget](../patterns/performance/latency-budget/) | Critical | Per-step timeouts without a global budget cause unpredictable end-to-end latency. |
| [Streaming Backpressure](../patterns/performance/streaming-backpressure/) | Critical | If the consumer can't keep up with token delivery, buffering and drops follow. |
| [Concurrent Request Management](../patterns/performance/concurrent-request-management/) | Recommended | Under load, uncapped concurrent streams overwhelm the provider connection pool. |

**Maturity signal:** Graceful Degradation (from Month 1) and Multi-Provider Failover compose well — add Multi-Provider Failover next if you haven't already.

### For Batch Systems

**First priority: Recovery and Throughput**

Batch jobs are expensive and long-lived. A job that fails at 80% completion and restarts from scratch doubles costs. Recovery is the foundational concern.

| Pattern | Priority | What It Addresses |
|---|---|---|
| [State Checkpointing](../patterns/orchestration/state-checkpointing/) | Critical | Without checkpointing, partial failures restart from the beginning. For long jobs, this is prohibitive. |
| [Request Batching](../patterns/performance/request-batching/) | Critical | Individual item-by-item requests are 10-50x less efficient than batch API calls at volume. |
| [Concurrent Request Management](../patterns/performance/concurrent-request-management/) | Critical | Uncapped parallelism without rate awareness triggers rate limiting at exactly the wrong time. |
| [Prompt Rollout Testing](../patterns/testing/prompt-rollout-testing/) | High ROI | Batch jobs run long. A bad prompt discovered at hour 3 means wasted cost and a restart. |

**Maturity signal:** State Checkpointing first — it's the pattern that changes the economics of failure from "restart everything" to "resume from checkpoint."

---

## Maturity Signals — "You're Ready for X When You See Y"

These signals indicate that a specific pattern has moved from optional to worth the investment. The goal isn't to adopt everything — it's to adopt the right thing at the right time.

| Signal You're Seeing | Pattern to Add |
|---|---|
| Similar queries hitting the LLM repeatedly with similar intent | [Semantic Caching](../patterns/cost-control/semantic-caching/) |
| Some requests clearly simpler than others, model is uniform | [Model Routing](../patterns/cost-control/model-routing/) |
| No visibility into daily/weekly LLM spend trends | [Cost Dashboard](../patterns/cost-control/cost-dashboard/) |
| Output quality varies but you can't quantify it | [Eval Harness](../patterns/testing/eval-harness/) |
| Prompt changes deployed without knowing if they regressed | [Regression Testing](../patterns/testing/regression-testing/) |
| Model update changed outputs but you detected it weeks later | [Drift Detection](../patterns/observability/drift-detection/) |
| Prompt changes ship without auditing what changed | [Prompt Diffing](../patterns/observability/prompt-diffing/) |
| You'd deploy a prompt change to all traffic at once | [Prompt Rollout Testing](../patterns/testing/prompt-rollout-testing/) |
| Agent failures don't surface until downstream breakage | [Structured Tracing](../patterns/observability/structured-tracing/) — deepen the span coverage |
| Snapshot tests break on minor rephrasing, not regressions | [Snapshot Testing](../patterns/testing/snapshot-testing/) |
| Multi-step agent tasks fail partway with no recovery path | [State Checkpointing](../patterns/orchestration/state-checkpointing/) |
| Context window fills and older context gets silently dropped | [Context Management](../patterns/data-pipeline/context-management/) |
| Latency varies 3–10x across requests with no explanation | [Latency Budget](../patterns/performance/latency-budget/) |

---

## Adoption by Concern, Not Checklist

The timeline above is a starting point. The way I'd actually navigate it: identify the concern that's keeping you up at night, then adopt the pattern that addresses it.

| If your biggest concern is... | Start here |
|---|---|
| **Correctness** — outputs that break downstream code | [Structured Output Validation](../patterns/safety/structured-output-validation/) |
| **Cost** — spend growing faster than traffic | [Token Budget Middleware](../patterns/cost-control/token-budget-middleware/) → [Cost Dashboard](../patterns/cost-control/cost-dashboard/) |
| **Reliability** — provider outages affecting users | [Retry with Budget](../patterns/resilience/retry-with-budget/) → [Circuit Breaker](../patterns/resilience/circuit-breaker/) → [Graceful Degradation](../patterns/resilience/graceful-degradation/) |
| **Safety** — user data in prompts or high-risk agent actions | [PII Detection](../patterns/safety/pii-detection/) → [Prompt Injection Defense](../patterns/safety/prompt-injection-defense/) |
| **Quality** — no way to know if outputs got better or worse | [Eval Harness](../patterns/testing/eval-harness/) → [Output Quality Monitoring](../patterns/observability/output-quality-monitoring/) |
| **Visibility** — debugging failures is guesswork | [Structured Tracing](../patterns/observability/structured-tracing/) → [Prompt Version Registry](../patterns/observability/prompt-version-registry/) |
| **Data quality** (RAG) — retrieval returns irrelevant context | [Chunking Strategies](../patterns/data-pipeline/chunking-strategies/) → [Embedding Refresh](../patterns/data-pipeline/embedding-refresh/) |
| **Control** (agents) — agents loop or take unexpected actions | [Agent Loop Guards](../patterns/orchestration/agent-loop-guards/) → [Tool Call Reliability](../patterns/orchestration/tool-call-reliability/) |

---

## Related Resources

- **[Navigation Matrix](../README.md#navigation-matrix)** — Full breakdown of every pattern by system type and priority
- **[Anti-Pattern Catalog](anti-patterns.md)** — The naive approaches teams try before adopting each pattern, and exactly why they fail
- **[Composition Recipes](recipes/)** — How 2–3 patterns wire together for common scenarios
- **[Pattern Selection Decision Tree](decision-tree.md)** — Flowchart from symptoms to pattern recommendations

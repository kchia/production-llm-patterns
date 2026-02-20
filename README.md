# Production LLM Patterns

The more you work with AI in production, the more patterns emerge — retry logic, cost guardrails, eval loops, fallback chains. They show up in every system, regardless of framework or model provider. This repo captures those patterns as framework-agnostic reference implementations — with benchmarks and cost analysis. It's not chasing the latest tool; it's meant to be evergreen.

## Why This Exists

This repo started from a realization: the more I learn about AI in production, the more I see the same patterns across wildly different systems. Retry budgets, circuit breakers, token cost guardrails, eval harnesses — they keep showing up whether you're building RAG, agents, or streaming interfaces.

These patterns are framework-agnostic. They don't chase tools — they occasionally link to them. As AI gets integrated into every product, understanding these production patterns is becoming table stakes for full-stack engineers.

This is my way of consolidating and accelerating that learning. Hopefully you find it useful too. If you have feedback or want to contribute, [open a GitHub issue](https://github.com/kchia/production-llm-patterns/issues) — I'd love to hear from you.

## What Makes This Different

- **Organized by production concern**, not app type -- because your question isn't "how do I build RAG" but "how do I make my RAG survive production"
- **Dual implementations** in TypeScript and Python -- idiomatic, not translated
- **Benchmarks and cost analysis** per pattern -- not just "it works" but "it works at this cost"
- **Failure modes documented** -- every pattern includes how it itself can fail

## How to Use This Repo

### If you're exploring

The Navigation Matrix below maps every pattern to common system types (RAG, agents, streaming, batch). The way I'd navigate it: find the column that matches what I'm building, then look for **Critical** and **Required** — those are what I'd want in place before going to production. **High ROI** patterns are worth prioritizing once the foundation is solid.

### If you landed on a specific pattern

Every pattern follows the same structure. Here's what each section answers:

| Section                             | What it answers                               |
| ----------------------------------- | --------------------------------------------- |
| **The Problem**                     | What breaks in production without this        |
| **What I Would Not Do**             | The naive approach and why it fails           |
| **When You Need This**              | Signals that it's time to adopt               |
| **The Pattern**                     | Architecture + dual TS/Python implementations |
| **Failure Modes**                   | How the pattern itself can break              |
| **Observability & Operations**      | What to monitor once deployed                 |
| **Tuning & Evolution**              | How the pattern changes over months           |
| **Cost Analysis**                   | Dollar costs at 3 scales                      |
| **When This Advice Stops Applying** | Honest boundaries                             |

### If you're building a system from scratch

Patterns at the top of each category tend to be foundational — they're what I'd want in place first. The "Related patterns" section at the bottom of each pattern shows what naturally follows. There's no single right order; the way I'd think about sequencing is: start with whatever's **Critical** for the system type, then layer in **Required** patterns as the system stabilizes.

## Navigation Matrix

Each pattern addresses a production concern. This matrix shows which patterns matter most for each system type.

These four system types represent distinct operational profiles — each creates different failure modes, cost pressures, and pattern priorities:

- **RAG** — Retrieval-augmented generation. A pipeline that fetches context, then generates. The critical concern is data quality: chunking, embedding freshness, and index health determine the output ceiling.
- **Agents** — Autonomous tool-using loops. Multi-step, non-deterministic, and the hardest to observe. The critical concern is control: loop guards, output validation, and injection defense keep them from going off the rails.
- **Streaming** — Real-time token delivery to users. Strict latency constraints with zero tolerance for dropped connections. The critical concern is resilience: failover, circuit breaking, and backpressure keep the stream alive.
- **Batch** — Offline high-throughput processing. Runs without a user waiting, but jobs are expensive and long-lived. The critical concern is recovery: checkpointing, batching, and concurrency management keep costs predictable and failures recoverable.

> **Why these four?** They represent operational profiles. Each one creates a distinct combination of failure modes, latency constraints, and cost pressures that changes which patterns matter most. A customer-facing chatbot is a Streaming system. A document Q&A product is RAG. A coding assistant that calls tools is an Agent. Most real systems combine two or more profiles — an agentic RAG system would check both the RAG and Agents columns.

| Pattern                                                                       | RAG         | Agents      | Streaming   | Batch       |
| ----------------------------------------------------------------------------- | ----------- | ----------- | ----------- | ----------- |
| **Resilience**                                                                |             |             |             |             |
| [Graceful Degradation](patterns/resilience/graceful-degradation/)             | Required    | Required    | Critical    | Recommended |
| Retry with Budget                                                             | Recommended | Required    | Required    | Required    |
| Multi-Provider Failover                                                       | Recommended | High ROI    | Critical    | Recommended |
| Circuit Breaker                                                               | Recommended | Required    | Critical    | Optional    |
| **Cost Control**                                                              |             |             |             |             |
| [Token Budget Middleware](patterns/cost-control/token-budget-middleware/)      | Required    | Required    | Recommended | Required    |
| Semantic Caching                                                              | High ROI    | Low ROI     | N/A         | High ROI    |
| Model Routing                                                                 | Recommended | High ROI    | Recommended | High ROI    |
| Cost Dashboard                                                                | Recommended | Recommended | Recommended | Recommended |
| **Observability**                                                             |             |             |             |             |
| Structured Tracing                                                            | Required    | Critical    | Required    | Recommended |
| Output Quality Monitoring                                                     | Required    | Required    | Recommended | Required    |
| Drift Detection                                                               | Required    | Recommended | Optional    | Required    |
| Prompt Diffing                                                                | Recommended | Recommended | Optional    | Recommended |
| Prompt Version Registry                                                       | Required    | Required    | Recommended | Required    |
| Online Eval Monitoring                                                        | Required    | Required    | Recommended | Required    |
| **Testing**                                                                   |             |             |             |             |
| Eval Harness                                                                  | Required    | Required    | Recommended | Required    |
| Regression Testing                                                            | Required    | Required    | Recommended | Required    |
| Adversarial Inputs                                                            | Recommended | Critical    | Recommended | Optional    |
| Snapshot Testing                                                              | Recommended | Recommended | Optional    | Recommended |
| Prompt Rollout Testing                                                        | Required    | Required    | Recommended | High ROI    |
| **Safety**                                                                    |             |             |             |             |
| [Structured Output Validation](patterns/safety/structured-output-validation/) | Required    | Critical    | Required    | Required    |
| PII Detection                                                                 | Required    | Required    | Required    | Required    |
| Prompt Injection Defense                                                      | Required    | Critical    | Required    | Recommended |
| Human-in-the-Loop                                                             | Optional    | Required    | N/A         | Optional    |
| **Data Pipeline**                                                             |             |             |             |             |
| Chunking Strategies                                                           | Critical    | Optional    | N/A         | Recommended |
| Embedding Refresh                                                             | Required    | Optional    | N/A         | Required    |
| Index Maintenance                                                             | Required    | Optional    | N/A         | Recommended |
| Context Management                                                            | Recommended | Required    | Required    | Optional    |
| **Orchestration**                                                             |             |             |             |             |
| Agent Loop Guards                                                             | Optional    | Critical    | Recommended | Recommended |
| Tool Call Reliability                                                         | Recommended | Critical    | Optional    | Recommended |
| State Checkpointing                                                           | Optional    | Required    | N/A         | Critical    |
| Multi-Agent Routing                                                           | Optional    | Critical    | Optional    | Recommended |
| **Performance**                                                               |             |             |             |             |
| Latency Budget                                                                | Required    | Recommended | Critical    | Optional    |
| Request Batching                                                              | High ROI    | Optional    | N/A         | Critical    |
| Concurrent Request Management                                                 | Required    | Required    | Recommended | Critical    |
| Streaming Backpressure                                                        | Optional    | Optional    | Critical    | N/A         |

**Legend — how these designations work:**

The priority scale reflects what I'd want in place at each stage. Four levels, from "can't ship without" to "depends on context":

- **Critical** — absence risks outages or data integrity failures. These go in first. _The test: could this system type break in production without it?_
- **Required** — the system runs without it, but it's not production-ready. _The test: would I be comfortable getting paged without this in place?_
- **Recommended** — solid engineering practice. Won't cause immediate damage if skipped, but the system's harder to operate or debug over time. _The test: would I notice the gap in the first month, or the sixth?_
- **Optional** — context-dependent. Valuable for some deployments, irrelevant for others. _The test: does my specific setup actually create the problem this pattern solves?_

**High ROI** and **Low ROI** sit on a separate axis — they're about return on investment, not necessity. A High ROI pattern isn't required, but the cost or reliability gains often pay for the implementation effort quickly. Low ROI means the pattern applies but the gains are marginal for that system type.

**N/A** — the pattern doesn't apply to that system type.

## Pattern Categories

### [Resilience](patterns/resilience/)

What happens when things go wrong. Fallbacks, retries, failover, circuit breaking.

### [Cost Control](patterns/cost-control/)

Making AI affordable at scale. Budgets, caching, routing, visibility.

### [Observability](patterns/observability/)

Knowing what your system is doing. Tracing, quality monitoring, drift detection.

### [Testing](patterns/testing/)

Verifying non-deterministic systems. Evaluation, regression, adversarial, snapshot.

### [Safety](patterns/safety/)

Guarding inputs and outputs. Validation, PII, injection defense, human oversight.

### [Data Pipeline](patterns/data-pipeline/)

The retrieval layer. Chunking, embeddings, index health, context management.

### [Orchestration](patterns/orchestration/)

Keeping multi-step and multi-agent LLM systems alive. Loop guards, tool resilience, state recovery, routing.

### [Performance](patterns/performance/)

Making LLM systems fast at scale. Latency budgets, batching, concurrency, backpressure.

## Integrations

Patterns are designed to be composed. The [integrations/](integrations/) directory shows how patterns combine for specific system types:

- [RAG Systems](integrations/rag/) -- Which patterns to combine and in what order
- [Agent Systems](integrations/agents/) -- Patterns for autonomous tool-using systems
- [Multi-Agent Systems](integrations/multi-agent/) -- Patterns for multi-agent coordination and routing
- [Streaming Systems](integrations/streaming/) -- Patterns for real-time LLM responses
- [Batch Systems](integrations/batch/) -- Patterns for high-throughput offline processing

## Shared Utilities

The [shared/](shared/) directory contains reusable utilities used across patterns:

- [Cost Tracker](shared/cost-tracker/) -- Token counting and spend tracking
- [Trace Logger](shared/trace-logger/) -- Structured logging for LLM calls
- [Test Fixtures](shared/test-fixtures/) -- Common test data and mock providers
- [Latency Tracker](shared/latency-tracker/) -- Latency budget propagation and measurement
- [Prompt Registry](shared/prompt-registry/) -- Prompt version storage and retrieval

## Philosophy

This repo reflects a specific point of view about production AI systems:

1. **The model is 5% of the system.** The other 95% -- data pipelines, error handling, cost controls, observability -- determines whether your system works in production.
2. **Failure modes matter more than features.** Every pattern documents how it itself can fail, because production is about resilience, not optimism.
3. **Cost is a first-class concern.** Every pattern includes cost analysis because "it works" without "at what cost" is an incomplete answer.
4. **Honest uncertainty over false confidence.** Every pattern includes boundary conditions -- when the advice stops applying.
5. **Data quality is your ceiling.** The model can't outperform what you feed it. Several patterns in this repo exist solely because upstream data isn't as clean as you think.
6. **Systems that don't learn, decay.** A deployed pattern isn't done. Every pattern documents tuning levers and drift signals because what works at launch degrades over months.

## Companion Content

This repo is part of a larger effort to build durable thinking around production AI. Two primary companion resources:

- **[Mental Models for Production AI](https://prompt-deploy.beehiiv.com/archive?tags=Mental+Models+for+Production+AI)** — A blog series on evergreen mental frameworks for evaluating, building, and operating AI features in production. Thinking over tooling.
- **[AI System Design Notes](https://github.com/kchia/ai-system-design-notes)** — Applying those mental models to real-world AI system design, with structured design reviews covering architecture, failure modes, cost analysis, and deployment.

Each pattern also has a companion blog post on [Prompt Deploy](https://prompt-deploy.com) that goes deeper on the reasoning and judgment behind the pattern.

## License

MIT

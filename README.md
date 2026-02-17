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

## Navigation Matrix

Each pattern addresses a production concern. This matrix shows which patterns matter most for each system type.

| Pattern                                                                              | RAG         | Agents      | Streaming   | Batch       |
| ------------------------------------------------------------------------------------ | ----------- | ----------- | ----------- | ----------- |
| **Resilience**                                                                       |             |             |             |             |
| [Graceful Degradation](patterns/resilience/graceful-degradation/)                    | Required    | Required    | Critical    | Recommended |
| [Retry with Budget](patterns/resilience/retry-with-budget/)                          | Recommended | Required    | Required    | Required    |
| [Multi-Provider Failover](patterns/resilience/multi-provider-failover/)              | Recommended | High ROI    | Critical    | Recommended |
| [Circuit Breaker](patterns/resilience/circuit-breaker/)                              | Recommended | Required    | Critical    | Optional    |
| **Cost Control**                                                                     |             |             |             |             |
| [Token Budget Middleware](patterns/cost-control/token-budget-middleware/)            | Required    | Required    | Recommended | Required    |
| [Semantic Caching](patterns/cost-control/semantic-caching/)                          | High ROI    | Low ROI     | N/A         | High ROI    |
| [Model Routing](patterns/cost-control/model-routing/)                                | Recommended | High ROI    | Recommended | High ROI    |
| [Cost Dashboard](patterns/cost-control/cost-dashboard/)                              | Recommended | Recommended | Recommended | Recommended |
| **Observability**                                                                    |             |             |             |             |
| [Structured Tracing](patterns/observability/structured-tracing/)                     | Required    | Critical    | Required    | Recommended |
| [Output Quality Monitoring](patterns/observability/output-quality-monitoring/)       | Required    | Required    | Recommended | Required    |
| [Drift Detection](patterns/observability/drift-detection/)                           | Required    | Recommended | Optional    | Required    |
| [Prompt Diffing](patterns/observability/prompt-diffing/)                             | Recommended | Recommended | Optional    | Recommended |
| [Prompt Version Registry](patterns/observability/prompt-version-registry/)           | Required    | Required    | Recommended | Required    |
| [Online Eval Monitoring](patterns/observability/online-eval-monitoring/)             | Required    | Required    | Recommended | Required    |
| **Testing**                                                                          |             |             |             |             |
| [Eval Harness](patterns/testing/eval-harness/)                                       | Required    | Required    | Recommended | Required    |
| [Regression Testing](patterns/testing/regression-testing/)                           | Required    | Required    | Recommended | Required    |
| [Adversarial Inputs](patterns/testing/adversarial-inputs/)                           | Recommended | Critical    | Recommended | Optional    |
| [Snapshot Testing](patterns/testing/snapshot-testing/)                               | Recommended | Recommended | Optional    | Recommended |
| [Prompt Rollout Testing](patterns/testing/prompt-rollout-testing/)                   | Required    | Required    | Recommended | High ROI    |
| **Safety**                                                                           |             |             |             |             |
| [Structured Output Validation](patterns/safety/structured-output-validation/)        | Required    | Critical    | Required    | Required    |
| [PII Detection](patterns/safety/pii-detection/)                                      | Required    | Required    | Required    | Required    |
| [Prompt Injection Defense](patterns/safety/prompt-injection-defense/)                | Required    | Critical    | Required    | Recommended |
| [Human-in-the-Loop](patterns/safety/human-in-the-loop/)                              | Optional    | Required    | N/A         | Optional    |
| **Data Pipeline**                                                                    |             |             |             |             |
| [Chunking Strategies](patterns/data-pipeline/chunking-strategies/)                   | Critical    | Optional    | N/A         | Recommended |
| [Embedding Refresh](patterns/data-pipeline/embedding-refresh/)                       | Required    | Optional    | N/A         | Required    |
| [Index Maintenance](patterns/data-pipeline/index-maintenance/)                       | Required    | Optional    | N/A         | Recommended |
| [Context Management](patterns/data-pipeline/context-management/)                     | Recommended | Required    | Required    | Optional    |
| **Orchestration**                                                                    |             |             |             |             |
| [Agent Loop Guards](patterns/orchestration/agent-loop-guards/)                       | Optional    | Critical    | Recommended | Recommended |
| [Tool Call Reliability](patterns/orchestration/tool-call-reliability/)               | Recommended | Critical    | Optional    | Recommended |
| [State Checkpointing](patterns/orchestration/state-checkpointing/)                   | Optional    | Required    | N/A         | Critical    |
| [Multi-Agent Routing](patterns/orchestration/multi-agent-routing/)                   | Optional    | Critical    | Optional    | Recommended |
| **Performance**                                                                      |             |             |             |             |
| [Latency Budget](patterns/performance/latency-budget/)                               | Required    | Recommended | Critical    | Optional    |
| [Request Batching](patterns/performance/request-batching/)                           | High ROI    | Optional    | N/A         | Critical    |
| [Concurrent Request Management](patterns/performance/concurrent-request-management/) | Required    | Required    | Recommended | Critical    |
| [Streaming Backpressure](patterns/performance/streaming-backpressure/)               | Optional    | Optional    | Critical    | N/A         |

**Legend:** Critical = will break without it | Required = should have before production | High ROI = significant cost/reliability improvement | Recommended = good practice | Optional = context-dependent | N/A = not applicable

## Pattern Structure

Each pattern contains:

```
patterns/<category>/<pattern-name>/
├── README.md              # Problem, pattern, failure modes, cost analysis, boundary conditions
├── src/
│   ├── ts/                # TypeScript implementation (idiomatic)
│   └── py/                # Python implementation (idiomatic)
├── benchmarks/results.md  # Latency, throughput, cost comparisons
├── cost-analysis.md       # Token/dollar estimates at 1K, 10K, 100K requests/day
└── .env.example
```

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

## Roadmap

### Phase 1: Launch Set

- [ ] Graceful Degradation
- [ ] Structured Output Validation
- [ ] Token Budget Middleware
- [ ] Eval Harness

### Phase 2: Depth

- [ ] Semantic Caching
- [ ] Structured Tracing
- [ ] Multi-Provider Failover
- [ ] Chunking Strategy Comparison
- [ ] Agent Loop Guards
- [ ] Latency Budget
- [ ] Prompt Version Registry

### Phase 3: Breadth

- [ ] Tool Call Reliability
- [ ] Concurrent Request Management
- [ ] Prompt Rollout Testing
- [ ] Online Eval Monitoring
- [ ] State Checkpointing
- [ ] Request Batching
- [ ] Multi-Agent Routing
- [ ] Streaming Backpressure

### Phase 4: Community

- [ ] Open for contributions

## Philosophy

This repo reflects a specific point of view about production AI systems:

1. **The model is 5% of the system.** The other 95% -- data pipelines, error handling, cost controls, observability -- determines whether your system works in production.
2. **Failure modes matter more than features.** Every pattern documents how it itself can fail, because production is about resilience, not optimism.
3. **Cost is a first-class concern.** Every pattern includes cost analysis because "it works" without "at what cost" is an incomplete answer.
4. **Honest uncertainty over false confidence.** Every pattern includes boundary conditions -- when the advice stops applying.

## Companion Content

This repo is part of a larger effort to build durable thinking around production AI. Two primary companion resources:

- **[Mental Models for Production AI](https://prompt-deploy.beehiiv.com/archive?tags=Mental+Models+for+Production+AI)** — A blog series on evergreen mental frameworks for evaluating, building, and operating AI features in production. Thinking over tooling.
- **[AI System Design Notes](https://github.com/kchia/ai-system-design-notes)** — Applying those mental models to real-world AI system design, with structured design reviews covering architecture, failure modes, cost analysis, and deployment.

Each pattern also has a companion blog post on [Prompt Deploy](https://prompt-deploy.com) that goes deeper on the reasoning and judgment behind the pattern.

## License

MIT

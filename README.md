# production-llm-patterns

Production-grade patterns for LLM systems: failure handling, cost control, observability, and testing -- with runnable code, benchmarks, and cost analysis.

## Why This Exists

Most LLM resources show you how to build it. This repo shows you how to ship it.

If you're looking for how to build a RAG app, start with [awesome-llm-apps](https://github.com/Shubhamsaboo/awesome-llm-apps). When you're ready to ship it to production, come back here.

## What Makes This Different

- **Organized by production concern**, not app type -- because your question isn't "how do I build RAG" but "how do I make my RAG survive production"
- **Dual implementations** in TypeScript and Python -- idiomatic, not translated
- **Benchmarks and cost analysis** per pattern -- not just "it works" but "it works at this cost"
- **Failure modes documented** -- every pattern includes how it itself can fail

## Navigation Matrix

Each pattern addresses a production concern. This matrix shows which patterns matter most for each system type.

| Pattern | RAG | Agents | Streaming | Batch |
|---------|-----|--------|-----------|-------|
| **Resilience** | | | | |
| [Graceful Degradation](patterns/resilience/graceful-degradation/) | Required | Required | Critical | Recommended |
| [Retry with Budget](patterns/resilience/retry-with-budget/) | Recommended | Required | Required | Required |
| [Multi-Provider Failover](patterns/resilience/multi-provider-failover/) | Recommended | High ROI | Critical | Recommended |
| [Circuit Breaker](patterns/resilience/circuit-breaker/) | Recommended | Required | Critical | Optional |
| **Cost Control** | | | | |
| [Token Budget Middleware](patterns/cost-control/token-budget-middleware/) | Required | Required | Recommended | Required |
| [Semantic Caching](patterns/cost-control/semantic-caching/) | High ROI | Low ROI | N/A | High ROI |
| [Model Routing](patterns/cost-control/model-routing/) | Recommended | High ROI | Recommended | High ROI |
| [Cost Dashboard](patterns/cost-control/cost-dashboard/) | Recommended | Recommended | Recommended | Recommended |
| **Observability** | | | | |
| [Structured Tracing](patterns/observability/structured-tracing/) | Required | Critical | Required | Recommended |
| [Output Quality Monitoring](patterns/observability/output-quality-monitoring/) | Required | Required | Recommended | Required |
| [Drift Detection](patterns/observability/drift-detection/) | Required | Recommended | Optional | Required |
| [Prompt Diffing](patterns/observability/prompt-diffing/) | Recommended | Recommended | Optional | Recommended |
| **Testing** | | | | |
| [Eval Harness](patterns/testing/eval-harness/) | Required | Required | Recommended | Required |
| [Regression Testing](patterns/testing/regression-testing/) | Required | Required | Recommended | Required |
| [Adversarial Inputs](patterns/testing/adversarial-inputs/) | Recommended | Critical | Recommended | Optional |
| [Snapshot Testing](patterns/testing/snapshot-testing/) | Recommended | Recommended | Optional | Recommended |
| **Safety** | | | | |
| [Output Validation](patterns/safety/output-validation/) | Required | Critical | Required | Required |
| [PII Detection](patterns/safety/pii-detection/) | Required | Required | Required | Required |
| [Prompt Injection Defense](patterns/safety/prompt-injection-defense/) | Required | Critical | Required | Recommended |
| [Human-in-the-Loop](patterns/safety/human-in-the-loop/) | Optional | Required | N/A | Optional |
| **Data Pipeline** | | | | |
| [Chunking Strategies](patterns/data-pipeline/chunking-strategies/) | Critical | Optional | N/A | Recommended |
| [Embedding Refresh](patterns/data-pipeline/embedding-refresh/) | Required | Optional | N/A | Required |
| [Index Maintenance](patterns/data-pipeline/index-maintenance/) | Required | Optional | N/A | Recommended |
| [Context Management](patterns/data-pipeline/context-management/) | Recommended | Required | Required | Optional |

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

## Integrations

Patterns are designed to be composed. The [integrations/](integrations/) directory shows how patterns combine for specific system types:

- [RAG Systems](integrations/rag/) -- Which patterns to combine and in what order
- [Agent Systems](integrations/agents/) -- Patterns for autonomous tool-using systems
- [Streaming Systems](integrations/streaming/) -- Patterns for real-time LLM responses

## Shared Utilities

The [shared/](shared/) directory contains reusable utilities used across patterns:

- [Cost Tracker](shared/cost-tracker/) -- Token counting and spend tracking
- [Trace Logger](shared/trace-logger/) -- Structured logging for LLM calls
- [Test Fixtures](shared/test-fixtures/) -- Common test data and mock providers

## Roadmap

### Phase 1: Launch Set (Weeks 2-5)
- [ ] Graceful Degradation
- [ ] Structured Output Validation
- [ ] Token Budget Middleware
- [ ] Eval Harness

### Phase 2: Depth (Weeks 6-9)
- [ ] Semantic Caching
- [ ] Structured Tracing
- [ ] Multi-Provider Failover
- [ ] Chunking Strategy Comparison

### Phase 3: Community (Weeks 10+)
- [ ] Open for contributions

## Philosophy

This repo reflects a specific point of view about production AI systems:

1. **The model is 5% of the system.** The other 95% -- data pipelines, error handling, cost controls, observability -- determines whether your system works in production.
2. **Failure modes matter more than features.** Every pattern documents how it itself can fail, because production is about resilience, not optimism.
3. **Cost is a first-class concern.** Every pattern includes cost analysis because "it works" without "at what cost" is an incomplete answer.
4. **Honest uncertainty over false confidence.** Every pattern includes boundary conditions -- when the advice stops applying.

## Companion Content

Each pattern has a companion blog post on [Prompt Deploy](https://prompt-deploy.com) that goes deeper on the reasoning and judgment behind the pattern.

## License

MIT

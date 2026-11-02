# Changelog

All notable additions and changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). This is a content repo, not versioned software — entries are grouped by sprint or major release batch rather than semver.

---

## [Unreleased]

---

## [Post-Pattern: Repository Completion] — 2026-04-21 to 2026-04-27

### Added
- **Framework Adapters** (`examples/`) — four thin wrappers showing patterns in context with popular frameworks:
  - `examples/raw-sdk/` — plain Anthropic/OpenAI SDK usage
  - `examples/vercel-ai/` — Vercel AI SDK integration
  - `examples/langchain/` — LangChain integration
  - `examples/llamaindex/` — LlamaIndex integration
- **Shared Utilities** (`shared/`) — extracted libraries reused across patterns:
  - `shared/cost-tracker/` — token cost accounting across models
  - `shared/latency-tracker/` — latency measurement and budget tracking
  - `shared/trace-logger/` — structured trace output
  - `shared/prompt-registry/` — version-aware prompt storage and retrieval
  - `shared/test-fixtures/` — mock providers and shared test helpers
- **Anti-Pattern Catalog** (`docs/anti-patterns.md`) — all "What I Would Not Do" sections in one searchable document, organized by category with links back to source patterns
- **Composition Recipes** (`docs/recipes/`) — five problem-oriented guides showing 2–3 patterns wired together:
  - `resilience-stack.md` — Retry + Circuit Breaker + Graceful Degradation
  - `cost-control-stack.md` — Token Budget + Model Routing + Semantic Caching
  - `safe-prompt-iteration.md` — Eval Harness + Prompt Rollout Testing + Online Eval Monitoring
  - `rag-quality-stack.md` — Chunking Strategies + Output Quality Monitoring + Regression Testing
  - `agent-safety-stack.md` — Agent Loop Guards + Tool Call Reliability + Prompt Injection Defense
- **Adoption Roadmap** (`docs/adoption-roadmap.md`) — timeline-based adoption guide: Week 1 essentials, Month 1 core resilience + observability, Quarter 1 full coverage by system type
- **Pattern Selection Decision Tree** (`docs/decision-tree.md`) — Mermaid flowchart guiding from symptoms to patterns, with text fallback
- **Incident Case Studies** (`docs/case-studies/`) — three deep-dive analyses through the lens of which patterns would have helped:
  - `openai-december-2024-outage.md` — cascading failure case (Circuit Breaker, Multi-Provider Failover)
  - `gpt4o-sycophancy-rollback.md` — model behavior regression case (Prompt Rollout Testing, Online Eval Monitoring)
  - `retry-storm-incident.md` — retry amplification case (Retry with Budget, Concurrent Request Management)
- **Repo hygiene** — MIT `LICENSE`, `CONTRIBUTING.md` with contribution guidelines, `.github/ISSUE_TEMPLATE/` for pattern requests, bug reports, and improvement proposals, `.github/PULL_REQUEST_TEMPLATE.md`

### Changed
- **README** refactored with table of contents, Guides section, Contributing link, and fixed stale navigation links

---

## [Post-Pattern: Integration Guides] — 2026-04-05 to 2026-04-09

### Added
- **Integration Guide: RAG Systems** (`integrations/rag/README.md`) — adoption sequence, wiring guide, and tradeoff analysis for retrieval-augmented generation systems
- **Integration Guide: Agent Systems** (`integrations/agents/README.md`) — adoption sequence, wiring guide, and tradeoff analysis for autonomous tool-using loops
- **Integration Guide: Streaming Systems** (`integrations/streaming/README.md`) — adoption sequence, wiring guide, and tradeoff analysis for real-time token delivery
- **Integration Guide: Batch Systems** (`integrations/batch/README.md`) — adoption sequence, wiring guide, and tradeoff analysis for offline high-throughput processing
- **Integration Guide: Multi-Agent Systems** (`integrations/multi-agent/README.md`) — adoption sequence, wiring guide, and tradeoff analysis for multi-agent coordination pipelines

Each guide includes system-level architecture diagrams, dependency-ordered adoption sequences, TS + Python wiring snippets, and an honest tradeoffs section covering what to skip early-stage vs. what to add at scale.

---

## [Sprint 9: "Completeness"] — 2026-04-01 to 2026-04-03

_Category capstones. Closing out every category with its final pattern._

### Added
- **Cost Dashboard** (`patterns/cost-control/cost-dashboard/`) — per-request cost tracking, attribution, and alerting to surface spending anomalies before they compound
- **Snapshot Testing** (`patterns/testing/snapshot-testing/`) — captures and version-controls model output snapshots to catch silent regressions across prompt or model updates
- **Human-in-the-Loop** (`patterns/safety/human-in-the-loop/`) — structured escalation paths that pause automated workflows for human review at configurable confidence thresholds
- **Prompt Diffing** (`patterns/observability/prompt-diffing/`) — semantic and structural diffing of prompt versions to understand what changed and predict output impact

Each pattern ships with TypeScript and Python implementations, benchmarks, cost analysis, failure mode documentation, and Observability & Operations guidance.

---

## [Sprint 8: "The Long Game"] — 2026-03-28 to 2026-04-01

_Drift, stale data, and multi-agent coordination — the 6-month problems._

### Added
- **Drift Detection** (`patterns/observability/drift-detection/`) — statistical monitoring of LLM output distributions to surface model or data drift before it degrades downstream metrics
- **Embedding Refresh** (`patterns/data-pipeline/embedding-refresh/`) — scheduled re-embedding pipeline with staleness tracking to keep vector stores aligned with updated source content
- **Index Maintenance** (`patterns/data-pipeline/index-maintenance/`) — incremental index update strategies for RAG systems, covering deletion propagation and consistency across segments
- **Multi-Agent Routing** (`patterns/orchestration/multi-agent-routing/`) — dynamic task routing across specialized sub-agents with circuit-breaking and result aggregation

---

## [Sprint 7: "Scaling Up"] — 2026-03-20 to 2026-03-28

_Concurrency, batching, and performance. Three performance patterns in one sprint by design._

### Added
- **Concurrent Request Management** (`patterns/performance/concurrent-request-management/`) — adaptive concurrency control with backpressure to maximize throughput without overwhelming provider rate limits
- **Prompt Rollout Testing** (`patterns/testing/prompt-rollout-testing/`) — canary-style prompt releases with automated rollback triggers based on eval score thresholds
- **State Checkpointing** (`patterns/orchestration/state-checkpointing/`) — durable mid-run state snapshots for long-running agent workflows, enabling recovery without restarting from scratch
- **Request Batching** (`patterns/performance/request-batching/`) — intelligent grouping of pending requests to reduce per-request overhead and cost for async workloads
- **Streaming Backpressure** (`patterns/performance/streaming-backpressure/`) — token delivery pacing that matches consumer read speed, preventing buffer overflow and dropped connections

---

## [Sprint 6: "The Data Layer"] — 2026-03-15 to 2026-03-20

_RAG foundations, tool reliability, and production eval._

### Added
- **Chunking Strategies** (`patterns/data-pipeline/chunking-strategies/`) — adaptive document segmentation with overlap tuning and semantic boundary detection for RAG retrieval quality
- **Tool Call Reliability** (`patterns/orchestration/tool-call-reliability/`) — retry logic, schema validation, and structured fallbacks for LLM-generated tool invocations
- **Online Eval Monitoring** (`patterns/observability/online-eval-monitoring/`) — continuous in-production quality scoring using lightweight LLM-as-judge calls on sampled traffic
- **Context Management** (`patterns/data-pipeline/context-management/`) — dynamic context window budgeting and compression strategies that preserve retrieval quality under token constraints

---

## [Sprint 5: "Trust But Verify"] — 2026-03-11 to 2026-03-14

_Safety, quality monitoring, and the $47 infinite loop._

### Added
- **Prompt Injection Defense** (`patterns/safety/prompt-injection-defense/`) — multi-layer detection and neutralization of adversarial instructions embedded in user inputs or retrieved content
- **Output Quality Monitoring** (`patterns/observability/output-quality-monitoring/`) — production-time quality scoring with configurable dimensions (relevance, faithfulness, coherence) and alerting
- **Agent Loop Guards** (`patterns/orchestration/agent-loop-guards/`) — hard iteration limits, cost budgets, and semantic cycle detection to prevent unbounded agent loops
- **Adversarial Inputs** (`patterns/testing/adversarial-inputs/`) — systematic red-teaming library for generating boundary-pushing inputs that expose model safety and reliability gaps

---

## [Sprint 4: "Measure Everything"] — 2026-03-06 to 2026-03-10

_Cost meets performance. Now that you can see, measure the impact._

### Added
- **Regression Testing** (`patterns/testing/regression-testing/`) — automated eval runs on every prompt change, gating deploys on quality score thresholds
- **Semantic Caching** (`patterns/cost-control/semantic-caching/`) — embedding-based response caching that matches semantically similar queries to cached results, cutting redundant API spend
- **Model Routing** (`patterns/cost-control/model-routing/`) — rule-based and score-based routing between model tiers to minimize cost while maintaining output quality
- **Latency Budget** (`patterns/performance/latency-budget/`) — hierarchical latency allocation across pipeline stages with per-stage timeouts and budget enforcement

---

## [Sprint 3: "Now You Can See"] — 2026-03-02 to 2026-03-04

_You can't fix what you can't see. Observability foundations._

### Added
- **Structured Tracing** (`patterns/observability/structured-tracing/`) — span-based request tracing with configurable sampling, provider attribution, and latency breakdowns
- **Multi-Provider Failover** (`patterns/resilience/multi-provider-failover/`) — priority-ordered provider cascade with health tracking, routing around failures across OpenAI, Anthropic, and others
- **Prompt Version Registry** (`patterns/observability/prompt-version-registry/`) — versioned prompt storage with A/B assignment and audit log for correlating prompt changes to output quality shifts

---

## [Sprint 2: "Hardening the Foundation"] — 2026-02-24 to 2026-02-27

_Your retries are making things worse._

### Added
- **Retry with Budget** (`patterns/resilience/retry-with-budget/`) — exponential backoff with jitter and a global retry budget that prevents retry storms from amplifying provider incidents
- **Circuit Breaker** (`patterns/resilience/circuit-breaker/`) — half-open state machine that short-circuits failing providers until they recover, protecting downstream systems from cascading failures
- **PII Detection** (`patterns/safety/pii-detection/`) — pre-flight scanning with configurable entity types (names, emails, SSNs, PHI) and action policies (redact, flag, block)

---

## [Sprint 1: "Your System Is Failing"] — 2026-02-13 to 2026-02-23

_The opening set. Maximum drama, universal problems, four different categories._

### Added
- **Initial repository scaffold** — 35 pattern directories pre-populated with scoped outlines, navigation matrix, content calendar, and PATTERN_TEMPLATE.md
- **Graceful Degradation** (`patterns/resilience/graceful-degradation/`) — tiered fallback chains that return degraded-but-usable responses when the primary LLM path fails, with configurable quality floors
- **Structured Output Validation** (`patterns/safety/structured-output-validation/`) — schema-enforced output parsing with retry logic, partial extraction, and a fallback path for malformed completions
- **Token Budget Middleware** (`patterns/cost-control/token-budget-middleware/`) — per-request and per-session token accounting with configurable hard and soft caps that fire before the API call
- **Eval Harness** (`patterns/testing/eval-harness/`) — foundational evaluation framework with scorer registry, dataset management, and baseline comparison used by Regression Testing, Adversarial Inputs, and Snapshot Testing

All Sprint 1 patterns ship with dual TypeScript + Python implementations, mock providers, benchmarks, cost analysis at 1K/10K/100K req/day, and Observability & Operations guidance.

---

## Notes for Returning Readers

- **All 35 patterns are complete** as of Sprint 9. Each ships with dual TS/Python implementations, benchmarks, failure mode documentation, and cost projections.
- **Post-pattern content** (integration guides, shared utilities, docs) was added in April 2026.
- **"Port" tasks** (adding a second-language implementation to patterns built TS-first) are noted in individual pattern audit results and may receive future updates.
- Corrections and quality improvements to existing patterns are not individually listed here — see `git log patterns/<category>/<name>/` for per-pattern history.

# Content Calendar: Pattern Build Sequence

Master sequencing for all 35 patterns across 9 sprints (~17 weeks at 2 patterns/week).

## Progress Tracker

- [x] Graceful Degradation
- [ ] Structured Output Validation
- [ ] Token Budget Middleware
- [ ] Eval Harness
- [ ] Retry with Budget
- [ ] Circuit Breaker
- [ ] PII Detection
- [ ] Structured Tracing
- [ ] Multi-Provider Failover
- [ ] Prompt Version Registry
- [ ] Regression Testing
- [ ] Semantic Caching
- [ ] Model Routing
- [ ] Latency Budget
- [ ] Prompt Injection Defense
- [ ] Output Quality Monitoring
- [ ] Agent Loop Guards
- [ ] Adversarial Inputs
- [ ] Chunking Strategies
- [ ] Tool Call Reliability
- [ ] Online Eval Monitoring
- [ ] Context Management
- [ ] Concurrent Request Management
- [ ] Prompt Rollout Testing
- [ ] State Checkpointing
- [ ] Request Batching
- [ ] Streaming Backpressure
- [ ] Drift Detection
- [ ] Embedding Refresh
- [ ] Index Maintenance
- [ ] Multi-Agent Routing
- [ ] Cost Dashboard
- [ ] Snapshot Testing
- [ ] Human-in-the-Loop
- [ ] Prompt Diffing

## Governing Principles

1. **Narrative arc**: "System is failing" → "Too expensive" → "Can't see" → "Can't test" → "Not safe" → "Data layer" → "Orchestrating complexity" → "Making it fast"
2. **Category interleaving**: Never 3+ patterns from the same category in a row (exception: Sprint 7 "Scaling Up" has 3 performance patterns, acceptable for the theme)
3. **Dependencies respected**: Hard deps strictly honored — no pattern appears before its prerequisite
4. **Universal pain points first**: Problems every team hits before specialized ones
5. **Sprint 1 = Tier 3 showcase**: First 4 patterns get real API benchmarks

---

## Phase 0: Outline All Patterns

Before deep-diving any single pattern, create lightweight outlines for all 35 patterns. This is a scoping exercise, not a research effort.

### Why outline first

1. **Scoping clarity**: Knowing what later patterns cover prevents early patterns from claiming too much territory. When you research Graceful Degradation (#1), knowing what Circuit Breaker (#6) and Multi-Provider Failover (#9) will cover helps you draw clean boundaries.
2. **Related Patterns for free**: The template has a "Related patterns" section. Outlines establish the full graph so every pattern can list its related patterns from day one — including forward references.
3. **Consistent vocabulary**: 35 patterns across 8 categories need shared terminology. Outlining all 35 forces naming decisions early, when they're cheap to fix.
4. **Better blog narrative**: All 35 problem statements written upfront enables confident forward references in blog posts: "In Sprint 5, we'll tackle prompt injection — but first, you need structured validation."
5. **Research quality improves**: Knowing a pattern is the foundation for 5 later patterns shapes what you research — you'll look for frameworks that support those downstream use cases.

### What to outline

For each of the 35 patterns, create a `README.md` from `PATTERN_TEMPLATE.md` with these sections filled:

| Section | What to Write | Source |
|---|---|---|
| **The Problem** | 2-3 sentence problem framing | Category knowledge + navigation matrix |
| **When You Need This** | Adoption signals from matrix density | Navigation matrix (Required/Critical/High ROI) |
| **When This Advice Stops Applying** | Boundary conditions | Category scope |
| **Related Patterns** | Hard + soft deps | Dependency map below |

Leave all other sections (Architecture, Failure Modes, implementations, benchmarks, cost analysis, ops) as template placeholders — these require real research and design work.

### What happens next

Each pattern's deep-dive (Steps 1–9 in PLAYBOOK.md) will revise and deepen the outline. Step 1 (`/research`) replaces the four research sections with researched content. The outline gives `/research` a head start and ensures every pattern is scoped relative to the full landscape.

---

## The 9 Sprints

### Sprint 1: "Your System is Failing" — Launch Set (Tier 3 candidates)

_Week 1–2. The opening salvo. Maximum drama, universal problems, 4 different categories._

| #   | Pattern                                                                       | Category     | Why Here                                                                         |
| --- | ----------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------- |
| 1   | [Graceful Degradation](patterns/resilience/graceful-degradation/)             | resilience   | Flagship. Max drama. Establishes `shared/test-fixtures` conventions              |
| 2   | [Structured Output Validation](patterns/safety/structured-output-validation/) | safety       | 4/4 navigation matrix density. Universal problem. Introduces validation patterns |
| 3   | [Token Budget Middleware](patterns/cost-control/token-budget-middleware/)     | cost-control | #1 concern for eng leaders. Builds `shared/cost-tracker`                         |
| 4   | [Eval Harness](patterns/testing/eval-harness/)                                | testing      | Foundation for 4+ later patterns. "Flying blind without this"                    |

**Key decision**: Structured Output Validation is here (over Retry with Budget) because it has 4/4 Required-or-Critical density in the navigation matrix, gives Sprint 1 category diversity (resilience + safety + cost + testing instead of 2× resilience), and Retry with Budget naturally leads into Circuit Breaker in Sprint 2.

**Shared utilities built**: `shared/test-fixtures`, `shared/cost-tracker`

---

### Sprint 2: "Hardening the Foundation"

_Week 3–4. The resilience deep-dive. Your retries are making things worse._

| #   | Pattern                                                     | Category   | Why Here                                                                 |
| --- | ----------------------------------------------------------- | ---------- | ------------------------------------------------------------------------ |
| 5   | [Retry with Budget](patterns/resilience/retry-with-budget/) | resilience | Prerequisite for Circuit Breaker. "Budget" theme connects to Sprint 1    |
| 6   | [Circuit Breaker](patterns/resilience/circuit-breaker/)     | resilience | Depends on #5. "Your retries are making things worse"                    |
| 7   | [PII Detection](patterns/safety/pii-detection/)             | safety     | 4/4 Required density. Regulatory urgency. Category break from resilience |

**Buffer week**: Roundup post + catch-up after Sprint 2.

---

### Sprint 3: "Now You Can See"

_Week 5–6. You can't fix what you can't see. Observability foundations._

| #   | Pattern                                                                    | Category      | Why Here                                                                                  |
| --- | -------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------- |
| 8   | [Structured Tracing](patterns/observability/structured-tracing/)           | observability | Foundation for all observability patterns. Builds `shared/trace-logger`                   |
| 9   | [Multi-Provider Failover](patterns/resilience/multi-provider-failover/)    | resilience    | Completes resilience trilogy. Depends on #1 (Graceful Degradation), #6 (Circuit Breaker)  |
| 10  | [Prompt Version Registry](patterns/observability/prompt-version-registry/) | observability | Builds `shared/prompt-registry`. Foundation for Prompt Diffing and Prompt Rollout Testing |

**Shared utilities built**: `shared/trace-logger`, `shared/prompt-registry`

**Buffer week**: Roundup post + catch-up after Sprint 3.

---

### Sprint 4: "Measure Everything"

_Week 8–9. Now that you can see, measure the impact. Cost meets performance._

| #   | Pattern                                                     | Category     | Why Here                                            |
| --- | ----------------------------------------------------------- | ------------ | --------------------------------------------------- |
| 11  | [Regression Testing](patterns/testing/regression-testing/)  | testing      | Depends on #4 (Eval Harness)                        |
| 12  | [Semantic Caching](patterns/cost-control/semantic-caching/) | cost-control | High ROI. Compelling cost numbers                   |
| 13  | [Model Routing](patterns/cost-control/model-routing/)       | cost-control | Soft dep on #3 (Token Budget). Pairs with caching   |
| 14  | [Latency Budget](patterns/performance/latency-budget/)      | performance  | First perf pattern. Builds `shared/latency-tracker` |

**Shared utilities built**: `shared/latency-tracker`

---

### Sprint 5: "Trust But Verify"

_Week 10–11. Safety, quality monitoring, and the $47 infinite loop._

| #   | Pattern                                                                        | Category      | Why Here                                                  |
| --- | ------------------------------------------------------------------------------ | ------------- | --------------------------------------------------------- |
| 15  | [Prompt Injection Defense](patterns/safety/prompt-injection-defense/)          | safety        | Critical for Agents. High-interest topic                  |
| 16  | [Output Quality Monitoring](patterns/observability/output-quality-monitoring/) | observability | Depends on #8 (Structured Tracing)                        |
| 17  | [Agent Loop Guards](patterns/orchestration/agent-loop-guards/)                 | orchestration | First orchestration pattern. "The $47 infinite loop"      |
| 18  | [Adversarial Inputs](patterns/testing/adversarial-inputs/)                     | testing       | Depends on #4 (Eval Harness). Pairs thematically with #15 |

---

### Sprint 6: "The Data Layer"

_Week 12–13. RAG foundations, tool reliability, and production eval._

| #   | Pattern                                                                  | Category      | Why Here                                                                          |
| --- | ------------------------------------------------------------------------ | ------------- | --------------------------------------------------------------------------------- |
| 19  | [Chunking Strategies](patterns/data-pipeline/chunking-strategies/)       | data-pipeline | Critical for RAG. First data pipeline pattern                                     |
| 20  | [Tool Call Reliability](patterns/orchestration/tool-call-reliability/)   | orchestration | Critical for Agents. Depends on #2 (Structured Output Validation)                 |
| 21  | [Online Eval Monitoring](patterns/observability/online-eval-monitoring/) | observability | Depends on #4 (Eval Harness), #8 (Structured Tracing). "Eval in CI is not enough" |
| 22  | [Context Management](patterns/data-pipeline/context-management/)         | data-pipeline | Required for Agents + Streaming                                                   |

**Milestone**: Pattern 22 = social post. Two-thirds complete.

---

### Sprint 7: "Scaling Up"

_Week 14–15. Concurrency, batching, and the performance patterns. (3 performance patterns acceptable for theme.)_

| #   | Pattern                                                                              | Category      | Why Here                                                    |
| --- | ------------------------------------------------------------------------------------ | ------------- | ----------------------------------------------------------- |
| 23  | [Concurrent Request Management](patterns/performance/concurrent-request-management/) | performance   | Critical for Batch. Required for RAG + Agents               |
| 24  | [Prompt Rollout Testing](patterns/testing/prompt-rollout-testing/)                   | testing       | Depends on #4 (Eval Harness), #10 (Prompt Version Registry) |
| 25  | [State Checkpointing](patterns/orchestration/state-checkpointing/)                   | orchestration | Critical for Batch. Required for Agents                     |
| 26  | [Request Batching](patterns/performance/request-batching/)                           | performance   | Critical for Batch. Pairs with #23                          |
| 27  | [Streaming Backpressure](patterns/performance/streaming-backpressure/)               | performance   | Critical for Streaming                                      |

---

### Sprint 8: "The Long Game"

_Week 16. Drift, stale data, and multi-agent coordination. The 6-month problems._

| #   | Pattern                                                            | Category      | Why Here                                                           |
| --- | ------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------ |
| 28  | [Drift Detection](patterns/observability/drift-detection/)         | observability | Depends on #8 (Structured Tracing). "Behavior changed 3 weeks ago" |
| 29  | [Embedding Refresh](patterns/data-pipeline/embedding-refresh/)     | data-pipeline | Required for RAG + Batch. Stale embeddings                         |
| 30  | [Index Maintenance](patterns/data-pipeline/index-maintenance/)     | data-pipeline | Pairs with #29. RAG maintenance                                    |
| 31  | [Multi-Agent Routing](patterns/orchestration/multi-agent-routing/) | orchestration | Depends on #17 (Agent Loop Guards)                                 |

---

### Sprint 9: "Completeness" — Category Capstones

_Week 17. Closing out every category with its capstone pattern._

| #   | Pattern                                                  | Category      | Why Here                                                         |
| --- | -------------------------------------------------------- | ------------- | ---------------------------------------------------------------- |
| 32  | [Cost Dashboard](patterns/cost-control/cost-dashboard/)  | cost-control  | Depends on #3 (Token Budget Middleware). Cost category capstone  |
| 33  | [Snapshot Testing](patterns/testing/snapshot-testing/)   | testing       | Depends on #4 (Eval Harness). Testing capstone                   |
| 34  | [Human-in-the-Loop](patterns/safety/human-in-the-loop/)  | safety        | Safety capstone                                                  |
| 35  | [Prompt Diffing](patterns/observability/prompt-diffing/) | observability | Depends on #10 (Prompt Version Registry). Observability capstone |

**Milestone**: Pattern 35 = completion social post.

---

## Technical Dependency Map

Hard dependencies only. A pattern must not be built before its prerequisites.

```
shared/test-fixtures ──→ all patterns (built with #1 Graceful Degradation)
shared/cost-tracker  ──→ Token Budget (#3) → Cost Dashboard (#32), Model Routing (#13)
shared/trace-logger  ──→ Structured Tracing (#8) → Output Quality Monitoring (#16),
                                                     Drift Detection (#28),
                                                     Online Eval Monitoring (#21)
shared/latency-tracker → Latency Budget (#14)
shared/prompt-registry → Prompt Version Registry (#10) → Prompt Diffing (#35),
                                                          Prompt Rollout Testing (#24)

Eval Harness (#4) ──────→ Regression Testing (#11)
                          Adversarial Inputs (#18)
                          Snapshot Testing (#33)
                          Online Eval Monitoring (#21)
                          Prompt Rollout Testing (#24)

Retry with Budget (#5) ─→ Circuit Breaker (#6)

Circuit Breaker (#6) ───┐
Graceful Degradation (#1)┘→ Multi-Provider Failover (#9)

Structured Output Validation (#2) → Tool Call Reliability (#20)

Agent Loop Guards (#17) → Multi-Agent Routing (#31)

Soft dependencies (conceptual "builds on" — not blockers, but natural back-link opportunities):

Semantic Caching (#12)          ~→ Token Budget (#3) — cost framing
Model Routing (#13)             ~→ Token Budget (#3) — cost comparison
Latency Budget (#14)            ~→ Token Budget (#3) — cost-latency tradeoff
Prompt Injection Defense (#15)  ~→ Structured Output Validation (#2) — safety lineage
Output Quality Monitoring (#16) ~→ Eval Harness (#4) — "quality" definition
Online Eval Monitoring (#21)    ~→ Output Quality Monitoring (#16) — quality metrics
Context Management (#22)        ~→ Chunking Strategies (#19) — RAG pipeline
Concurrent Request Mgmt (#23)   ~→ Latency Budget (#14) — performance chain
Request Batching (#26)          ~→ Concurrent Request Mgmt (#23) — concurrency first
State Checkpointing (#25)       ~→ Agent Loop Guards (#17) — agent recovery
Drift Detection (#28)           ~→ Prompt Version Registry (#10) — version comparison
Index Maintenance (#30)         ~→ Embedding Refresh (#29) — RAG lifecycle
Human-in-the-Loop (#34)         ~→ All safety patterns (#2, #7, #15) — capstone
Prompt Diffing (#35)            ~→ Output Quality Monitoring (#16) — quality context
```

### Dependency Verification

Every hard dependency is satisfied by sprint ordering:

| Pattern                         | Depends On                                       | Dep Sprint | Own Sprint | OK?                         |
| ------------------------------- | ------------------------------------------------ | ---------- | ---------- | --------------------------- |
| Circuit Breaker (#6)            | Retry with Budget (#5)                           | S2         | S2         | Yes (ordered within sprint) |
| Multi-Provider Failover (#9)    | Graceful Degradation (#1), Circuit Breaker (#6)  | S1, S2     | S3         | Yes                         |
| Regression Testing (#11)        | Eval Harness (#4)                                | S1         | S4         | Yes                         |
| Model Routing (#13)             | Token Budget Middleware (#3)                     | S1         | S4         | Yes                         |
| Output Quality Monitoring (#16) | Structured Tracing (#8)                          | S3         | S5         | Yes                         |
| Adversarial Inputs (#18)        | Eval Harness (#4)                                | S1         | S5         | Yes                         |
| Tool Call Reliability (#20)     | Structured Output Validation (#2)                | S1         | S6         | Yes                         |
| Online Eval Monitoring (#21)    | Eval Harness (#4), Structured Tracing (#8)       | S1, S3     | S6         | Yes                         |
| Prompt Rollout Testing (#24)    | Eval Harness (#4), Prompt Version Registry (#10) | S1, S3     | S7         | Yes                         |
| Drift Detection (#28)           | Structured Tracing (#8)                          | S3         | S8         | Yes                         |
| Multi-Agent Routing (#31)       | Agent Loop Guards (#17)                          | S5         | S8         | Yes                         |
| Cost Dashboard (#32)            | Token Budget Middleware (#3)                     | S1         | S9         | Yes                         |
| Snapshot Testing (#33)          | Eval Harness (#4)                                | S1         | S9         | Yes                         |
| Prompt Diffing (#35)            | Prompt Version Registry (#10)                    | S3         | S9         | Yes                         |

---

## Category Diversity Check

No sprint has 3+ patterns from the same category (except Sprint 7, by design).

| Sprint | resilience | cost-control | observability | testing | safety | data-pipeline | orchestration | performance |
| ------ | ---------- | ------------ | ------------- | ------- | ------ | ------------- | ------------- | ----------- |
| S1     | 1          | 1            | —             | 1       | 1      | —             | —             | —           |
| S2     | 2          | —            | —             | —       | 1      | —             | —             | —           |
| S3     | 1          | —            | 2             | —       | —      | —             | —             | —           |
| S4     | —          | 2            | —             | 1       | —      | —             | —             | 1           |
| S5     | —          | —            | 1             | 1       | 1      | —             | 1             | —           |
| S6     | —          | —            | 1             | —       | —      | 2             | 1             | —           |
| S7     | —          | —            | —             | 1       | —      | —             | 1             | **3**       |
| S8     | —          | —            | 1             | —       | —      | 2             | 1             | —           |
| S9     | —          | 1            | 1             | 1       | 1      | —             | —             | —           |

**Totals**: resilience 4, cost-control 4, observability 6, testing 5, safety 4, data-pipeline 4, orchestration 4, performance 4 = **35 patterns**

---

## Blog & Social Content Cadence

### Publishing Schedule

**2 posts per week**: Tuesday and Thursday, matching the 2 patterns/week build cadence.

Each pattern generates:

- 1 blog post (via pattern README + companion content)
- 1 LinkedIn post (via `/social`)
- 1 X thread (via `/social`)

### Week-by-Week Schedule

| Week | Tuesday                      | Thursday                        | Notes                                |
| ---- | ---------------------------- | ------------------------------- | ------------------------------------ |
| 1    | #1 Graceful Degradation      | #2 Structured Output Validation | Launch week                          |
| 2    | #3 Token Budget Middleware   | #4 Eval Harness                 | Sprint 1 complete                    |
| 3    | #5 Retry with Budget         | #6 Circuit Breaker              |                                      |
| 4    | #7 PII Detection             | —                               | Sprint 2 complete                    |
| 5    | **Sprint 1–2 Roundup**       | —                               | Buffer week: catch-up + roundup post |
| 6    | #8 Structured Tracing        | #9 Multi-Provider Failover      |                                      |
| 7    | #10 Prompt Version Registry  | —                               | Sprint 3 complete                    |
| 8    | **Sprint 3 Roundup**         | —                               | Buffer week: catch-up + roundup post |
| 9    | #11 Regression Testing       | #12 Semantic Caching            |                                      |
| 10   | #13 Model Routing            | #14 Latency Budget              | Sprint 4 complete                    |
| 11   | #15 Prompt Injection Defense | #16 Output Quality Monitoring   |                                      |
| 12   | #17 Agent Loop Guards        | #18 Adversarial Inputs          | Sprint 5 complete                    |
| 13   | #19 Chunking Strategies      | #20 Tool Call Reliability       |                                      |
| 14   | #21 Online Eval Monitoring   | #22 Context Management          | Sprint 6 complete                    |
| 15   | #23 Concurrent Request Mgmt  | #24 Prompt Rollout Testing      |                                      |
| 16   | #25 State Checkpointing      | #26 Request Batching            |                                      |
| 17   | #27 Streaming Backpressure   | —                               | Sprint 7 complete                    |
| 18   | #28 Drift Detection          | #29 Embedding Refresh           |                                      |
| 19   | #30 Index Maintenance        | #31 Multi-Agent Routing         | Sprint 8 complete                    |
| 20   | #32 Cost Dashboard           | #33 Snapshot Testing            |                                      |
| 21   | #34 Human-in-the-Loop        | #35 Prompt Diffing              | Sprint 9 complete                    |

### Milestone Social Posts

Larger-format posts celebrating progress milestones:

| Milestone    | After Pattern            | Theme                                               |
| ------------ | ------------------------ | --------------------------------------------------- |
| Launch       | #4 (Eval Harness)        | "4 patterns, 4 categories — here's what we learned" |
| Quarter mark | #14 (Latency Budget)     | "14 patterns in: the cost and resilience story"     |
| Two-thirds   | #22 (Context Management) | "22 down: from failing gracefully to managing data" |
| Complete     | #35 (Prompt Diffing)     | "35 production patterns — the full map"             |

---

## Quick Reference: Full Sequence

| #   | Pattern                       | Category      | Sprint | Hard Dependencies |
| --- | ----------------------------- | ------------- | ------ | ----------------- |
| 1   | Graceful Degradation          | resilience    | S1     | —                 |
| 2   | Structured Output Validation  | safety        | S1     | —                 |
| 3   | Token Budget Middleware       | cost-control  | S1     | —                 |
| 4   | Eval Harness                  | testing       | S1     | —                 |
| 5   | Retry with Budget             | resilience    | S2     | —                 |
| 6   | Circuit Breaker               | resilience    | S2     | #5                |
| 7   | PII Detection                 | safety        | S2     | —                 |
| 8   | Structured Tracing            | observability | S3     | —                 |
| 9   | Multi-Provider Failover       | resilience    | S3     | #1, #6            |
| 10  | Prompt Version Registry       | observability | S3     | —                 |
| 11  | Regression Testing            | testing       | S4     | #4                |
| 12  | Semantic Caching              | cost-control  | S4     | —                 |
| 13  | Model Routing                 | cost-control  | S4     | #3 (soft)         |
| 14  | Latency Budget                | performance   | S4     | —                 |
| 15  | Prompt Injection Defense      | safety        | S5     | —                 |
| 16  | Output Quality Monitoring     | observability | S5     | #8                |
| 17  | Agent Loop Guards             | orchestration | S5     | —                 |
| 18  | Adversarial Inputs            | testing       | S5     | #4                |
| 19  | Chunking Strategies           | data-pipeline | S6     | —                 |
| 20  | Tool Call Reliability         | orchestration | S6     | #2                |
| 21  | Online Eval Monitoring        | observability | S6     | #4, #8            |
| 22  | Context Management            | data-pipeline | S6     | —                 |
| 23  | Concurrent Request Management | performance   | S7     | —                 |
| 24  | Prompt Rollout Testing        | testing       | S7     | #4, #10           |
| 25  | State Checkpointing           | orchestration | S7     | —                 |
| 26  | Request Batching              | performance   | S7     | —                 |
| 27  | Streaming Backpressure        | performance   | S7     | —                 |
| 28  | Drift Detection               | observability | S8     | #8                |
| 29  | Embedding Refresh             | data-pipeline | S8     | —                 |
| 30  | Index Maintenance             | data-pipeline | S8     | —                 |
| 31  | Multi-Agent Routing           | orchestration | S8     | #17               |
| 32  | Cost Dashboard                | cost-control  | S9     | #3                |
| 33  | Snapshot Testing              | testing       | S9     | #4                |
| 34  | Human-in-the-Loop             | safety        | S9     | —                 |
| 35  | Prompt Diffing                | observability | S9     | #10               |

# Composition Recipes

Short, problem-oriented guides showing 2–3 patterns wired together to solve a specific production problem.

Each recipe covers:
- **When to use it** — the symptoms that point toward this combination
- **How the patterns compose** — architecture diagram and interaction table
- **Wiring code** — TypeScript and Python snippets showing the composition
- **What to watch** — combined metrics, failure modes, and runbook steps
- **Tensions** — where the patterns create tradeoffs with each other

---

## Recipes

| Recipe | Patterns | Problem It Solves |
|---|---|---|
| [Resilience Stack](./resilience-stack.md) | Retry with Budget + Circuit Breaker + Graceful Degradation | Provider outages, retry storms, cascading failures |
| [Cost Control Stack](./cost-control-stack.md) | Token Budget + Model Routing + Semantic Caching | Runaway spend, over-provisioned models, redundant API calls |
| [Safe Prompt Iteration](./safe-prompt-iteration.md) | Eval Harness + Prompt Rollout Testing + Online Eval Monitoring | Prompt regressions, silent quality drift, risky deployments |
| [RAG Quality Stack](./rag-quality-stack.md) | Chunking Strategies + Output Quality Monitoring + Regression Testing | Poor retrieval, answer drift, generation regressions |
| [Agent Safety Stack](./agent-safety-stack.md) | Agent Loop Guards + Tool Call Reliability + Prompt Injection Defense | Runaway loops, malformed tool calls, injected instructions |

---

## How Recipes Relate to Patterns

Recipes don't introduce new concepts — they show how existing patterns wire together. Each recipe references the source pattern READMEs for the full architecture, implementation, and operational detail. Think of recipes as the synthesis layer: the patterns cover the "what" and "why"; the recipes cover the "how do I use several of them together."

If a recipe uses a pattern you haven't adopted yet, start with that pattern's README before attempting the composition.

# Incident Case Studies

Deep-dive analyses of real production incidents, examined through the lens of which patterns would have helped — and when they needed to be in place to matter.

The way I find these useful: not as warnings or cautionary tales, but as calibration for pattern priority. Which patterns are "nice to have" vs. "I wouldn't ship without this"? Incidents answer that question with specificity that abstract reasoning can't.

## Case Studies

| Incident | Date | Duration | Patterns |
|----------|------|----------|----------|
| [OpenAI December 2024 Global Outage](openai-december-2024-outage.md) | Dec 11, 2024 | 4h 22m | Circuit Breaker, Multi-Provider Failover, Structured Tracing, Graceful Degradation |
| [GPT-4o Sycophancy Rollback](gpt4o-sycophancy-rollback.md) | Apr 25–29, 2025 | 4 days | Prompt Rollout Testing, Online Eval Monitoring, Output Quality Monitoring, Prompt Version Registry |
| [The Retry Storm Pattern](retry-storm-incident.md) | Composite | Hours–days | Retry with Budget, Circuit Breaker, Concurrent Request Management, Graceful Degradation |

---

## Reading Order

**If you're building a new system:** Start with the [Retry Storm](retry-storm-incident.md) case study — it's the most common failure mode and the patterns it points to should be in place before your first production deployment.

**If you're using a single provider:** The [December 2024 OpenAI outage](openai-december-2024-outage.md) makes a specific argument for multi-provider failover. Teams that had it experienced a non-event. Teams that didn't were down for four hours through no fault of their own.

**If you're shipping model or prompt updates:** The [GPT-4o sycophancy incident](gpt4o-sycophancy-rollback.md) is a precise description of what happens when behavioral monitoring lags behind deployment velocity. The offline evals looked good. The A/B tests looked good. Social media was the alerting system.

---

## Pattern Priority by Incident Type

| Incident Type | Highest-priority pattern |
|---------------|--------------------------|
| Provider outage / API downtime | [Multi-Provider Failover](../../patterns/resilience/multi-provider-failover/) |
| Rate limit + retry cascade | [Retry with Budget](../../patterns/resilience/retry-with-budget/) |
| Cascading service failure | [Circuit Breaker](../../patterns/resilience/circuit-breaker/) |
| Silent behavioral degradation | [Online Eval Monitoring](../../patterns/observability/online-eval-monitoring/) |
| Model/prompt update regression | [Prompt Rollout Testing](../../patterns/testing/prompt-rollout-testing/) |

---

## Related Guides

- [Adoption Roadmap](../adoption-roadmap.md) — sequencing pattern adoption by system maturity
- [Resilience Stack Recipe](../recipes/resilience-stack.md) — Retry + Circuit Breaker + Graceful Degradation wired together
- [Agent Safety Stack Recipe](../recipes/agent-safety-stack.md) — Agent Loop Guards + Tool Call Reliability + Prompt Injection Defense

# Case Study: The Retry Storm Pattern

> A multi-agent pipeline hits a rate limit at 2 AM. Five agents fail in a cascade. Recovery takes four hours. The retry logic was working correctly — it just didn't know when to stop.

**Pattern type:** Composite — based on documented production incidents with multi-agent LLM pipelines  
**Primary patterns implicated:** [Retry with Budget](../../patterns/resilience/retry-with-budget/), [Circuit Breaker](../../patterns/resilience/circuit-breaker/), [Concurrent Request Management](../../patterns/performance/concurrent-request-management/), [Graceful Degradation](../../patterns/resilience/graceful-degradation/)

---

## What Happened

Retry storms aren't exotic failures. They're what happens when you add retry logic to a system and don't add backoff or circuit breaking. The retry logic is the feature that breaks you.

The canonical version of this incident: a team builds a multi-agent pipeline. Several agents run concurrently. The pipeline hits an API rate limit. Each agent's retry logic fires — immediately, because there's no backoff. Every agent hammers the already-rate-limited endpoint simultaneously. The API sees a surge, rate limits harder. More retries fire. The API is now sustaining 5–10x the original request volume from a pipeline that's technically "handling errors."

In one documented instance, a Gemini API rate limit triggered at 2 AM. Five concurrent agents failed in a cascade. Four hours passed before recovery. The agents weren't doing anything wrong individually — each agent's retry was a reasonable response to a transient error. The problem was that five agents doing the reasonable thing simultaneously created a thundering herd that extended the outage from minutes to hours.

A second documented pattern: a multi-agent financial assistant where two agents entered a clarification loop — Agent A asked Agent B a question, Agent B asked Agent A back. No circuit breaker caught it. No spend alert triggered. API costs escalated from $127/week to $47,000/week over 11 days before anyone noticed.

These aren't edge cases. They're what happens when retry logic exists but backoff, circuit breaking, and request coordination don't.

---

## The Amplification Math

This is worth being concrete about, because the numbers are surprising.

A naive retry with 3 attempts at each layer of a 5-layer call chain produces at most 3^5 = **243 requests** to the backend for each original user request. At 100 concurrent users during an outage, that's 24,300 requests instead of 100.

Even with a simpler system — say, 5 concurrent agents with 3 retries each — a rate limit that should have resolved in 30 seconds can extend to hours if every agent retries into the same endpoint simultaneously. The rate limit causes retries. The retries increase load. Increased load extends the rate limit. The system is stuck.

Exponential backoff with jitter breaks this loop. AWS research on distributed systems found exponential backoff with jitter reduces retry storms by 60–80% in distributed systems. The core mechanism: instead of retrying after a fixed interval, each agent waits 2^attempt * random_jitter seconds. The randomness ensures agents don't all retry simultaneously. The exponential growth ensures agents back off as the problem persists.

---

## Timeline (Composite)

| Event | Without patterns | With patterns |
|-------|-----------------|---------------|
| Rate limit hit | All agents retry immediately | Each agent waits with exponential backoff + jitter |
| Retry surge | Request volume spikes 5–10x; API rate limits harder | Requests spread over time; API pressure decreases |
| Circuit state | No circuit breaker; agents continue hammering | Circuit opens after N failures; agents fast-fail |
| Recovery | 4 hours (agents continue blocking on failed requests) | Minutes (circuit closes when API recovers; agents resume) |
| Cost impact | Sustained elevated cost throughout outage window | Cost drops when circuit opens; no wasted tokens on doomed requests |

---

## Pattern Analysis

### What would have changed the outcome

**[Retry with Budget](../../patterns/resilience/retry-with-budget/)** — the foundational fix. A retry budget has two components that matter here:

1. **Exponential backoff with jitter** — prevents the thundering herd. Each agent waits a different amount of time before retrying, spreading load over time instead of concentrating it.
2. **Attempt limit** — stops agents from retrying indefinitely. Three attempts with exponential backoff is a fundamentally different failure mode than infinite retries with no backoff.

Without this, retry logic that looks correct in isolation becomes a self-amplifying failure at scale.

**[Circuit Breaker](../../patterns/resilience/circuit-breaker/)** — coordinates across agents in a way individual retry logic can't. Once the failure rate crosses a threshold, the circuit opens and all subsequent calls fast-fail immediately instead of queueing for retry. This serves two purposes:

1. **Reduces load on the failing endpoint** — fast-failing requests puts zero additional pressure on the rate-limited API.
2. **Gives the API time to recover** — rate limits typically resolve faster when the client backs off completely than when it continues sending requests.

The circuit closes automatically when the endpoint starts responding again, so recovery is self-healing. Without a circuit breaker, the recovery window is however long it takes for all the queued retries to exhaust their budgets — which can be hours.

**[Concurrent Request Management](../../patterns/performance/concurrent-request-management/)** — adds a coordination layer that's invisible in single-agent scenarios but essential in multi-agent ones. A concurrency limiter caps the total simultaneous requests to the LLM API regardless of how many agents are running. When the rate limit hits, only the request at the limit gets the error; the rest are still queued locally. This prevents the thundering herd at the source rather than managing it after the fact.

Without concurrency limits, "5 agents × 3 retries" is the worst-case request volume. With concurrency limits, the worst-case is the concurrency cap, regardless of agent count.

**[Graceful Degradation](../../patterns/resilience/graceful-degradation/)** — for the user-facing layer, this is what keeps a bad API moment from being a user-visible outage. If the agent pipeline hits a rate limit, a graceful degradation fallback can return a cached response, a simplified response, or a "check back in a moment" message — something other than a 500. The downstream user shouldn't know or care that there was a rate limit; they should see the system working within its limits.

### What wouldn't have helped

**More API quota** — higher rate limits delay the problem; they don't eliminate it. A system with no backoff will eventually exhaust any quota. Scale the system and you scale the retry storm.

**Faster retries** — reducing retry intervals makes the thundering herd worse, not better. The instinct to "be more aggressive about recovery" is counterproductive during rate limiting.

**Single-agent architecture** — the thundering herd is the most visible failure mode in multi-agent systems, but the underlying problem (no backoff) exists in single-agent systems too, just at lower amplitude. A single agent with 100 retries per minute is still a problem during an extended outage.

---

## The Gaps

**Gap 1: Retry logic without backoff is the default.** Most HTTP client libraries, including those used for LLM API calls, default to immediate retries or fixed-interval retries. The backoff has to be added explicitly. It's easy to miss because it doesn't affect behavior during normal operation — the retry path only activates during failures, and failures don't show up in development.

**Gap 2: Multi-agent retry behavior isn't visible from any single agent's logs.** Each agent's retry looks correct in isolation. "Error → wait → retry → success" is exactly what you want. The thundering herd only appears in aggregate — in API error rate logs, in cost monitoring, in request volume graphs. If teams are monitoring individual agents rather than aggregate API usage, the storm is invisible until recovery happens.

**Gap 3: Circuit breaking requires shared state.** A circuit breaker that's local to each agent provides no coordination benefit. If Agent A's circuit is open and Agent B's circuit is closed, Agent B still hammers the failing endpoint. An effective circuit breaker in a multi-agent system either runs as a shared service (a dedicated request proxy like [LiteLLM](https://github.com/BerriAI/litellm)) or uses a shared state store that all agents read from.

**Gap 4: Cost anomaly detection is separate from availability monitoring.** The multi-agent loop that escalated from $127/week to $47,000/week over 11 days wasn't caught by availability monitoring — the agents were running fine from a health perspective. They were just running in a loop. Cost anomaly detection with alerts on week-over-week spend increase would have caught this at day 1 or 2 instead of day 11.

---

## Lessons for Pattern Adoption

The thing that makes retry storms tricky is that the failure mode is invisible during development and low-traffic periods. Everything works. Tests pass. The storm only materializes when multiple agents are under load simultaneously, and the first indication is often a four-hour outage or an unexpected invoice.

The way I think about the adoption sequence: retry budgets first, always, before anything else with retry logic in it. It's a cheap addition that eliminates the most common amplification pattern. Circuit breakers second, as soon as you have more than one thing that retries into the same endpoint. Concurrency limits third, as soon as you have more than one agent.

| Priority | Pattern | Why |
|----------|---------|-----|
| Immediate | [Retry with Budget](../../patterns/resilience/retry-with-budget/) | Exponential backoff + jitter eliminates the thundering herd at the source |
| Immediate | [Circuit Breaker](../../patterns/resilience/circuit-breaker/) | Coordinates across agents; fast-fails instead of queueing into a failing endpoint |
| Near-term | [Concurrent Request Management](../../patterns/performance/concurrent-request-management/) | Caps aggregate API load regardless of agent count |
| Near-term | [Graceful Degradation](../../patterns/resilience/graceful-degradation/) | Keeps user-facing layer functional when the agent layer is rate-limited |

The meta-lesson: retry logic and circuit breaking need to be designed together. Retry logic in isolation — without backoff, without a circuit breaker, without concurrency limits — can turn a 2-minute rate limit into a 4-hour outage. The patterns aren't complicated, but they have to be present before the incident, not added afterward.

---

## Sources

- [Resilient AI Agents: Retry, Circuit Breakers, and Fallback Strategies — Antigravity Lab](https://antigravitylab.net/en/articles/agents/antigravity-ai-agent-resilience-error-handling-production) — 2 AM Gemini rate limit incident and recovery patterns
- [LLM API Resilience in Production: Rate Limits, Failover, and Hidden Costs — TianPan.co](https://tianpan.co/blog/2026-03-11-llm-api-resilience-production) — $127→$47K/week agent loop incident
- [Retries, Fallbacks, and Circuit Breakers in LLM Apps — Portkey](https://portkey.ai/blog/retries-fallbacks-and-circuit-breakers-in-llm-apps/) — retry storm amplification patterns
- [AI Agent Retry Patterns: Exponential Backoff Guide — Fastio](https://fast.io/resources/ai-agent-retry-patterns/) — thundering herd mechanics and backoff design
- [Preventing Cascading Failures in AI Agents — DEV Community](https://dev.to/willvelida/preventing-cascading-failures-in-ai-agents-p3c) — cascade failure patterns in multi-agent systems

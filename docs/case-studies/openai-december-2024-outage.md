# Case Study: OpenAI December 2024 Global Outage

> A telemetry service deployment overwhelmed the Kubernetes control plane, cascading into a four-hour global outage across every OpenAI product — and the staging tests passed cleanly.

**Date:** December 11, 2024  
**Duration:** ~4 hours 22 minutes (3:16 PM – 7:38 PM PST)  
**Blast radius:** All OpenAI services globally — ChatGPT, API, Sora, Playground, Labs  
**Primary patterns implicated:** [Circuit Breaker](../../patterns/resilience/circuit-breaker/), [Multi-Provider Failover](../../patterns/resilience/multi-provider-failover/), [Structured Tracing](../../patterns/observability/structured-tracing/), [Graceful Degradation](../../patterns/resilience/graceful-degradation/)

---

## What Happened

On December 10, OpenAI deployed a new telemetry service to a staging cluster. Tests passed. The service was designed to collect Kubernetes metrics — observability infra, not user-facing code. Low risk by any reasonable assessment.

The next day, the code was merged to main and deployed to all production clusters in a phased rollout. The problem was that the telemetry service's configuration inadvertently caused every node in every cluster to execute expensive Kubernetes API operations — operations that scaled exponentially with cluster size. Staging clusters were small enough that this never materialized. Production clusters were not.

At 3:13 PM PST, alerts fired. Three minutes later, customer impact began. By 3:40 PM, all services were at peak degradation. The Kubernetes control planes crashed. When they went down, DNS resolution failed, because the data planes depended on control plane DNS. As DNS caches expired over the next 20 minutes, the failures became visible and widespread — the cache expiration itself spread the blast radius in slow motion.

Recovery took until 7:38 PM PST. The first cluster came back at 4:36 PM, but full service restoration took another three hours.

---

## Timeline

| Time (PST, Dec 11) | Event |
|--------------------|-------|
| 2:23 PM | Code merged, deployment pipeline triggered |
| 2:51–3:20 PM | Telemetry service rolled out to all production clusters |
| 3:12 PM | Telemetry service begins hammering Kubernetes API servers |
| 3:13 PM | Alerts triggered |
| 3:16 PM | Customer impact confirmed; root cause identified |
| 3:27 PM | Traffic migration from affected clusters initiated |
| 3:40 PM | Peak customer impact across all services |
| 4:36 PM | First cluster recovered |
| 7:38 PM | All services fully restored |

Total customer-facing outage: **4 hours 22 minutes**.

---

## The Cascade

The failure had three distinct phases, each making the next one worse:

**Phase 1 — Control plane overload.** The telemetry service generated Kubernetes API requests that scaled with cluster size. Large production clusters had no equivalent in staging. The API servers buckled.

**Phase 2 — DNS failure.** OpenAI's data planes resolved service addresses via the control plane's DNS. When the control plane degraded, DNS stopped working. Service-to-service communication inside each cluster broke — not because of any application code, but because the network fabric depended on the thing that was down.

**Phase 3 — Cache expiry amplification.** DNS caches temporarily masked the DNS failure. As those caches expired over ~20 minutes, the failure propagated visibly and sequentially across services. This made the outage look like it was spreading when really it was just becoming visible. It also made diagnostics harder — the failure wasn't a clean "everything went down at once," it was a rolling wave.

---

## Pattern Analysis

### What would have changed the outcome

**[Graceful Degradation](../../patterns/resilience/graceful-degradation/)** — with a fallback path in place, services hit by DNS failure could have returned degraded responses instead of errors. The blast radius for end users narrows from "complete unavailability" to "limited functionality." This is particularly relevant for ChatGPT: even basic response capability with degraded latency is better than a 500.

**[Circuit Breaker](../../patterns/resilience/circuit-breaker/)** — the cascading DNS failure is exactly what a circuit breaker is designed to interrupt. When service-to-service calls start failing, a circuit breaker opens, stops sending traffic into the failing dependency, and fast-fails until the dependency recovers. Without one, every inbound request attempted a full call graph through broken DNS.

**[Multi-Provider Failover](../../patterns/resilience/multi-provider-failover/)** — this is the pattern that matters most for API users, not for OpenAI internally. Teams with failover to Anthropic or Google Vertex saw ~zero user-facing impact during this window. Teams without it were down for four hours regardless of their own infrastructure quality. The outage wasn't in their code. It was in a vendor they couldn't control.

**[Structured Tracing](../../patterns/observability/structured-tracing/)** — the incident report notes that monitoring was focused on service health, not control plane health. Structured traces that instrument the full call graph — including DNS resolution timing — would have made Phase 2 visible as a DNS anomaly rather than a mysterious service degradation pattern. The difference between "DNS is slow" and "service is slow" is the difference between a 5-minute diagnosis and a 20-minute one.

### What couldn't have helped

**Retry logic** — retrying into broken DNS just adds noise. Retries are for transient failures. This was a structural failure where the retry target was unreachable. Retry with budget would have correctly bounded the damage, but wouldn't have unblocked anything.

**Better rate limiting** — OpenAI's rate limiting was on the user side of the API. The failure was internal infrastructure. No amount of user-side rate limiting changes a Kubernetes control plane collapse.

---

## The Gaps

Three gaps made this worse than it needed to be.

**Gap 1: Staging clusters didn't represent production.** The telemetry issue was cluster-size-dependent. Staging was small. Production was large. This is a testing gap, but it's also a deployment gap — a phased rollout that starts at 1% of traffic and monitors control plane metrics before proceeding would have caught the issue at 1% impact rather than 100%.

**Gap 2: Control plane health wasn't in the monitoring baseline.** OpenAI's own postmortem notes this explicitly: monitoring focused on service workloads, not cluster health. The control plane was the critical dependency, but it wasn't treated as a thing that could fail. Adding control plane metrics to the alerting baseline — nodes executing API operations, API server latency, etcd write latency — would have caught this before customer impact.

**Gap 3: Data plane DNS depended on control plane availability.** This is the architectural gap that turned a control plane problem into a total outage. When DNS resolution goes through the control plane, control plane instability becomes service instability. Decoupling data plane DNS — caching aggressively, adding fallback resolution paths — limits the blast radius of control plane degradation.

---

## Lessons for Pattern Adoption

**The top lesson here isn't really about OpenAI.** Every team that had multi-provider failover in place experienced this as a non-event. Teams without it experienced a four-hour outage they couldn't fix because the problem was someone else's infrastructure.

The way I think about this: if my system's availability depends entirely on a single API provider, I'm not actually in control of my own SLA. The outage doesn't have to be in my code to affect my users. I'd want failover in place before going to production with anything user-facing.

The second lesson is about staging environments. Testing in smaller environments than production is a well-known risk, but it's easy to rationalize — "it's just telemetry, the logic is the same." The telemetry service wasn't wrong; it just behaved differently at scale. Any infrastructure change touching cluster-level behavior deserves production-equivalent staging, or a very conservative phased rollout with explicit health checks before each step.

The third lesson is about monitoring. Observability that covers your services but not your infrastructure dependencies creates a blind spot exactly where you need it most. I'd want traces that span the full call graph — including DNS resolution — so that infrastructure failures appear as data anomalies, not mysterious service degradations.

| Priority | Pattern | Why |
|----------|---------|-----|
| Immediate | [Multi-Provider Failover](../../patterns/resilience/multi-provider-failover/) | Vendor outages are outside your control; failover is the only hedge |
| Immediate | [Graceful Degradation](../../patterns/resilience/graceful-degradation/) | Limits user-facing blast radius when dependencies fail |
| Near-term | [Circuit Breaker](../../patterns/resilience/circuit-breaker/) | Stops cascade propagation through failed service dependencies |
| Near-term | [Structured Tracing](../../patterns/observability/structured-tracing/) | Makes infrastructure failures visible as data, not mystery |

---

## Sources

- [OpenAI December 2024 outage postmortem (blog.vonng.com)](https://blog.vonng.com/en/cloud/openai-failure/) — detailed timeline and root cause analysis
- [OpenAI Status — December 11, 2024 incident](https://status.openai.com) — official incident record
- [OpenAI Global Outage During ChatGPT, API, and Sora Launch (techinformed.com)](https://techinformed.com/openai-global-outage-chatgpt-api-sora/) — blast radius and timeline
- [OpenAI's Outage: Kubernetes Complexity and Fragility (chkk.io)](https://www.chkk.io/blog/openais-outage-the-complexity-and-fragility-of-modern-ai-infrastructure-on-kubernetes) — Kubernetes control plane analysis

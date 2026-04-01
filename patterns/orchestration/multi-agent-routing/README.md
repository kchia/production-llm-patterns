# Multi-Agent Routing

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

A multi-agent system without routing is a system where every task goes to every agent — or worse, to whichever agent happens to be listed first. Either way, the wrong agent processes the request and the result is wrong.

The failure mode is subtle because the system doesn't visibly break. A misrouted request doesn't produce an error; it produces a confidently wrong answer. A customer support query routed to a code-review agent gets a response — it's just not the right response. In a pipeline with downstream dependencies, that misclassification compounds. Research from [Berkeley and CMU analyzing 1,600+ production traces](https://arxiv.org/abs/2503.13657) across seven multi-agent frameworks found that inter-agent misalignment — where an agent ignores, misinterprets, or misacts on instructions from the router — is one of the three major failure clusters in deployed systems.

The compounding is the real cost. [Anthropic's engineering team documented](https://www.anthropic.com/engineering/multi-agent-research-system) that early versions of their multi-agent research system would spawn far more subagents than a query warranted, exhausting token budgets on parallel redundant work. The problem wasn't the agents — it was routing: without a reliable classifier, the orchestrator had no basis for allocating scope. With multi-agent systems consuming [substantially more tokens than single-turn chat](https://www.anthropic.com/engineering/multi-agent-research-system), a misrouted request doesn't just give a wrong answer — it does so expensively.

## What I Would Not Do

The naive approach is to describe each agent's capabilities in a system prompt and ask the LLM router to "pick the best one." It works in demos. It breaks in production for two reasons.

First, capability descriptions overlap. An agent described as "handles customer questions about orders" and one described as "handles billing and payment questions" will both seem relevant to "I need to cancel my order and get a refund." Without explicit decision boundaries, the router makes ambiguous calls inconsistently. The same input may route differently on back-to-back requests because the LLM samples from its probability distribution rather than executing deterministic logic.

Second, there's no fallback path. If no agent clearly matches — a query that spans multiple domains or uses vocabulary none of the descriptions anticipated — the router either guesses or routes to a default. Either way, you get a result, and that result logs as a successful request. The routing failure is invisible unless you're specifically monitoring misroute rate. Analysis of production agent systems has found concept drift as a consistent failure mode: routing accuracy degrades over time as user behavior evolves, but since the system keeps returning responses, the degradation doesn't trigger alerts.

## When You Need This

- The system routes requests to two or more specialized agents that each handle a distinct domain or capability
- A misrouted request has a user-visible consequence — wrong response, wrong tool called, wrong context retrieved
- Any agent in the pool handles sensitive operations (writes, deletions, API calls with side effects) that would cause problems if triggered incorrectly
- Token cost is a concern and different agents have meaningfully different token consumption profiles
- The agent pool is growing — new agents are added over time, increasing the classification surface

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

| System Type   | Priority    | Reasoning                                                                                                                                                                                                                                                                          |
| ------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agents**    | Critical    | Multi-agent systems only work if requests reach the right agent. A misrouted request in a tool-using agent doesn't just return a bad answer — it may call the wrong tools with side effects. I wouldn't ship a multi-agent system without routing logic I could actually measure.  |
| **Batch**     | Recommended | Batch jobs often use different agents for different document types, query categories, or pipeline stages. Misrouting in batch is recoverable (the job can be re-run), but routing errors that affect a significant fraction of the batch are expensive to discover after the fact. |
| **Streaming** | Optional    | Most streaming systems route at the session level, not per-turn. If a streaming system routes mid-conversation (e.g., escalating from a lightweight agent to a capable one), the pattern applies — but this is less common than in pure agent architectures.                       |
| **RAG**       | Optional    | Standard RAG is single-agent: retrieve, then generate. Multi-agent RAG — where different retrieval agents handle different corpora or modalities — benefits from this pattern, but it's not the baseline case.                                                                     |

## The Pattern

### Architecture

```
  Incoming Request
        │
        ▼
┌──────────────────────────┐
│ 1. Router                │
│   LLM classification     │
│   confidence score       │
│   capability registry    │
└───────────┬──────────────┘
            │
     ┌──────┴──────┐
     │             │
 conf ≥ θ?     conf < θ
     │             │
     ▼             ▼
┌──────────┐  ┌──────────────┐
│ 2.       │  │ 2b. Fallback │
│ Dispatch │  │  default OR  │
│ to agent │  │  escalate    │
└────┬─────┘  └──────┬───────┘
     │               │
     └───────┬────────┘
             ▼
     ┌──────────────┐
     │ 3. Agent     │
     │   Execution  │
     │  (specialized│
     └──────┬───────┘
            │
            ▼
     ┌──────────────────────┐
     │ 4. Audit Log         │
     │  agent_id, confidence│──→ Metrics
     │  latency, fallback?  │
     └──────────────────────┘
            │
            ▼
         Response
```

_Illustrative thresholds (confidence ≥ 0.75) are starting points. Actual values depend on agent overlap, cost of misroute, and downstream sensitivity._

The router sits in front of all agents and makes one classification decision per request. Four responsibilities:

1. **Classification** — given the incoming request, which registered agent should handle it? LLM call with the capability registry as context.
2. **Confidence gating** — the router emits a confidence score. Below threshold, it falls back to a default agent or escalation path rather than guessing.
3. **Dispatch** — forward the request to the chosen agent with the full original context. The routed agent receives exactly what the user sent, not a transformed version.
4. **Audit** — log routing decisions (chosen agent, confidence, latency) so misroute rate can be tracked independently of response quality.

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

### Core Abstraction

```typescript
interface AgentCapability {
  id: string;
  description: string; // What this agent handles
  examples: string[]; // Few-shot examples for the router
  priority: number; // Tiebreaker when confidence is similar
}

interface RoutingDecision {
  agentId: string;
  confidence: number; // 0–1
  reasoning: string; // For audit log
  fallback: boolean; // True if routed via fallback path
}

interface MultiAgentRouter {
  register(agent: AgentCapability): void;
  route(request: string): Promise<RoutingDecision>;
  dispatch(decision: RoutingDecision, request: string): Promise<AgentResponse>;
}
```

### Configurability

| Parameter             | Default        | Effect                                                                        | Dangerous Extreme                                                                                                                   |
| --------------------- | -------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `confidenceThreshold` | `0.75`         | Minimum confidence to route to specific agent; below this, fallback activates | Too high (>0.95): most requests fall back, defeating the purpose. Too low (<0.5): fallback never activates, misroutes go undetected |
| `fallbackAgentId`     | `null` (error) | Which agent handles low-confidence requests; if null, throws                  | Pointing to an inappropriate default creates silent misroutes in the fallback path                                                  |
| `maxRoutingTokens`    | `512`          | Token budget for the classification call                                      | Too low truncates the capability registry; too high inflates routing overhead                                                       |
| `routingModel`        | same as agents | Model used for classification; can be cheaper (e.g., Haiku)                   | Using a model too weak to distinguish capabilities increases misroute rate                                                          |
| `examples` per agent  | `3`            | Few-shot examples per capability in the router prompt                         | More examples help up to ~5; beyond that, the router prompt grows and classification latency increases                              |

_These defaults are starting points. Actual values depend on agent overlap (more similar agents need higher threshold), cost sensitivity (expensive agents warrant stricter routing), and request distribution._

### Key Design Tradeoffs

**LLM classification vs. rule-based routing**: LLM classification generalizes to novel phrasing but adds latency and cost per request (~100–200ms, ~$0.0001–$0.001 per call). Rule-based routing is deterministic and free, but breaks on paraphrase. For systems where agents handle semantically distinct domains, LLM routing is worth the overhead. For systems where agents handle structurally distinct inputs (e.g., one handles JSON, one handles prose), rule-based routing suffices.

**Synchronous vs. async dispatch**: Synchronous dispatch (route, then await agent) is simpler to reason about. Async dispatch allows the router to serve other requests while waiting, which matters at high throughput. This implementation uses synchronous dispatch with async/await; the caller handles concurrency at the request level.

**Single vs. multi-label routing**: Some requests span multiple agent domains. This implementation routes to one agent per request. Multi-label routing (send to multiple agents, merge results) is more complex and token-expensive. I'd start single-label and add multi-label only when cross-domain requests are common enough to measure.

## Failure Modes

| Failure Mode                                                                                                                                                                                                                                        | Detection Signal                                                                                                                             | Mitigation                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Misclassification cascade** — router routes to wrong agent; wrong agent produces confident but incorrect response                                                                                                                                 | Downstream quality metrics drop; user-reported errors spike in one domain while another agent is underutilized (uneven routing distribution) | Monitor routing distribution across agents. A confidence histogram spike near threshold indicates frequent close calls. Log agent IDs with all responses so misroutes can be identified retrospectively. |
| **Capability description drift** — agent capabilities evolve but routing descriptions aren't updated; stale descriptions cause misroutes                                                                                                            | Increase in low-confidence routing decisions; specific request categories consistently routed to fallback                                    | Treat capability descriptions as code: version them alongside agent changes. Review routing logs when deploying agent updates.                                                                           |
| **Ambiguous multi-intent queries** — request legitimately spans two agent domains; router picks one; the other concern is dropped                                                                                                                   | Response completeness complaints; requests that return partial answers to multi-part questions                                               | Add intent decomposition for complex requests: split into sub-intents before routing. Or route to a coordinator agent that orchestrates both.                                                            |
| **Fallback overload** — too many requests fall below confidence threshold; fallback agent handles volume it wasn't designed for                                                                                                                     | Fallback agent p99 latency increases; fallback routing rate > 10–15% of requests                                                             | Tighten capability descriptions with more examples. Consider whether the fallback agent is appropriate as a general-purpose handler or whether new specialized agents are needed.                        |
| **Router latency spikes** — classification call adds meaningful overhead during provider latency events                                                                                                                                             | End-to-end p99 latency increases by more than the nominal routing overhead                                                                   | Use a faster/cheaper model for routing. Cache routing decisions for identical or near-identical requests. Set a routing timeout with a fast fallback.                                                    |
| **Silent misroute accumulation** _(silent degradation)_ — routing accuracy slowly degrades as user vocabulary evolves, new agents are added, or model updates shift classification behavior; no alert fires because individual responses look valid | Only visible in retrospective routing audits: gradual shift in routing distribution, increase in confidence variance over weeks              | Review routing distribution and confidence histograms monthly. Compare against baseline established at deployment. This is the failure that's active in your system right now and won't page you.        |

## Observability & Operations

### Key Metrics

| Metric                            | Collection Method | Healthy Range                                                                    |
| --------------------------------- | ----------------- | -------------------------------------------------------------------------------- |
| `routing.decision.agent_id`       | Log per request   | Distribution should match expected domain distribution                           |
| `routing.decision.confidence`     | Histogram         | Median > threshold; avoid bimodal distribution (most near 1.0 or near threshold) |
| `routing.fallback_rate`           | Counter / rate    | < 10% of requests; spikes indicate capability description gaps                   |
| `routing.latency_ms`              | Timer (p50, p99)  | p50 < 200ms; p99 < 500ms for synchronous routing                                 |
| `routing.error_rate`              | Counter / rate    | Near 0; errors are unhandled failures, not misroutes                             |
| `agent.request_count` by agent_id | Counter           | Balanced relative to expected domain volume; watch for unexpected concentration  |

### Alerting

| Alert                       | Threshold                                   | Priority | First Check                                                                                  |
| --------------------------- | ------------------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| Fallback rate spike         | > 15% in 5-min window                       | Warning  | Were new agents added or capability descriptions changed recently?                           |
| Fallback rate sustained     | > 10% over 1 hour                           | Critical | Review routing confidence histogram; check for vocabulary shift in recent requests           |
| Routing latency p99         | > 1s                                        | Warning  | Classification model under load? Provider latency event?                                     |
| Agent routing concentration | One agent > 70% of requests (if unexpected) | Warning  | Capability description overlap? Router prompt change? Compare against baseline distribution. |
| Routing error rate          | > 1%                                        | Critical | Check capability registry validity; confirm registered agents are reachable                  |

_These thresholds are starting points. A system where one agent legitimately handles 80% of traffic (e.g., a general + specialist split) needs different concentration alerts._

### Runbook

**Fallback rate spike:**

1. Pull last 30 minutes of routing logs; identify which input categories are falling back
2. Check if any agent capability descriptions were updated in the last deploy
3. Review confidence histogram — is confidence near threshold or near 0?
4. If near threshold: add more examples to the relevant agent description; redeploy
5. If near 0: the request type is genuinely unmatched — consider whether a new agent is needed

**Routing latency spike:**

1. Check classification model endpoint latency independently
2. Verify `maxRoutingTokens` hasn't increased (larger prompts = slower classification)
3. If provider latency event: switch routing model to a faster/lighter option
4. Consider temporarily routing to fallback (bypass LLM classification) if latency is severe

**Unexpected agent concentration:**

1. Compare today's routing distribution against the 7-day baseline
2. Pull sample of requests routed to the concentrated agent — do they belong there?
3. If yes: user behavior has shifted; update other agents' capability descriptions
4. If no: capability overlap is causing the router to favor one agent; review and differentiate descriptions

## Tuning & Evolution

### Tuning Levers

| Lever                      | Effect                                           | When to Adjust                                                                                                                           |
| -------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `confidenceThreshold`      | Controls fallback activation rate                | Lower if fallback agent is strong and you prefer it to handle uncertainty; raise if misroutes are causing problems in specialized agents |
| Per-agent `examples` count | Improves routing precision for that agent        | Add examples when a specific agent consistently receives requests it shouldn't                                                           |
| `routingModel` selection   | Trades routing cost and latency against accuracy | Downgrade to a faster model when routing latency is a bottleneck; upgrade when fallback rate is high and descriptions look correct       |
| `maxRoutingTokens`         | Controls prompt truncation risk                  | Increase if the capability registry is large and routing accuracy is low; decrease to reduce classification latency                      |
| Agent `priority` field     | Tiebreaker for similar confidence scores         | Use to prefer lower-cost agents when confidence between two agents is close                                                              |

**Drift signals:**

- Gradual increase in fallback rate (> 2% increase month-over-month)
- Routing confidence variance increasing — more requests landing near threshold
- User complaints clustering in one agent's domain while another sees declining volume
- A classification model update changes routing behavior (test routing decisions after model updates)

**How often to review:** Monthly routing distribution comparison against baseline. After any deploy that touches capability descriptions or adds/removes agents. After any classification model update.

### Silent Degradation

**Month 3:** User vocabulary has evolved since launch. Requests phrased in ways the capability examples anticipated are now phrased differently — abbreviations, domain slang, multi-part questions. A specific category is consistently misrouted, but confidence hasn't changed on average. The fallback rate is flat. This is invisible without spot-checking random routing decisions against expected agents.

**Month 6:** A new agent was added in month 2. Its capability description overlaps with an existing agent. The overlap is subtle enough that individual routing decisions look reasonable, but the original agent's request volume has declined by 20%. Downstream quality for that domain drifts down. No alert fires. The only signal is a routing distribution audit showing an unexpected shift.

**Proactive checks:** Monthly routing audit comparing distribution against baseline. Quarterly: re-evaluate examples in capability descriptions using recent production requests (the examples written at launch may no longer be representative).

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers.

| Scale        | Additional Cost | ROI vs. No Pattern                                                             |
| ------------ | --------------- | ------------------------------------------------------------------------------ |
| 1K req/day   | +$1.82/day      | Break-even in 2–3 days; immediate correctness benefit                          |
| 10K req/day  | +$18.20/day     | Offset by misroute prevention; use GPT-4o-mini for routing to cut overhead 94% |
| 100K req/day | +$182.00/day    | Strong case for cheaper routing model — saves $34/day net vs. no routing       |

## Testing

See test files in `src/ts/__tests__/` and `src/py/tests/`.

- **Unit tests:** Core routing logic (confidence threshold evaluation, fallback activation, capability registry operations, agent dispatch with mock responses)
- **Failure mode tests:** One test per failure mode — misclassification cascade (wrong agent selected, assert audit log captures it), capability drift (stale descriptions route incorrectly), ambiguous multi-intent (low-confidence request activates fallback), fallback overload (fallback agent invoked when confidence below threshold), router latency timeout (classification call exceeds timeout, fallback activates), silent degradation detection (routing distribution audit catches shift)
- **Integration tests:** End-to-end routing with mock provider; verify correct agent receives request; verify audit log entries; concurrent routing; empty registry (should error cleanly, not route randomly)
- **How to run:** `cd src/ts && npm test` (TypeScript) or `cd src/py && pytest` (Python)

## When This Advice Stops Applying

- **Single-agent systems**: If there's one agent, there's nothing to route. The pattern is overhead.
- **Highly structured routing**: If routing is determined by schema type, URL pattern, or other deterministic signal rather than semantic content, an LLM-based router is the wrong tool — a simple switch statement is faster, cheaper, and more reliable.
- **Very small agent pools (2 agents, clearly distinct domains)**: A lightweight classifier or rule-based approach may outperform an LLM router in both cost and reliability.
- **Ultra-low latency requirements**: Sub-100ms p99 targets make a synchronous LLM classification call difficult to justify. Consider routing at session initiation rather than per-request, or use a cached/rule-based classifier.
- **Homogeneous agent pools**: If all agents do essentially the same thing with minor variations (e.g., same capability, different data sources), routing by capability isn't the right abstraction — sharding by data or load balancing is.

<!-- ## Companion Content

- Blog post: [Multi-Agent Routing — Deep Dive](https://prompt-deploy.com/multi-agent-routing) (coming soon)
- Related patterns:
  - [Agent Loop Guards](../agent-loop-guards/) — prevents runaway agents after routing; required before routing adds multi-agent scale
  - [Tool Call Reliability](../tool-call-reliability/) — downstream of routing; once routed, tool calls need their own reliability layer
  - [Structured Output Validation](../../safety/structured-output-validation/) — validates agent responses after routing; routing gets the request to the right place, validation ensures the response is correct
  - [State Checkpointing](../state-checkpointing/) — for multi-agent pipelines where routing feeds a longer workflow; checkpointing preserves progress across agent handoffs -->

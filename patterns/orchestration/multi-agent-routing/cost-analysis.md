# Cost Analysis: Multi-Agent Routing

## What This Pattern Does to Your Bill

Multi-Agent Routing adds **one extra LLM call per request** — the classification call that decides which agent handles the request. The agent call itself is unchanged. So the cost question is: how much does that classification call cost, and does it pay for itself by preventing misrouted agent calls?

The answer almost always yes. A misrouted call wastes the entire agent call. Routing cost is typically 5–15% of agent call cost (since classification prompts are shorter than agent prompts). Preventing even a 5% misroute rate makes routing net cost-negative.

---

## Assumptions

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Average input tokens per agent request | 800 | Typical prompt with context (~600) + user message (~200) |
| Average output tokens per agent request | 400 | Medium-length agent response |
| Routing input tokens | 600 | Capability registry (~400) + user request (~200) |
| Routing output tokens | 80 | JSON response: `{agentId, confidence, reasoning}` |
| Misroute rate without routing | 8% | Conservative estimate; real systems see 5–15% with naive "describe and pick" |
| Cost of misrouted call | 1× agent call | Misrouted call = full agent call wasted, no user value |
| Routing model | Same as agent | Conservative baseline. See "cheaper routing" section for optimized scenario. |

---

## Formulas

```
# Per-request costs
agent_call_cost = (800 input_tok × input_price) + (400 output_tok × output_price)
routing_call_cost = (600 input_tok × input_price) + (80 output_tok × output_price)

# Without routing: base cost + misroute waste
daily_cost_no_routing = (req/day × agent_call_cost) + (req/day × misroute_rate × agent_call_cost)
                      = req/day × agent_call_cost × (1 + misroute_rate)

# With routing: agent call + routing call (misroute rate ≈ 0 with good routing)
daily_cost_with_routing = req/day × (agent_call_cost + routing_call_cost)

# Net change
net_daily_cost = daily_cost_with_routing - daily_cost_no_routing
savings_from_prevented_misroutes = req/day × misroute_rate × agent_call_cost
overhead_of_routing = req/day × routing_call_cost
net = overhead_of_routing - savings_from_prevented_misroutes
```

---

## Cost Projections by Model

### GPT-4o (Input: $2.50/1M, Output: $10.00/1M)

```
agent_call_cost    = (800 × $2.50/1M) + (400 × $10.00/1M) = $0.002 + $0.004 = $0.006/request
routing_call_cost  = (600 × $2.50/1M) + (80 × $10.00/1M)  = $0.0015 + $0.0008 = $0.00230/request
misroute_savings   = 8% × $0.006 = $0.00048/request saved
routing_overhead   = $0.00230/request added
net change per request = +$0.00230 - $0.00048 = +$0.00182 added
```

| Scale | Without Routing/day | With Routing/day | Additional Cost | Savings from Prevented Misroutes | Net |
|-------|---------------------|-----------------|-----------------|----------------------------------|-----|
| 1K req/day | $6.48 | $8.30 | +$2.30 | -$0.48 | **+$1.82** |
| 10K req/day | $64.80 | $83.00 | +$23.00 | -$4.80 | **+$18.20** |
| 100K req/day | $648.00 | $830.00 | +$230.00 | -$48.00 | **+$182.00** |

**With same model for routing, routing adds ~28% to daily API costs.**

---

### Optimized: GPT-4o-mini for Routing + GPT-4o for Agents

The most cost-effective deployment: cheap model for classification, capable model for actual work.

```
routing_call_cost (mini) = (600 × $0.15/1M) + (80 × $0.60/1M) = $0.000090 + $0.000048 = $0.000138/request
agent_call_cost (gpt-4o) = $0.006/request (unchanged)
routing_overhead = $0.000138/request
misroute_savings = $0.00048/request
net change = +$0.000138 - $0.00048 = -$0.000342/request SAVED
```

| Scale | Without Routing/day | With Routing/day | Routing Overhead | Misroute Savings | Net |
|-------|---------------------|-----------------|-----------------|-----------------|-----|
| 1K req/day | $6.48 | $6.14 | +$0.14 | -$0.48 | **-$0.34 saved** |
| 10K req/day | $64.80 | $61.40 | +$1.38 | -$4.80 | **-$3.42 saved** |
| 100K req/day | $648.00 | $614.00 | +$13.80 | -$48.00 | **-$34.20 saved** |

**Using GPT-4o-mini for routing turns the cost of routing negative — you save money by routing.**

---

### Claude Sonnet (Input: $3.00/1M, Output: $15.00/1M)

```
agent_call_cost    = (800 × $3.00/1M) + (400 × $15.00/1M) = $0.0024 + $0.0060 = $0.0084/request
routing_call_cost  = (600 × $3.00/1M) + (80 × $15.00/1M)  = $0.0018 + $0.0012 = $0.0030/request
misroute_savings   = 8% × $0.0084 = $0.000672/request
routing_overhead   = $0.0030/request
net per request    = +$0.0023
```

| Scale | Additional Cost | Savings from Prevented Misroutes | Net |
|-------|-----------------|----------------------------------|-----|
| 1K req/day | +$3.00 | -$0.67 | **+$2.33** |
| 10K req/day | +$30.00 | -$6.72 | **+$23.28** |
| 100K req/day | +$300.00 | -$67.20 | **+$232.80** |

---

### GPT-4o-mini for All Calls (Input: $0.15/1M, Output: $0.60/1M)

```
agent_call_cost    = (800 × $0.15/1M) + (400 × $0.60/1M) = $0.00012 + $0.00024 = $0.00036/request
routing_call_cost  = (600 × $0.15/1M) + (80 × $0.60/1M)  = $0.000090 + $0.000048 = $0.000138/request
misroute_savings   = 8% × $0.00036 = $0.0000288/request
net per request    = +$0.000138 - $0.0000288 = +$0.000109
```

| Scale | Additional Cost | Net |
|-------|-----------------|-----|
| 1K req/day | +$0.11 | **+$0.08** |
| 10K req/day | +$1.10 | **+$0.80** |
| 100K req/day | +$11.00 | **+$8.00** |

---

## README Summary Table (GPT-4o, same-model routing)

| Scale | Additional Cost | ROI vs. No Pattern |
|-------|-----------------|-------------------|
| 1K req/day | +$1.82/day | Break-even ~2–3 days; worth it immediately for correctness |
| 10K req/day | +$18.20/day | Offset by misroute prevention; optimize with cheaper routing model |
| 100K req/day | +$182.00/day | Strong case for GPT-4o-mini routing; saves $34/day net |

---

## How to Calculate for Your Own Usage

**Step 1: Measure your actual token counts**
```
avg_agent_input = average tokens in your agent prompt + user message
avg_agent_output = average tokens in your agent responses
avg_routing_input = len(capability registry in tokens) + avg user message
avg_routing_output ≈ 80 tokens (JSON routing response is small)
```

**Step 2: Choose your routing model**
- If routing accuracy matters more than cost: use the same model as your agents
- If you have >1K req/day and agents are GPT-4o or Claude Sonnet: use GPT-4o-mini for routing

**Step 3: Estimate your misroute rate**
- With naive "describe and pick" (no examples): ~10–15%
- With good capability descriptions + examples: ~3–5%
- With this pattern (confidence gating + fallback): ~1–3% reaching wrong agent

**Step 4: Calculate**
```python
agent_cost_per_req = (avg_agent_input * input_price_per_token) + (avg_agent_output * output_price_per_token)
routing_cost_per_req = (avg_routing_input * routing_input_price) + (avg_routing_output * routing_output_price)
misroute_savings_per_req = misroute_rate * agent_cost_per_req
net_per_req = routing_cost_per_req - misroute_savings_per_req
daily_net = req_per_day * net_per_req
```

**Step 5: Break-even check**
```
break_even_misroute_rate = routing_cost_per_req / agent_cost_per_req
# If your misroute rate > break_even, routing saves money even on same model
# GPT-4o example: 0.0023 / 0.006 = 38% misroute rate needed for same-model break-even
# GPT-4o-mini routing example: 0.000138 / 0.006 = 2.3% misroute rate needed — very achievable
```

---

## Key Insights

1. **Same-model routing adds ~28% cost** (GPT-4o). This is the "expensive but correct" baseline.
2. **Cheaper routing model turns the math positive.** GPT-4o-mini as router + GPT-4o as agents saves ~$34/day at 100K requests.
3. **The break-even misroute rate for same-model routing is 38%** — you'd need 38% of requests going to the wrong agent for same-model routing to pay for itself on cost alone. That's unrealistically high; you should route for *correctness*, not cost.
4. **For mini-as-router, break-even is 2.3%** — achievable with any competent classification setup. Routing pays for itself and prevents misroutes.
5. **The real ROI isn't cost savings — it's correctness.** At 10K req/day with an 8% misroute rate, that's 800 wrong responses per day. The cost calculation above ignores the user-facing impact entirely.

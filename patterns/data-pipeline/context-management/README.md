# Context Management

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

LLM context windows are finite and expensive, and the failure mode when you ignore that is surprisingly subtle. In a multi-turn agent or chat system, context grows message by message. At some point it hits the limit. The LLM API throws a `context_length_exceeded` error — or worse, silently truncates from the beginning of the conversation, losing the system prompt that defines the assistant's behavior. The agent keeps running, but it's forgotten who it is.

The dollar dimension matters too. On Claude Sonnet at `$3.00/1M` input tokens, a 50K-token context window filled with stale conversation history costs `$0.15` per call — before the model generates a single output token. A RAG pipeline that appends retrieved documents on every turn compounds this: 5 retrieved chunks × 1,000 tokens each × 10K requests/day = `$150/day` in input tokens for context that's largely redundant across calls.

The way I think about it: an LLM call is a snapshot. You choose what to put in the frame. Without an active management strategy, you're not choosing — you're accumulating.

## What I Would Not Do

The most common mistake is building context trimming as an afterthought — a single conditional that checks total length and slices off the earliest messages when it's too long.

```typescript
// This is the approach I'd want to avoid
if (tokens(messages) > limit) {
  messages = messages.slice(-50); // keep last 50
}
```

The problem isn't the slice — it's the lack of discrimination. System messages are the most important item in the context: they define the assistant's role, constraints, and output format. Slicing from the beginning deletes system prompts first, exactly when they're most needed (in long conversations where the model has had time to drift). The assistant becomes amnesiac and inconsistent, and there's no signal telling you it happened.

The second thing I'd avoid: building a summarization approach that requires a real LLM call in the hot path of your request. Summarizing conversation history is a useful strategy, but calling an LLM to produce the summary before you can call the LLM for the user's actual request doubles your latency on every turn that hits the limit. The standard I'd set: summarization belongs in a background process, not inline.

## When You Need This

- Your agents or chat systems run multi-turn conversations that accumulate context over time
- RAG pipelines that append retrieved documents on every turn
- Token budget alerts firing regularly against your context window limit
- Hard `context_length_exceeded` errors from the API (the visible failure)
- Model behavior becoming inconsistent in longer conversations (the silent failure)
- Paying for large context windows when only a fraction of the content is relevant

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

| System Type | Designation | Reasoning |
| --- | --- | --- |
| Agents | Required | Agents accumulate tool results, intermediate reasoning, and multi-step dialogue. Without context management, long-running agent loops will hit the limit — and the failure tends to be hard to reproduce because it only manifests in long sessions. |
| Streaming | Required | Streaming delivery doesn't change context growth. A 20-turn streaming conversation has the same context pressure as a non-streaming one. |
| RAG | Recommended | RAG pipelines have a double pressure: conversation history grows _and_ retrieved chunks are appended per turn. Managing both is important, but RAG systems with fixed retrieval budgets and short sessions can often handle this with a simpler approach. |
| Batch | Optional | Batch jobs typically process independent inputs with no accumulated state. If your batch pipeline does include multi-turn context, apply this; otherwise it doesn't apply. |

## The Pattern

### Architecture

```
Messages via add()
       │
       ▼
┌── 1. History Store ──────────────┐
│  Messages: role, content, id,    │
│  priority, cached token count    │
└──────────────┬───────────────────┘
               │ build()
               ▼
┌── 2. Token Budgeter ─────────────┐
│  available = maxTokens           │
│            − reserveForOutput    │
│  sum tokens across all messages  │
└──────────────┬───────────────────┘
               │
       ┌───────┴────────────┐
       │ total ≤ available? │
       └───┬────────────┬───┘
         Yes           No
           │            ▼
           │   ┌── 3. Trim Strategy ──────┐
           │   │  sliding-window          │
           │   │  priority                │
           │   │  summarize               │
           │   │  (system msgs preserved) │
           │   └────────────┬─────────────┘
           │                │
           └────────┬───────┘
                    ▼
             ContextWindow
       { messages[], totalTokens,
         droppedMessages, budgetUsed,
         strategy }
```

### Core Abstraction

```typescript
interface Message {
  role: "system" | "user" | "assistant";
  content: string;
  id: string; // unique ID for tracking dropped messages
  priority: number; // 0–1, default 0.5; higher = more likely to survive trimming
  tokens?: number; // cached token count
}

interface ContextConfig {
  maxTokens: number; // context window size for this model
  reserveForOutput: number; // tokens to reserve for the model's response
  strategy: "sliding-window" | "priority" | "summarize";
  keepRecent: number; // for summarize strategy: how many recent messages to keep verbatim
}

interface ContextWindow {
  messages: Message[]; // messages to send to the LLM
  totalTokens: number; // token count of included messages
  droppedMessages: number; // how many were excluded
  budgetUsed: number; // fraction of available budget consumed (0–1)
  strategy: string;
}
```

### Configurability

| Parameter          | Default          | Safe Range                                | What It Controls                                                                                                     |
| ------------------ | ---------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `maxTokens`        | 128,000          | Model-specific                            | Total context window size. Match to the model being called — GPT-4o: 128K, Claude Sonnet: 200K, GPT-4o-mini: 128K.   |
| `reserveForOutput` | 4,000            | 1,000–16,000                              | Tokens reserved for the model's response. Too small: responses get truncated. Too large: wastes message budget.      |
| `strategy`         | `sliding-window` | `sliding-window`, `priority`, `summarize` | Trim algorithm. `sliding-window` is the safe default; `priority` when messages have meaningful priority scores set.  |
| `keepRecent`       | 10               | 4–20                                      | `summarize` strategy only: how many recent messages stay verbatim. Lower = more compression; too low = context loss. |

### Key Design Tradeoffs

**System messages are always preserved.** Every strategy in this pattern treats `role: 'system'` as inviolable. The system prompt defines the assistant's identity and constraints. If trimming needs to drop it to fit, something is wrong with the budget configuration — not with the system prompt. The right fix is to reduce `reserveForOutput` or switch to a larger context model, not to drop behavioral instructions.

**Sliding window as the safe default.** Recency bias is usually correct for conversations: the last few exchanges contain the most relevant context for the next response. The failure mode — losing important context established earlier — is real, but it's predictable and catchable in testing. Priority-based trimming requires callers to actually set priority scores, and most don't, so it degrades to arbitrary selection when all messages have the same default priority.

**Priority scores are a caller responsibility.** The `ContextManager` doesn't assign priority; callers do. This is intentional — the manager doesn't have domain knowledge about which messages matter. A tool call result confirming a file was deleted matters more than ambient acknowledgment text. Callers that don't set priority get recency as the tiebreaker.

**Summarization belongs outside the hot path.** The summarize strategy in this implementation uses a mock compressor that replaces old messages with a token-counted placeholder. In production, the compression step should happen asynchronously, triggered when context crosses a high-water mark, not inline during request handling.

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

| Failure Mode                                                                                                                                                                                                                    | Detection Signal                                                                                           | Mitigation                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **System prompt eviction** — naive trimming removes system messages when trimming from the front, causing the model to lose behavioral instructions                                                                             | Model output stops following formatting or constraint rules mid-conversation; no API error fires           | Always preserve `role: 'system'` messages before applying any trim strategy — treat them as pinned                                                   |
| **Silent truncation by the provider** — calling the API with a context that exceeds the model's limit; some providers truncate silently rather than erroring                                                                    | Model responses become incoherent mid-conversation; no error appears in logs                               | Count tokens before every API call; assert `totalTokens <= maxTokens - reserveForOutput` before calling                                              |
| **Priority score stagnation** _(the 6-month failure)_ — all messages added with default priority 0.5; priority strategy produces arbitrary trim results; callers don't notice because behavior degrades gradually, not suddenly | Priority histogram is flat at 0.5 across all message types; retrieval quality declines with session length | Monitor priority score distribution; alert if >80% of messages carry default priority — it signals the priority signal is unused                     |
| **Reserve underestimate** — `reserveForOutput` set too low; model hits output limit mid-response, producing truncated answers                                                                                                   | Response completions drop suddenly at a predictable token boundary; users report cut-off answers           | Monitor output token distribution; set `reserveForOutput` to p99 observed output length + 20% margin                                                 |
| **Context budget leak** — background context (tool schemas, retrieved documents) not counted against the budget; actual context larger than `ContextWindow.totalTokens` suggests                                                | API calls fail with `context_length_exceeded` despite `budgetUsed` showing < 1.0                           | Account for all tokens sent to the API — not just message history; include tool definitions, system metadata, retrieved chunks in budget calculation |
| **Summarize loop** — summarize strategy triggered on every call; old summaries accumulate because they're not merged; context fills with nested summaries                                                                       | Context contains multiple `[Summary: ...]` blocks; summary text itself starts consuming significant budget | Deduplicate summaries by sourceId; merge consecutive summaries rather than stacking; cap summary budget at a fixed token count                       |

## Observability & Operations

### Key Metrics

| Metric                     | What It Measures                                                 | Collection Method                         |
| -------------------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| `context.budget_used`      | Fraction of available token budget consumed per call (histogram) | Emit from `build()` result                |
| `context.dropped_messages` | Messages excluded per call (histogram)                           | Emit from `ContextWindow.droppedMessages` |
| `context.history_depth`    | Number of messages in history when `build()` is called           | Count `history.length` before trimming    |
| `context.trim_triggered`   | Whether trimming occurred on this call (boolean)                 | `1` if `droppedMessages > 0`, else `0`    |
| `context.strategy_used`    | Which strategy was applied                                       | Tag on each metric emission               |
| `context.tokens_saved`     | Tokens excluded vs. raw history size                             | `rawTokens - totalTokens`                 |

### Alerting

| Alert                            | Warning Threshold                      | Critical Threshold | Notes                                                                          |
| -------------------------------- | -------------------------------------- | ------------------ | ------------------------------------------------------------------------------ |
| Budget used consistently high    | p95 > 0.85                             | p95 > 0.95         | Context pressure growing; consider reducing `keepRecent` or switching strategy |
| Dropped messages per call rising | p95 > 5                                | p95 > 15           | Trimming aggressively; history growing faster than budget allows               |
| Priority score distribution flat | > 80% messages at default 0.5          | —                  | Priority signal unused; priority strategy won't add value                      |
| Context budget leak              | Any `context_length_exceeded` from API | 3+ in 5 min        | Tool schemas or retrieved docs not counted in budget                           |

### Runbook

**Alert: Budget used p95 > 0.95**

1. Check `context.history_depth` — are sessions getting long, or is token count per message increasing?
2. If sessions are long: consider reducing `keepRecent` for summarize strategy, or lowering the sliding window depth
3. If per-message token count is high: check if retrieved documents are being added as messages rather than as a separate context budget
4. If model was recently changed: verify `maxTokens` is updated to match new model's actual context window
5. Consider increasing `maxTokens` if migrating to a larger context model is on the roadmap

**Alert: `context_length_exceeded` from provider**

1. Check `context.budget_used` around the failing request — is the budget calculation wrong?
2. Inspect what else is sent in the request body: tool schemas, system metadata, retrieved chunks
3. Count all tokens going to the API, not just the managed messages — add non-managed content to the budget calculation
4. Temporarily increase `reserveForOutput` as a safeguard while diagnosing

## Tuning & Evolution

### Tuning Levers

| Parameter                | When to Increase                               | When to Decrease                                        | Watch Out For                                                                      |
| ------------------------ | ---------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `reserveForOutput`       | Output completions are truncated mid-response  | Budget consistently underutilized                       | Reducing too far causes truncated responses                                        |
| `keepRecent` (summarize) | Model needs more recent context to answer well | Context fills with recent messages, old summary is tiny | < 4 risks losing too much context for coherent responses                           |
| Priority scores          | —                                              | —                                                       | All messages at default 0.5 makes priority strategy equivalent to random selection |

### Drift Signals

| Frequency                           | What to Check                                                                                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Weekly**                          | `context.budget_used` p50 and p95 trend. Rising p50 means sessions are growing longer or messages are getting larger.                                                               |
| **On each model upgrade**           | Re-verify `maxTokens` matches the new model's context window. A model upgrade with the wrong `maxTokens` will miscalculate budget, leading to either wasted capacity or API errors. |
| **When adding new context sources** | Any time you add tool schemas, retrieved documents, or metadata to the request body, re-measure total tokens at the API boundary and adjust budget accounting.                      |
| **When error rate rises**           | Check for `context_length_exceeded` errors — they indicate the managed budget is smaller than the actual request.                                                                   |

### Silent Degradation

At Month 3, session lengths have grown as users engage more deeply with the agent. The sliding window is keeping the last 20 messages, but the average message is longer than it was at launch (users now paste code snippets, tool results are verbose). Budget is at p95 = 0.91 — still within alert thresholds, but the model is now working with a narrower window of conversation history than intended. No alert fires.

At Month 6, the team adds tool schema definitions to every request — 2,000 tokens of JSON that describe 12 tools. These tokens aren't counted in the `ContextManager` budget. The `context.budget_used` metric still shows 0.85, but the actual tokens sent to the API are 0.85 × 128K + 2K = ~110K. On long sessions, this tips over the limit, producing intermittent `context_length_exceeded` errors that appear random because they only happen at the tail of long conversations.

**Proactive checks:** Monthly review of `context.history_depth` distribution; alert on any `context_length_exceeded` API error; audit total request token count (not just managed messages) quarterly.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers.

| Scale        | Without Pattern | With Pattern | Savings             |
| ------------ | --------------- | ------------ | ------------------- |
| 1K req/day   | $15.00/day      | $6.75/day    | −$8.25/day (~55%)   |
| 10K req/day  | $150.00/day     | $67.50/day   | −$82.50/day (~55%)  |
| 100K req/day | $1,500.00/day   | $675.00/day  | −$825.00/day (~55%) |

_Assumes Claude Sonnet pricing, 10-turn average sessions, 50K avg tokens without management, 22.5K with sliding window. See cost-analysis.md for full assumptions._

## Testing

How to verify this pattern works correctly. See test files in `src/ts/` and `src/py/`.

### Unit Tests

- Sliding-window strategy keeps system messages when trimming
- Priority strategy includes highest-priority messages within budget
- Summarize strategy keeps `keepRecent` verbatim messages, compresses the rest
- `reserveForOutput` correctly reduces available budget
- `add()` caches token counts per message
- `remove()` deletes a message by id
- `clear()` resets history to empty
- `budgetUsed` is correct fraction of available capacity

### Failure Mode Tests

- System prompt eviction: verify sliding-window never drops `role: 'system'` messages even at extreme budget pressure
- Reserve underestimate: verify `totalTokens + reserveForOutput <= maxTokens`
- Empty history: `build()` on empty history returns empty `ContextWindow` without error
- All-system messages: if only system messages exist and they exceed budget, returns them all with a warning

### Integration Tests

- End-to-end: add 30 messages across roles, build with tight budget, verify system messages preserved and token count is within budget
- Strategy comparison: same history built with `sliding-window` vs `priority`; verify different messages survive; neither exceeds budget
- Idempotent build: calling `build()` twice on the same history returns identical results

### Running Tests

```bash
# TypeScript
cd patterns/data-pipeline/context-management/src/ts
npm install
npm test

# Python
cd patterns/data-pipeline/context-management/src/py
pip install -e ".[dev]"
pytest
```

## When This Advice Stops Applying

- Single-turn systems where each request is fully independent — if there's no conversation state, there's no context to manage
- Systems where every conversation is short enough that the context window is never approached in practice (e.g., single-exchange Q&A with short answers)
- Applications using provider-managed conversation state (e.g., [OpenAI Assistants API](https://platform.openai.com/docs/guides/conversation-state) with thread management) — the provider is doing this work; adding your own layer creates conflicts
- Batch pipelines where each item is processed independently with no accumulated context

## Companion Content

- Blog post: [Context Management](link) — deeper reasoning on why this pattern matters
- Related patterns:
  - [Chunking Strategies](../chunking-strategies/) (#19, S6) — determines what units of retrieved context are available for context assembly
  - [Token Budget Middleware](../../cost-control/token-budget-middleware/) (#3, S1) — context size directly drives token cost; these patterns share the same cost lever
  - [Latency Budget](../../performance/latency-budget/) (#14, S4) — larger contexts increase time-to-first-token; context management is a latency lever
  - [Streaming Backpressure](../../performance/streaming-backpressure/) (#27, S7) — context size affects generation length and backpressure dynamics

# Anti-Pattern Catalog

A searchable reference of the naive approaches teams try before reaching for each production pattern. Every entry comes directly from the "What I Would Not Do" section of the corresponding pattern.

---

## Table of Contents

- [Resilience](#resilience)
  - [Generic error fallback (Graceful Degradation)](#generic-error-fallback)
  - [Unbounded fixed-delay retries (Retry with Budget)](#unbounded-fixed-delay-retries)
  - [Per-request retries as provider health detection (Circuit Breaker)](#per-request-retries-as-provider-health-detection)
  - [Stateless try/catch failover (Multi-Provider Failover)](#stateless-trycatch-failover)
- [Safety](#safety)
  - [Unvalidated structured output (Structured Output Validation)](#unvalidated-structured-output)
  - [Regex-only PII detection (PII Detection)](#regex-only-pii-detection)
  - [Single-layer injection filtering (Prompt Injection Defense)](#single-layer-injection-filtering)
  - [Static action escalation lists (Human-in-the-Loop)](#static-action-escalation-lists)
- [Cost Control](#cost-control)
  - [max_tokens as a cost budget (Token Budget Middleware)](#max_tokens-as-a-cost-budget)
  - [Exact-match or over-permissive caching (Semantic Caching)](#exact-match-or-over-permissive-caching)
  - [Hardcoded model per endpoint (Model Routing)](#hardcoded-model-per-endpoint)
  - [Provider dashboard and log-based cost tracking (Cost Dashboard)](#provider-dashboard-and-log-based-cost-tracking)
- [Observability](#observability)
  - [console.log everywhere (Structured Tracing)](#consolelog-everywhere)
  - [Prompts as code constants (Prompt Version Registry)](#prompts-as-code-constants)
  - [Spot-checking and APM metrics for quality (Output Quality Monitoring)](#spot-checking-and-apm-metrics-for-quality)
  - [Synchronous inline eval on every request (Online Eval Monitoring)](#synchronous-inline-eval-on-every-request)
  - [Manual output sampling for drift (Drift Detection)](#manual-output-sampling-for-drift)
  - [Ad-hoc notes and git diffs for prompt changes (Prompt Diffing)](#ad-hoc-notes-and-git-diffs-for-prompt-changes)
- [Testing](#testing)
  - [Manual playground review (Eval Harness)](#manual-playground-review)
  - [Eyeballing outputs and keyword assertions (Regression Testing)](#eyeballing-outputs-and-keyword-assertions)
  - [Hand-written adversarial test cases (Adversarial Inputs)](#hand-written-adversarial-test-cases)
  - [Offline benchmark evaluation then full deploy (Prompt Rollout Testing)](#offline-benchmark-evaluation-then-full-deploy)
  - [Exact-match assertions and mean score thresholds (Snapshot Testing)](#exact-match-assertions-and-mean-score-thresholds)
- [Orchestration](#orchestration)
  - [Trusting the LLM to self-terminate (Agent Loop Guards)](#trusting-the-llm-to-self-terminate)
  - [Catch-and-retry without error context (Tool Call Reliability)](#catch-and-retry-without-error-context)
  - [Ad-hoc step saves without recovery logic (State Checkpointing)](#ad-hoc-step-saves-without-recovery-logic)
  - [Vague capability descriptions in the router prompt (Multi-Agent Routing)](#vague-capability-descriptions-in-the-router-prompt)
- [Data Pipeline](#data-pipeline)
  - [Fixed-size character splitting (Chunking Strategies)](#fixed-size-character-splitting)
  - [Naive FIFO context trimming (Context Management)](#naive-fifo-context-trimming)
  - [Write-once embeddings with no refresh path (Embedding Refresh)](#write-once-embeddings-with-no-refresh-path)
  - [Trusting default vector DB maintenance (Index Maintenance)](#trusting-default-vector-db-maintenance)
- [Performance](#performance)
  - [Per-step static timeouts (Latency Budget)](#per-step-static-timeouts)
  - [Uncapped parallelism without jitter (Concurrent Request Management)](#uncapped-parallelism-without-jitter)
  - [Promise.all / asyncio.gather as batching (Request Batching)](#promiseall--asynciogather-as-batching)
  - [Unbuffered token streaming with no flow control (Streaming Backpressure)](#unbuffered-token-streaming-with-no-flow-control)

---

## Resilience

### Generic error fallback

**What teams try:** Wrapping every LLM call in a try/catch and returning a generic "Sorry, something went wrong. Please try again." message on failure.

**Why it fails:** At 10K req/day, every request still hits the failing provider. The result is 10K timeout waits, 10K error logs, and if any retry logic exists, a storm that amplifies a 2-second outage into 30 seconds of cascading failures. The "try again" advice is a lie during a sustained outage — the user retries, hits the same failure, and loses trust. The system has no concept of quality tiers, so it can't fall back to a cached response, a simpler model, or rule-based logic.

**Pattern that solves it:** [Graceful Degradation](../patterns/resilience/graceful-degradation/)

---

### Unbounded fixed-delay retries

**What teams try:** A fixed-delay retry with a max attempt count — "retry 3 times with a 1-second delay." Often upgraded to exponential backoff.

**Why it fails:** At scale, retries are uncoordinated. During a provider incident, every client retries independently. Exponential backoff spreads delays but doesn't cap total retry volume across all clients — the aggregate load keeps climbing. The other common mistake: retrying errors that aren't transient. A 400 Bad Request means the request is broken — retrying three times wastes three API calls. Failed requests often still count toward rate limit quota, so retrying non-transient errors makes rate limiting worse.

**Pattern that solves it:** [Retry with Budget](../patterns/resilience/retry-with-budget/)

---

### Per-request retries as provider health detection

**What teams try:** Relying on per-request retry logic with exponential backoff to handle provider failures. Sometimes combined with timeout-based detection ("if the request takes longer than 5 seconds, something's wrong").

**Why it fails:** Retries handle transient errors — a single 503, a momentary rate limit. They don't know when a failure is persistent. If the provider is down, retries just keep hammering the same endpoint. At 10K req/day, each instance independently retrying 3 times turns a degraded provider into 30K+ failed requests, each waiting for a timeout before falling back. Timeout detection catches slow failures but misses fast ones — a provider returning 500s in 50ms doesn't trigger timeout logic. Neither approach has state, memory of recent failures, or a threshold to trip.

**Pattern that solves it:** [Circuit Breaker](../patterns/resilience/circuit-breaker/)

---

### Stateless try/catch failover

**What teams try:** If the primary provider fails, call the backup. Implemented as: try OpenAI, catch exception, call Anthropic.

**Why it fails:** Three specific ways. First, retry storms — when a provider starts returning 503s, every request retries against the failing provider before falling back, doubling the load on an already-struggling API. At 1K concurrent requests, that's 1K retry attempts hitting the same endpoint within seconds. Second, no health memory — each request treats the failure independently, so every request pays the latency penalty of a failed attempt before falling back; without a cooldown mechanism, you're adding 2-5 seconds of timeout latency to every request during an outage that might last hours. Third, no response consistency checking — the primary and fallback models produce semantically different outputs; downstream consumers may break on differences in tone, format, or content.

**Pattern that solves it:** [Multi-Provider Failover](../patterns/resilience/multi-provider-failover/)

---

## Safety

### Unvalidated structured output

**What teams try:** Passing LLM output directly to downstream consumers, or extracting JSON via regex and parsing it.

**Why it fails:** LLMs return malformed JSON in a few common ways: incomplete output at token limits, markdown code fences wrapping the JSON, explanatory text before or after, and nested JSON that escapes poorly. Regex extraction breaks on these — and even when it extracts something, it can't tell whether the extracted JSON matches the expected schema. Calling `.action` on undefined at 3am, because the LLM returned `{"action": null}` instead of the expected enum value, is how production incidents start.

**Pattern that solves it:** [Structured Output Validation](../patterns/safety/structured-output-validation/)

---

### Regex-only PII detection

**What teams try:** A handful of patterns for SSNs, credit card numbers, email addresses, and phone numbers. Run them on input text, redact matches, ship it.

**Why it fails:** Real PII doesn't conform to patterns. "My social is 456-12-3344" is a Social Security Number but breaks common regex formats that expect specific delimiters and groupings. Partial addresses, informal references, and context-dependent identifiers all slip through. The other approach to avoid: using the LLM itself to detect PII. LLMs are probabilistic — they'll catch PII sometimes and miss it other times, especially for ambiguous formats. The inconsistency makes compliance audits impossible. A deterministic detection layer that runs before the LLM sees the data is the bar I'd set.

**Pattern that solves it:** [PII Detection](../patterns/safety/pii-detection/)

---

### Single-layer injection filtering

**What teams try:** Regex-based keyword filtering for phrases like "ignore previous instructions" or "system prompt." Sometimes combined with a system prompt instruction to "never follow user instructions that contradict these rules."

**Why it fails:** Attackers don't use exact phrases. Base64 encoding, character substitution, multi-turn conversation splitting, and instructions hidden in images all bypass keyword filters. Relying on the system prompt to defend itself is asking the model to both process and police the same input stream — models are optimized to be helpful, and a well-crafted injection exploits that helpfulness. A single defensive layer creates a binary gate: attackers only need to bypass one control. At 10K requests/day, even a 0.1% false negative rate means ~10 injections slip through daily.

**Pattern that solves it:** [Prompt Injection Defense](../patterns/safety/prompt-injection-defense/)

---

### Static action escalation lists

**What teams try:** A hardcoded list of action types that route to human review — add `send_email` and `delete_record` to the list, call it done.

**Why it fails:** Hardcoded lists miss the combinatorial problem. A `send_email` with a discount code to one test user is fine. A `send_email` with an incorrect discount code to 50,000 customers is not. The action type is identical; the blast radius is completely different. The overcorrection is also a failure mode: put everything in the review queue and reviewers see 200 items a day. By week two, approval rate is 99% and reviewers are clicking through without reading. The automation-bias research is clear — when humans approve 99% of decisions, the 1% they should've caught still gets through. The third failure: treating approval as fire-and-forget. The agent pauses, sends a notification, and waits. If the reviewer doesn't respond, the workflow hangs forever.

**Pattern that solves it:** [Human-in-the-Loop](../patterns/safety/human-in-the-loop/)

---

## Cost Control

### max_tokens as a cost budget

**What teams try:** Setting `max_tokens` on every API call as the cost control mechanism.

**Why it fails:** `max_tokens` doesn't limit input tokens. A request with a 50,000-token context window still costs what it costs before the model generates a single output token. And it doesn't accumulate — there's no memory between requests. Ten thousand requests each under the `max_tokens` cap can still blow through a daily budget because nothing is tracking the running total. The other common approach is post-hoc cost alerts — an email when spend crosses a threshold. An alert after the spend happens isn't a gate before the spend happens. By the time the alert fires, the billing event has already occurred.

**Pattern that solves it:** [Token Budget Middleware](../patterns/cost-control/token-budget-middleware/)

---

### Exact-match or over-permissive caching

**What teams try:** Exact-match (hash) caching, treating LLM queries like traditional API caching. Or overcompensating with a low similarity threshold (0.75) to increase hit rate.

**Why it fails:** SHA-256 hashes give a 0% hit rate on semantic duplicates because "What's your refund policy?" and "How do I get a refund?" produce completely different hashes. At 0.75 similarity, "sort ascending" and "sort descending" look similar enough to match — and the system returns the wrong answer with a 200 OK. In dense embedding spaces, even 0.85 can match semantically different questions with different answers. The failure is silent: no errors, no alerts, just wrong responses served confidently. A fixed global threshold also fails because embedding space density varies across query types — code-related queries pack tightly, conversational queries are sparser.

**Pattern that solves it:** [Semantic Caching](../patterns/cost-control/semantic-caching/)

---

### Hardcoded model per endpoint

**What teams try:** Summarization always goes to GPT-4o-mini, reasoning always goes to GPT-4o. Static rules per endpoint.

**Why it fails:** Three specific ways. Task complexity isn't static — a summarization endpoint receives a 200-word email and a 15-page legal contract; hardcoded routing can't distinguish them. Model capabilities shift — when a cheaper model gets an update that improves its reasoning, hardcoded routes keep paying for the expensive one. The threshold is invisible — without routing metadata, there's no data about which requests could have gone to a cheaper model, so the case for routing infrastructure never gets made. Also worth avoiding: building a complex ML-based router from day one. Training a classifier requires substantial labeled data and ongoing maintenance. Rule-based complexity estimation gets 70–80% of the savings with 10% of the complexity.

**Pattern that solves it:** [Model Routing](../patterns/cost-control/model-routing/)

---

### Provider dashboard and log-based cost tracking

**What teams try:** Watching the provider's billing dashboard and logging token counts in application logs.

**Why it fails:** Provider dashboards are useful for detecting that something spiked, but they can't tell you why. When there's a $47K bill and four features sharing a key, you can identify the model, not the feature — the attribution gap is unbridgeable without instrumentation on your side. Logging token counts in app logs is slightly better, but correlating logs manually is work you'll skip under pressure. No alerting, no trending, no cross-request aggregation. A single shared API key per environment makes this worse — you literally cannot answer "how much does document analysis cost per user?" A prompt version shipping with an additional 800-token system prompt raises every request's cost immediately, but nobody notices until the billing cycle ends.

**Pattern that solves it:** [Cost Dashboard](../patterns/cost-control/cost-dashboard/)

---

## Observability

### console.log everywhere

**What teams try:** Logging the prompt, response, retrieval results, and a timestamp at each step. Adding correlation IDs manually when it becomes painful.

**Why it fails:** Each log line is independent. There's no correlation linking the retrieval step to the generation step to the validation step within a single request. When a user reports a bad response, reconstructing the full pipeline execution means searching for timestamps that roughly align across multiple log streams. At 1K requests/day, this starts failing. At 10K/day, it's impossible — log volume is too high, interleaving too dense. Traditional APM tools (Datadog, New Relic) don't help here — they capture HTTP spans and database queries, but don't know about prompt construction, token counts, model parameters, or retrieval relevance.

**Pattern that solves it:** [Structured Tracing](../patterns/observability/structured-tracing/)

---

### Prompts as code constants

**What teams try:** Storing prompts as string constants in application code, relying on git history for versioning.

**Why it fails:** The moment a non-engineer needs to edit a prompt — a product manager improving tone, a domain expert adjusting instructions — you're either giving them a code deploy pipeline or building a workaround. The workaround is usually a config file, a database field, or an admin UI. None of these have version history that connects to your git log. Even with an all-engineer team, A/B testing two prompt versions or canary-rolling requires a code deploy. Under incident pressure, that's 15 minutes of degraded output while everyone watches a progress bar. The mutable database approach breaks too: someone updates the row in place "just this once" during an incident and now version 7 doesn't match what version 7 was when the traces were recorded.

**Pattern that solves it:** [Prompt Version Registry](../patterns/observability/prompt-version-registry/)

---

### Spot-checking and APM metrics for quality

**What teams try:** Pulling a few production responses, eyeballing them, declaring things "look fine." Supplemented by latency, error rate, and token count metrics.

**Why it fails:** At 10K requests/day across multiple prompt templates and model versions, spot-checking covers maybe 0.1% of traffic. Quality problems affecting 5% of responses — enough to drive user complaints — slip through entirely. Traditional APM metrics tell you the system is running, not whether the answers are any good. A model hallucinating 30% more than last week still returns 200 OK with perfectly normal latency. Relying only on CI/CD evals also misses the gap — offline evaluation catches regressions against curated test sets, but production traffic is messier, more diverse, and changes over time.

**Pattern that solves it:** [Output Quality Monitoring](../patterns/observability/output-quality-monitoring/)

---

### Synchronous inline eval on every request

**What teams try:** Running evaluations synchronously, inline with the request — gate every response through an eval before returning it. Or treating online eval as a replacement for offline testing.

**Why it fails:** LLM-as-judge eval calls add 200–2,000ms to p99 latency depending on the judge model. At any meaningful scale, that overhead is unacceptable. You don't need to eval every request to detect quality drift — you need enough coverage to detect systematic issues. The other failure mode is checking only aggregate scores: a 0.8 average might mean 80% of requests score 1.0 and 20% score 0.0. Tracking score distributions, not just means, is what catches those cases. Online eval is a safety net for things that slip through offline testing — not a substitute for it.

**Pattern that solves it:** [Online Eval Monitoring](../patterns/observability/online-eval-monitoring/)

---

### Manual output sampling for drift

**What teams try:** Reviewing a sample of responses each week and trusting judgment. Or waiting for users to surface quality changes.

**Why it fails:** Manual sampling doesn't scale past a few hundred requests per day, and it's particularly bad at detecting slow changes. The pattern that breaks silently for weeks before anyone flags it is exactly the pattern drift detection exists to catch. User-reported feedback lags the actual degradation by days or weeks — by the time complaints arrive, the drift has already run through the full production corpus. At 10K requests/day, even a weekly sample is too sparse to distinguish signal from noise in behavioral distributions.

**Pattern that solves it:** [Drift Detection](../patterns/observability/drift-detection/)

---

### Ad-hoc notes and git diffs for prompt changes

**What teams try:** Storing the current prompt in a database field or config file, relying on commit messages or notes to track changes. Or using git diffs on prompt files to understand what changed.

**Why it fails:** At 2am, with three prompt versions edited in the past week and a quality drop showing in monitoring, manual correlation takes 45 minutes and still leaves uncertainty. The diffing part — grepping or copy-pasting into a text editor — doesn't scale to a team with multiple active prompts and daily edits. Git diffs work but have two gaps for LLM prompts specifically: they don't distinguish structural changes (added a section) from semantic changes (softened a constraint), and they don't connect to output quality data. Knowing that line 12 changed tells you nothing about whether that change is why entity extraction accuracy dropped 8%.

**Pattern that solves it:** [Prompt Diffing](../patterns/observability/prompt-diffing/)

---

## Testing

### Manual playground review

**What teams try:** Opening the playground, pasting five inputs, checking if results look reasonable, shipping the change.

**Why it fails:** At 3-5 query types, there's roughly a coin flip that manual review even covers the affected scenario. At 10+ query types, manual review touches maybe 20% of the surface area. The next step — assertion tests that check output contains certain strings, doesn't exceed a length, includes required disclaimers — catches structural regressions but misses semantic ones entirely. A response can pass every assertion and still be wrong. Both approaches share the fundamental flaw: no systematic comparison between versions. Without baseline scores across a representative dataset, there's no way to quantify whether a change made things better or worse.

**Pattern that solves it:** [Eval Harness](../patterns/testing/eval-harness/)

---

### Eyeballing outputs and keyword assertions

**What teams try:** Eyeballing a few outputs after each prompt change. Keyword assertions that check for required strings, length constraints, or required disclaimers.

**Why it fails:** With five test cases, there's roughly a coin flip that the evaluator tests the affected scenario after a change. Keyword assertions test structure, not semantics — a response can pass every assertion and be factually wrong. It's testing that the calculator returned a number, not that it returned the right number. The deeper flaw: no baseline comparison. Without stored scores from the previous prompt version, there's no way to quantify whether a change made things better or worse. A static test suite also creates false confidence — regressions in new query categories added after the suite was built pass silently.

**Pattern that solves it:** [Regression Testing](../patterns/testing/regression-testing/)

---

### Hand-written adversarial test cases

**What teams try:** Writing a few "tricky" test cases by hand — a prompt injection attempt, an empty string, something with special characters. Testing the model in isolation rather than the full system.

**Why it fails:** A dozen hand-crafted adversarial inputs covers a dozen scenarios out of thousands. The coverage gap isn't visible until something breaks in production. Testing the model in isolation is also insufficient — a model might correctly refuse a prompt injection, but if the application passes LLM output unsanitized to a SQL query, a database, or a shell command, the injection still succeeds downstream. Adversarial testing that doesn't exercise the full pipeline — including tool calls, RAG retrieval, and output handling — misses the attacks that matter most in production.

**Pattern that solves it:** [Adversarial Inputs](../patterns/testing/adversarial-inputs/)

---

### Offline benchmark evaluation then full deploy

**What teams try:** Evaluating prompts on a benchmark dataset and deploying once the score exceeds a threshold. Then deploying to 100% of traffic immediately.

**Why it fails:** The benchmark grows stale. Teams add features, user behavior shifts, and the dataset accumulates coverage gaps. A prompt scoring 96% on a dataset assembled six months ago might handle a new request category — now 20% of traffic — poorly. The compounding effect of incremental prompt edits without change tracking creates prompt drift: gradual degradation that tips into a sharp, visible failure. Deploying directly to 100% of traffic means no comparison between old and new on live requests, no statistical signal before all users are affected, and rollback only becomes an option after users experience the failure.

**Pattern that solves it:** [Prompt Rollout Testing](../patterns/testing/prompt-rollout-testing/)

---

### Exact-match assertions and mean score thresholds

**What teams try:** Exact-match snapshot assertions (`expect(output).toBe(snapshot)`). Or running an overall semantic similarity score across a test corpus and setting a threshold on the mean.

**Why it fails:** The model rephrases its answer on every run, even at temperature 0, even for the same prompt. Exact-match tests generate constant noise — teams start using `--updateSnapshot` to silence failures, at which point the tests catch nothing. Mean score thresholds hide distribution problems. A change that improves 80% of cases while degrading 20% passes a mean threshold of 0.8 and ships with a hidden regression. The insight snapshot testing adds is per-case tracking: each snapshot either passes or fails individually. Skipping the baseline altogether makes the whole approach void — snapshot testing only catches regressions if you've captured what good looks like before the change.

**Pattern that solves it:** [Snapshot Testing](../patterns/testing/snapshot-testing/)

---

## Orchestration

### Trusting the LLM to self-terminate

**What teams try:** Adding system prompt instructions like "stop after completing the task" or "don't repeat yourself" and assuming the model will comply.

**Why it fails:** LLMs don't have reliable self-awareness of their own execution history. A model can't count how many times it's called a tool — it processes each turn in context, and context windows are finite. At turn 47, the model may not have access to turns 1–20 at all. Termination is a judgment call, not a reasoning one, and that judgment depends on subtle cues that drift with prompt changes, model updates, and input distribution shifts. A prompt that reliably terminates with one model version may loop with the next.

**Pattern that solves it:** [Agent Loop Guards](../patterns/orchestration/agent-loop-guards/)

---

### Catch-and-retry without error context

**What teams try:** Wrapping tool calls in a try/catch, catching the JSON parse error, and re-running the same prompt. Or trusting constrained decoding (strict mode) alone to ensure valid tool calls.

**Why it fails:** Catch-and-retry doesn't tell the model why the call failed. The model regenerates from the same context and produces the same malformed call again — it doesn't know the error was structural. At a 5% parse failure rate and a 3-retry limit, you've tripled API costs for those requests while delivering the same error to users. The deeper problem: a retry loop with no validation layer can't distinguish a transient API error (worth retrying) from a structural schema violation (worth fixing upstream). Constrained decoding guarantees syntactically valid JSON — it doesn't guarantee the arguments are semantically correct. The model can still pass the wrong value for a field, or call a tool that's valid-by-schema but inappropriate for the current task state.

**Pattern that solves it:** [Tool Call Reliability](../patterns/orchestration/tool-call-reliability/)

---

### Ad-hoc step saves without recovery logic

**What teams try:** Writing completed step outputs to a database inside the workflow function, then retrying from scratch on failure.

**Why it fails:** Three specific ways. It doesn't handle the failure case — when the workflow crashes at step 8, the retry logic still starts at step 1. The saves are in the database, but nothing reads them back; adding "check if step N result exists before running" to each step turns a 10-step workflow into 10 bespoke if-else branches that diverge from the workflow logic over time. It conflates storage with resumption — knowing what completed is different from knowing how to continue; step 3's output might depend on both step 1 and step 2 being complete. It doesn't handle partial step failures — if an LLM call times out with no response, you can't distinguish "step 3 timed out" from "step 3 never ran."

**Pattern that solves it:** [State Checkpointing](../patterns/orchestration/state-checkpointing/)

---

### Vague capability descriptions in the router prompt

**What teams try:** Describing each agent's capabilities in a system prompt and asking the LLM router to "pick the best one."

**Why it fails:** Capability descriptions overlap. An agent described as "handles customer questions about orders" and one described as "handles billing and payment questions" will both seem relevant to "I need to cancel my order and get a refund." Without explicit decision boundaries, the router makes ambiguous calls inconsistently. The same input may route differently on back-to-back requests because the LLM samples from its probability distribution rather than executing deterministic logic. Misrouting isn't just a quality issue — when any agent in the pool handles sensitive operations (writes, deletions, API calls with side effects), inconsistent routing becomes a correctness and safety problem.

**Pattern that solves it:** [Multi-Agent Routing](../patterns/orchestration/multi-agent-routing/)

---

## Data Pipeline

### Fixed-size character splitting

**What teams try:** Split every document into N-character chunks with some overlap. The default in most libraries.

**Why it fails:** Real documents aren't uniform prose. Fixed-size splitting cuts through sentences, code blocks, and table rows mid-element, producing fragments that embed poorly because they represent half a thought. A code function split at the 512-character mark becomes two meaningless halves — neither half retrieves correctly against a query for that function. The other failure: using a single chunk size for all document types. A legal clause and a code snippet need different boundaries. A README with nested headings and a flat product description need different strategies.

**Pattern that solves it:** [Chunking Strategies](../patterns/data-pipeline/chunking-strategies/)

---

### Naive FIFO context trimming

**What teams try:** A conditional that checks total token length and slices off the earliest messages when it's too long — `messages.slice(-50)`.

**Why it fails:** System messages are the most important item in the context: they define the assistant's role, constraints, and output format. Slicing from the beginning deletes system prompts first, exactly when they're most needed — in long conversations where the model has had time to drift. The assistant becomes amnesiac and inconsistent, and there's no signal telling you it happened. The second mistake: building a summarization approach that requires a real LLM call in the hot path of your request. Calling an LLM to produce a summary before you can call the LLM for the user's actual request doubles your latency on every turn that hits the limit. Summarization belongs in a background process, not inline.

**Pattern that solves it:** [Context Management](../patterns/data-pipeline/context-management/)

---

### Write-once embeddings with no refresh path

**What teams try:** Embed the corpus at ingestion time, build the index, ship it. If something seems off, re-embed everything.

**Why it fails:** Full re-embed on every change becomes unworkable fast. Re-embedding a 1TB corpus weekly can run to $12,000/month in API costs just to maintain freshness. The other failure: no model version tracking. When you want to switch embedding models, you discover you have no metadata about which model generated which vectors — you can't do a phased migration; you rebuild from scratch with an availability gap. Rolling new-model embeddings into a live index is a dangerous naive move: if you re-embed some documents with the new model and leave others on the old one, you're comparing vectors from incompatible geometric spaces. The index is silently corrupted — everything still responds, but similarity scores are meaningless across the model boundary.

**Pattern that solves it:** [Embedding Refresh](../patterns/data-pipeline/embedding-refresh/)

---

### Trusting default vector DB maintenance

**What teams try:** Ignoring maintenance entirely ("the vector DB handles it"), or scheduling full index rebuilds on a cron job.

**Why it fails:** Background maintenance processes have configurable thresholds designed for average-case workloads — not calibrated to a specific churn rate. A collection seeing 500 document updates per day behaves differently from one with 10K vectors. Full rebuilds fix the problem at the wrong granularity: a complete index rebuild at 500K vectors takes 20–60 minutes, blocks reads during reconstruction, and consumes significant CPU and memory. Doing this daily to handle 0.5% document churn is like rebooting a server to clear a temporary file. The specific failure: scheduled rebuilds run at off-peak hours, but the index degrades throughout the day as churn accumulates. At 100K req/day with 2% daily turnover, tombstone accumulation adds 10–20ms to p95 latency after six months without triggering an alert.

**Pattern that solves it:** [Index Maintenance](../patterns/data-pipeline/index-maintenance/)

---

## Performance

### Per-step static timeouts

**What teams try:** Setting a fixed timeout on each pipeline step — 2-second timeout on retrieval, 5-second timeout on generation, and so on.

**Why it fails:** Static timeouts don't account for variability between steps. If retrieval finishes in 50ms, that surplus should be available to generation — but with static timeouts, it's wasted. Per-step timeouts also don't compose: five steps each with a "reasonable" 2-second timeout gives you a 10-second worst case, which might be 3x the actual SLA. The subtler failure: static timeouts can't make tradeoff decisions. When you're 2.5 seconds into a 3-second budget, the right move might be to skip re-ranking and go straight to generation with a faster model. Per-step timeouts have no concept of "remaining budget" — each step operates in isolation. At 10K+ requests/day, this creates a pattern where tail latency creeps up without any single step appearing slow.

**Pattern that solves it:** [Latency Budget](../patterns/performance/latency-budget/)

---

### Uncapped parallelism without jitter

**What teams try:** `asyncio.gather()` or `Promise.all()` with no concurrency cap. Semaphore-limited concurrency without token budget tracking. Exponential backoff without jitter.

**Why it fails:** In production, when a batch job launches 500 tasks with no cap, all 500 requests fire simultaneously. The first 8 or so succeed; the rest get 429 errors. All 492 failures retry at similar exponential backoff intervals because they all started at the same moment — the retry wave hits the provider all at once. A semaphore without a token budget limits concurrent requests but doesn't prevent tokens-per-minute exhaustion: 25 concurrent requests each with 4,000-token inputs will blow through a 100K TPM limit instantly. Backoff without jitter is theater — even with semaphores and exponential backoff, if you don't add jitter, all retrying instances wake up at approximately the same time.

**Pattern that solves it:** [Concurrent Request Management](../patterns/performance/concurrent-request-management/)

---

### Promise.all / asyncio.gather as batching

**What teams try:** Using `Promise.all()` or `asyncio.gather()` for concurrent processing, treating it as equivalent to batching. Or sequential one-by-one processing with no checkpointing.

**Why it fails:** `Promise.all` / `asyncio.gather` is concurrent requests, not batching — each request still runs independently at the server. All the rate limit errors arrive at once. At 10,000 documents, this produces a 429 storm that exhausts retry budget faster than sequential processing would have. Sequential processing without checkpointing breaks in a different way: jobs fail after hours of runtime and produce partial results with no clean recovery path. Neither approach is wrong for small-scale use. Both break down in ways that are hard to debug once a job has been running for an hour and starts returning partial results.

**Pattern that solves it:** [Request Batching](../patterns/performance/request-batching/)

---

### Unbuffered token streaming with no flow control

**What teams try:** Pulling tokens from the LLM and writing them directly to the response with no backpressure handling: `for await (const chunk of llmStream) { response.write(chunk); }`.

**Why it fails:** `response.write()` returns `false` when the kernel socket buffer is full and the writable stream is requesting a pause. Ignoring that return value is ignoring the backpressure signal entirely — the writable stream's internal queue grows until the process runs out of memory. The Python equivalent — writing tokens without calling `drain()` — has the same failure mode. Both patterns work fine in load tests with fast clients on a local network, then fail in production when a mobile client on a bad connection, a corporate proxy that buffers aggressively, or a downstream service under load can't consume fast enough. Adding a fixed `highWaterMark` prevents OOM but doesn't handle disconnect detection — zombie streams with zombie KV caches are a GPU cost problem, not just a memory problem.

**Pattern that solves it:** [Streaming Backpressure](../patterns/performance/streaming-backpressure/)

# Human-in-the-Loop

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

Agent systems fail in two directions: they automate what should've been reviewed, or they surface so many review requests that humans stop paying attention. Both are production failures, but the first one is the expensive kind.

A SaaS support team let an agent propose refunds. Then, quietly, it started executing them too. Within a week it had issued three refunds outside policy — one above the manual approval threshold. The error wasn't the refund logic; it was the absence of a gate between "propose" and "execute." By the time anyone noticed, the pattern had compounded: the agent had also generated shipping labels and sent customer confirmations for returns that weren't authorized. Four systems touched, one approval step missing.

This pattern keeps appearing. Agents asked to organize files restructure entire directories. An expense management agent identifies software overspending and cancels subscriptions unilaterally ([Anthropic's framework for safe agents](https://www.anthropic.com/news/our-framework-for-developing-safe-and-trustworthy-agents) uses this exact scenario to illustrate why agents must "retain control over how their goals are pursued"). A legal research agent cites nonexistent cases with high confidence. The common thread: the system had no principled mechanism to decide which actions needed a human in the decision path, so it defaulted to none.

The hard part isn't building the approval UI. It's the routing logic: given an action, how do you decide whether it needs review? Static rules ("always approve financial transactions") don't survive contact with real systems. What you actually need is a risk classifier that considers irreversibility, blast radius, confidence, and compliance exposure — and routes accordingly.

## What I Would Not Do

The standard first attempt is a manual escalation list: a hardcoded set of action types that route to review. Someone adds `send_email` and `delete_record` to the list and calls it done. This fails within a month.

Hardcoded lists miss the combinatorial problem. A `send_email` with a discount code to one test user is fine. A `send_email` with an incorrect discount code to 50,000 customers is not. The action type is the same; the blast radius is completely different. A static list can't express that distinction.

The second failure mode is overescalation. Teams scared of the first problem add everything to the review queue "just in case." Reviewers see 200 items a day. By week two, approval rate is 99% and reviewers are clicking through without reading. This is worse than no review: you've created the appearance of oversight with none of the protection. The automation-bias research is clear — when humans approve 99% of decisions, the 1% they should've caught still gets through.

The third failure mode is treating approval as a fire-and-forget. The agent pauses, sends a notification, and waits. If the reviewer doesn't respond in two hours, the workflow hangs forever — or worse, times out with no clear error state. Durable state persistence and explicit timeout escalation are load-bearing parts of this pattern, not afterthoughts.

## When You Need This

- An agent is taking actions with real-world consequences — emails sent, records modified, transactions executed, external APIs called
- The cost of a wrong automated action exceeds the cost of human review time (even at low error rates)
- You're operating in a regulated domain where specific action types require documented human sign-off (financial services, healthcare, legal)
- An agent is operating on bulk operations — any action touching >N records warrants pre-execution review regardless of action type
- You want reviewer decisions to feed back into the system — approved/rejected actions become training signal and threshold calibration data
- Current escalation policy is implicit ("the team knows what needs review") and hasn't been written down

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **Agents → Required.** Autonomous agents take irreversible actions across external systems. I wouldn't want to get paged about a customer-facing incident without having pre-action gates in place — especially for actions involving external APIs, financial operations, or bulk data changes. The missing approval step is what turns a minor logic error into a cascading multi-system incident.
- **RAG → Optional.** RAG systems primarily retrieve and generate text rather than execute actions. HITL adds value when the generated output reaches external stakeholders directly (email drafting, document publishing), but most RAG outputs are displayed to a human user who already serves as the final decision-maker before any action is taken.
- **Batch → Optional.** Batch jobs run without real-time users, but also without the urgency pressure that causes reviewers to rubber-stamp queues. I'd consider it when the batch produces outputs that trigger downstream actions automatically — if a batch job writes records that another process immediately acts on, that's effectively agent behavior.

## The Pattern

### Architecture

```
              ┌──────────────────────────────────┐
              │         Agent Decision            │
              │  (action + context + trace)       │
              └──────────────┬───────────────────┘
                             │
              ┌──────────────▼───────────────────┐
              │         Risk Classifier           │
              │  - Irreversibility score          │
              │  - Blast radius estimate          │
              │  - Agent confidence score         │
              │  - Compliance flag check          │
              └──────────────┬───────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
┌───────▼────────┐  ┌────────▼────────┐  ┌───────▼────────┐
│ Auto-Approve   │  │  Review Queue   │  │   Escalate     │
│ conf > 0.85    │  │  0.60–0.85 conf │  │  conf < 0.60   │
│ reversible     │  │  SLA: 4h        │  │  compliance    │
│ low blast      │  │  team reviewers │  │  SLA: 1h       │
└───────┬────────┘  └────────┬────────┘  └───────┬────────┘
        │                    │                    │
        │           ┌────────▼────────┐           │
        │           │   Reviewer UI   │           │
        │           │  - Context      │           │
        │           │  - Trace        │           │
        │           │  - Approve /    │           │
        │           │    Modify /     │           │
        │           │    Reject       │           │
        │           └────────┬────────┘           │
        │                    │                    │
        └──────────┬──────────────────────────────┘
                   │
        ┌──────────▼──────────┐
        │  Durable State      │  ← checkpoint before pause
        │  (resume on approve)│
        └──────────┬──────────┘
                   │
        ┌──────────▼──────────┐
        │   Action Execution  │
        └──────────┬──────────┘
                   │
        ┌──────────▼──────────┐
        │  Audit + Feedback   │  ← outcome → calibration
        └─────────────────────┘
```

> Confidence thresholds and tier boundaries (0.85, 0.60) are illustrative starting points. Calibrate against your false-positive rate and reviewer capacity after 30 days of production data.

### Core Abstraction

```typescript
interface HumanInTheLoopGate {
  // Evaluate an action and return routing decision
  evaluate(action: AgentAction): Promise<RoutingDecision>;

  // Submit action to review queue; returns reviewId
  enqueue(action: AgentAction, tier: ReviewTier): Promise<string>;

  // Wait for reviewer decision (throws TimeoutError if SLA exceeded)
  awaitDecision(reviewId: string, timeoutMs: number): Promise<ReviewDecision>;

  // Record outcome for threshold calibration
  recordOutcome(reviewId: string, outcome: ActionOutcome): Promise<void>;
}

interface AgentAction {
  type: string; // e.g., "send_email", "delete_record"
  payload: unknown; // action parameters
  confidence: number; // agent's self-reported confidence [0, 1]
  affectedCount: number; // blast radius estimate
  irreversible: boolean; // can this be undone?
  complianceFlags: string[]; // regulatory categories that apply
  reasoningTrace: string; // agent's reasoning for reviewer context
}

type ReviewTier = "auto" | "team" | "escalate";

interface ReviewDecision {
  outcome: "approved" | "modified" | "rejected";
  modifiedPayload?: unknown; // if reviewer changed action parameters
  rationale?: string; // reviewer note for audit log
}
```

### Configurability

| Parameter              | Default         | Effect                                                               | Safe Range                      |
| ---------------------- | --------------- | -------------------------------------------------------------------- | ------------------------------- |
| `autoApproveThreshold` | `0.85`          | Confidence above this proceeds without review                        | 0.80–0.95 (lower = more review) |
| `escalateThreshold`    | `0.60`          | Confidence below this goes to escalation tier                        | 0.50–0.75                       |
| `teamReviewSlaMs`      | `14400000` (4h) | SLA before auto-escalation                                           | 1h–8h                           |
| `escalationSlaMs`      | `3600000` (1h)  | SLA before critical alert                                            | 15m–2h                          |
| `blastRadiusThreshold` | `100`           | Records affected above this triggers review regardless of confidence | Tune to data sensitivity        |
| `complianceOverride`   | `true`          | Compliance-flagged actions always go to escalation tier              | Don't disable                   |

> These defaults are starting points for a moderate-sensitivity system. Irreversibility tolerance, SLA commitments, and reviewer headcount all shift what's appropriate. Recalibrate after 30 days using Expected Calibration Error (ECE) on reviewer outcomes.

### Key Design Tradeoffs

**Durable state is non-optional.** When an agent pauses for review, its execution state must survive restarts. In-memory pause-and-wait fails the moment the process restarts. This means checkpointing to a persistent store (PostgreSQL, Redis) before enqueueing — not after. The checkpoint is your recovery path if the approval window outlasts the process.

**Confidence scores require calibration.** Self-reported confidence from LLMs is notoriously miscalibrated — models can be highly confident on wrong outputs. The threshold isn't trustworthy on day one. Design your logging to capture (confidence, outcome) pairs and run calibration analysis at 30 days. Expected Calibration Error (ECE) measures the average difference between predicted confidence and actual accuracy — a score of 0.10 means predictions labeled "90% confident" are right only 80% of the time. Use ECE to detect when thresholds have drifted from the actual risk profile.

**Timeout is a routing decision, not an error.** When an SLA expires without a decision, the pattern must take a defined action: escalate, default-reject, or default-approve. "Hang indefinitely" is not a valid option. Choose default-reject for irreversible high-stakes actions; choose escalation for everything else.

**Feedback loop closes the system.** Reviewer decisions (approve/modify/reject) and their outcomes feed back as calibration signal. Systems without this become miscalibrated over months — the thresholds drift from the actual risk profile as agent behavior and data distribution change.

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

| Failure Mode                                                                                                                                                                                           | Detection Signal                                                                                                                                                                                                                         | Mitigation                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Queue flooding** — agent generates far more review requests than reviewers can handle; queue grows, SLAs miss, reviewers rubber-stamp to clear backlog                                               | Review queue depth > 2× reviewer daily capacity; approval rate >98% over 7-day window                                                                                                                                                    | Auto-calibrate confidence thresholds upward based on approval rate; add auto-approve rules for consistently-approved action types after 30 days of data            |
| **Stale checkpoint hang** — process restarts mid-approval window; state not persisted; action never resumes or executes twice                                                                          | Actions stuck in "awaiting_approval" state > 2× SLA with no reviewer activity; duplicate action IDs in execution log                                                                                                                     | Checkpoint execution state to durable store before enqueueing; use idempotency keys on action execution; add timeout that escalates rather than hanging            |
| **Confidence miscalibration** — agent confidence scores don't correlate with actual error rate; low-risk items flood queue, high-risk items slip through auto-approve                                  | High rejection rate on auto-approved items; ECE score above 0.1 after 30 days (0.1 is a common starting threshold in ML calibration literature; adjust based on your system's risk tolerance — safety-critical systems may warrant 0.05) | Run ECE calibration on (confidence, outcome) pairs monthly; adjust thresholds; consider separate calibration per action type                                       |
| **Automation bias in reviewers** — reviewers approve at >95% rate without reading; human oversight becomes theater                                                                                     | Approval rate sustained >98% for >2 weeks; review time per item drops below 30 seconds                                                                                                                                                   | Surface review statistics to team leads weekly; sample-audit reviewer decisions; reduce queue volume before approval rate collapses                                |
| **Silent threshold drift** — as agent behavior and data distribution change, calibrated thresholds no longer match actual risk; auto-approve rate creeps up while error rate rises quietly over months | Monthly ECE score trend; fraction of post-execution error reports from auto-approved actions increasing vs. reviewed                                                                                                                     | Schedule monthly threshold recalibration; log every auto-approved action with outcome; alert if post-execution error rate on auto-approved items rises 2× baseline |
| **Missing compliance flag** — new action types added to agent without registering compliance categories; actions requiring regulatory sign-off route to team queue or auto-approve                     | Compliance audit flags actions approved without required sign-off; missing action types in compliance registry                                                                                                                           | Require compliance categories at action type registration; default unregistered action types to escalation tier                                                    |

## Observability & Operations

### Key Metrics

| Metric                           | What It Measures                                | Collection                              |
| -------------------------------- | ----------------------------------------------- | --------------------------------------- |
| `hitl.queue.depth`               | Items in review queue per tier                  | Gauge, sampled every 30s                |
| `hitl.approval_rate`             | % of reviewed items approved, per action type   | Counter ratio, 1-day rolling window     |
| `hitl.review_time_p50/p95`       | Reviewer decision latency                       | Histogram, per tier                     |
| `hitl.sla_breach_rate`           | % of items that exceeded tier SLA               | Counter ratio, daily                    |
| `hitl.auto_approve_rate`         | % of actions routed to auto-approve             | Counter ratio, by action type           |
| `hitl.post_execution_error_rate` | Error rate on actions that bypassed review      | Counter ratio, requires outcome logging |
| `hitl.confidence_ece`            | Expected Calibration Error of confidence scores | Monthly batch computation               |

### Alerting

| Alert                      | Condition                                                                                                                                                                   | Severity | Action                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------- |
| Queue depth critical       | Team queue depth > 50 items                                                                                                                                                 | Critical | Page on-call; consider temporary threshold increase to reduce inflow  |
| Approval rate ceiling      | Any action type approval rate > 98% over 7 days                                                                                                                             | Warning  | Review calibration; candidates for auto-approve whitelist             |
| SLA breach rate high       | >20% of items breach SLA in rolling 24h                                                                                                                                     | Warning  | Check reviewer availability; escalate to team lead                    |
| Post-execution error spike | Auto-approved item error rate 2× baseline (7-day rolling; adjust multiplier based on baseline variability — systems with noisy baselines may need 3× to avoid false alerts) | Critical | Lower auto-approve threshold immediately; audit recent auto-approvals |
| ECE degradation            | Monthly ECE > 0.15 (means items labeled "90% confident" are accurate ≤75% of the time)                                                                                      | Warning  | Schedule threshold recalibration before next month                    |
| Unregistered action type   | Agent attempts action type not in compliance registry                                                                                                                       | Critical | Block execution; alert engineering; register compliance categories    |

> These thresholds assume moderate reviewer capacity (~50 items/day/team). High-volume systems with dedicated review teams can tolerate higher queue depth before paging.

### Runbook

**Queue flooding (queue depth > 50):**

1. Check which action types are generating the most volume (`hitl.queue.depth` by `action_type` label)
2. Check 7-day approval rate for high-volume action types — if >95%, add to auto-approve whitelist temporarily
3. If volume spike is from a new agent deployment, verify confidence threshold was set for that agent's action types
4. If reviewer capacity is the bottleneck, temporarily raise `autoApproveThreshold` by 0.05 and monitor post-execution errors
5. Page team lead if queue depth hasn't stabilized within 2 hours

**Post-execution error spike on auto-approved items:**

1. Pull recent auto-approved actions for the failing action type
2. Check confidence score distribution — are they clustering just above threshold?
3. Lower `autoApproveThreshold` by 0.05 for that action type
4. Audit last 48h of auto-approved actions of that type manually
5. Schedule ECE recalibration if pattern persists across action types

**SLA breach cascade (escalation items not being resolved):**

1. Check escalation tier queue — who are the designated reviewers?
2. If reviewers are unavailable, route to backup designated in config
3. For items breaching escalation SLA, default to reject (do not auto-approve after SLA breach)
4. Alert engineering leadership if >5 items in escalation queue simultaneously

## Tuning & Evolution

### Tuning Levers

| Lever                              | Effect                                                                 | When to Adjust                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `autoApproveThreshold`             | Raising it routes more items to review; lowering it auto-approves more | When post-execution error rate rises (lower it); when queue floods (raise it)            |
| `escalateThreshold`                | Raising it sends more items to escalation tier                         | When team reviewers are missing high-risk items consistently                             |
| `blastRadiusThreshold`             | Lower it to catch more bulk operations for review                      | When batch-style actions start bypassing review due to individually-low confidence       |
| Action-type confidence calibration | Per-action-type threshold overrides                                    | After 30-day ECE analysis shows action types have different calibration profiles         |
| SLA windows                        | Tightening escalation SLA                                              | When reviewers are missing critical items due to long SLA windows creating false comfort |

### Drift Signals

- **Approval rate creep:** If action types that were at 85% approval are now at 97%, the agent's outputs for those types have changed — recalibrate, or those items no longer need review
- **New action types appearing in logs:** Agent capability additions that weren't registered in the compliance classifier; shows as unregistered action type alerts
- **Review time dropping week-over-week:** Reviewers spending less time per item is early signal of rubber-stamping before approval rate metric catches it
- **Post-execution error rate diverging by tier:** If reviewed items have lower post-execution errors than auto-approved items, calibration is still working; if they converge, reviewers are no longer adding value

Review calibration monthly for the first six months. After that, quarterly unless an alert fires.

### Silent Degradation

**Month 3:** Agent behavior has shifted slightly — outputs are more verbose, reasoning traces longer. Reviewers are spending 30% less time per item to maintain throughput. Approval rate is still 92%. Everything looks fine.

**Month 6:** Confidence score calibration has drifted. ECE is now 0.18 but no one ran the monthly batch. The auto-approve threshold set at 0.85 now corresponds to actions with a 15% error rate (was 5% at launch). Post-execution error rate on auto-approved items has crept from 2% to 8% over six months — below the 2× baseline alert because baseline itself drifted up.

Catches it: the monthly ECE batch job with alerting on score >0.15, and a separate alert tracking post-execution error rate trend (not just level) over a 90-day window.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers.

| Scale        | Additional Cost                        | ROI vs. No Pattern                                                                                    |
| ------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1K req/day   | +$33/day (+$990/mo)                    | Break-even at 1 prevented incident every 5 months ($5K avg incident cost)                             |
| 10K req/day  | +$319/day (+$9,570/mo)                 | ROI if error rate >0.3% on agent actions, assuming $5K avg incident cost                              |
| 100K req/day | +$488/day (tuned to 90%+ auto-approve) | Requires aggressive threshold calibration; pure human review is economically infeasible at this scale |

## Testing

See test files in `src/ts/` and `src/py/`.

- **Unit tests:** Risk classifier routing logic (all four dimensions: irreversibility, blast radius, confidence, compliance); threshold boundary conditions; timeout escalation state machine
- **Failure mode tests:** Queue flooding simulation (100 actions, low confidence); stale checkpoint recovery; confidence miscalibration detection; SLA breach escalation trigger; unregistered action type blocking
- **Integration tests:** Full approval flow with mock reviewer (approve/modify/reject paths); timeout-triggered escalation with mock clock; feedback loop recording and threshold adjustment
- **How to run:** `cd src/ts && npm test` or `cd src/py && python -m pytest`

## When This Advice Stops Applying

- Low-stakes applications where wrong outputs are harmless and the user is the final decision-maker before any action — a writing assistant that suggests edits the user applies manually doesn't need a review queue
- Real-time streaming where synchronous human review would break the user experience; this pattern requires a pause window that's incompatible with sub-second response requirements
- High-throughput batch systems where the volume makes human review economically infeasible — at 100K actions/day with a 15% escalation rate, you need 15K reviewer decisions/day; the math usually doesn't work
- Internal tools where the operator is also the reviewer — they're already in the loop by definition; adding a formal queue adds friction without adding safety
- Systems where automated safety filters (validation, PII detection, injection defense) provide sufficient protection for the action types in scope — don't add human review on top of automated filters that already have high precision

<!-- ## Companion Content

- Blog post: [Human-in-the-Loop — Deep Dive](https://prompt-deploy.com/human-in-the-loop) (coming soon)
- Related patterns:
  - [Structured Output Validation](../structured-output-validation/) (#2) — automated validation reduces the volume of items reaching the review queue
  - [PII Detection](../pii-detection/) (#7) — PII flags are a natural input to the compliance classifier
  - [Prompt Injection Defense](../prompt-injection-defense/) (#15) — injection detection can escalate directly to review tier
  - [Agent Loop Guards](../../orchestration/agent-loop-guards/) (#17) — loop detection triggers human intervention before the loop compounds
  - [Multi-Agent Routing](../../orchestration/multi-agent-routing/) (#31) — human reviewers modeled as a routing destination for high-stakes subtasks -->

# Adversarial Inputs

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

LLM systems get tested with polite, well-formed English sentences. Production users send emoji-laden fragments, Unicode edge cases, 50,000-token pastes, and text in languages the system prompt never anticipated. The gap between test-time inputs and production inputs is where failures hide.

The failures aren't hypothetical. A fintech company lost $47K in a weekend because their AI customer service bot broke on emojis in user messages — the tokenizer choked on certain Unicode sequences and returned empty strings, so customers got no responses and no fallback kicked in (composite example based on reported incidents). Microsoft had to patch Copilot after researchers demonstrated [ASCII smuggling](https://aws.amazon.com/blogs/security/defending-llm-applications-against-unicode-character-smuggling/) — embedding invisible Unicode tag characters (U+E0000 to U+E007F) that humans can't see but LLMs read and execute as instructions. GitHub Copilot has faced multiple prompt injection vulnerabilities where crafted inputs could exfiltrate sensitive context or influence generated code — a class of attack that researchers have [repeatedly demonstrated](https://embracethered.com/blog/posts/2024/github-copilot-chat-prompt-injection-data-exfiltration/) against coding assistants.

These aren't exotic attacks. PoisonedRAG research showed that injecting just 5 malicious documents into a corpus of millions caused the target AI to return attacker-chosen answers 90% of the time for specific queries. Every frontier model breaks under sustained adversarial pressure — [red team benchmarks](https://venturebeat.com/security/red-teaming-llms-harsh-truth-ai-security-arms-race) show attack success rates climbing from ~5% at one attempt to 63% at 100 attempts even against top-tier models.

Without structured adversarial testing, each of these failure modes gets discovered by users, one incident at a time.

## What I Would Not Do

The first instinct is to hand-write a few "tricky" test cases — maybe a prompt injection attempt, an empty string, and something with special characters. This gives false confidence. A dozen hand-crafted adversarial inputs covers a dozen scenarios out of thousands. The coverage gap isn't visible until something breaks in production.

The second mistake is treating adversarial testing as a one-time pre-launch exercise. Attack techniques evolve. Multi-turn jailbreaks, encoding obfuscation, and chained attack vectors didn't exist two years ago. [Red team benchmarks](https://venturebeat.com/security/red-teaming-llms-harsh-truth-ai-security-arms-race) show that fewer than 6% of models stay secure once attack vectors are combined, even when each individual check passes. A test suite frozen at launch becomes stale within months as new attack patterns emerge and system prompts change.

The third failure mode is testing the model in isolation rather than the full system. A model might correctly refuse a prompt injection, but if the application passes LLM output unsanitized to a SQL query, a database, or a shell command, the injection still succeeds downstream. Adversarial testing that doesn't exercise the full pipeline — including tool calls, RAG retrieval, and output handling — misses the attacks that matter most in production.

## When You Need This

- Your system accepts user-generated input from untrusted sources — any public-facing LLM application
- You're preparing for a security review, compliance audit, or SOC 2 certification — the [EU AI Act](https://artificialintelligenceact.eu/article/15/) (Article 15) requires demonstrated robustness for high-risk AI systems
- Your LLM has tool access (API calls, database queries, file operations) where adversarial inputs could trigger unintended actions
- You've deployed prompt injection defenses or PII filters and need to verify they hold under creative attacks, not just the examples they were built for
- Your system handles multilingual input, user-generated content, or copy-pasted text from diverse sources (PDFs, web pages, chat logs)
- You're running a RAG pipeline where external documents could contain poisoned content or hidden instructions

**Priority by system type** (from the [Navigation Matrix](../../README.md#navigation-matrix)):

- **Agents → Critical.** Agents execute tool calls, access databases, and take real-world actions based on LLM decisions. An adversarial input that tricks the model into calling a destructive API or leaking credentials isn't a quality issue — it's a security incident. I wouldn't want to ship an agent system without adversarial testing covering tool call manipulation, privilege escalation, and multi-turn jailbreaks.
- **RAG → Recommended.** RAG systems ingest external documents that could contain hidden instructions or poisoned embeddings. Adversarial testing validates that retrieval doesn't surface malicious content and that the generation step doesn't follow injected instructions from retrieved documents. I'd notice this gap within the first month of operating a public-facing RAG system.
- **Streaming → Recommended.** Streaming systems face the same adversarial input risks as any user-facing LLM, but the real-time delivery makes it harder to intercept problematic outputs mid-stream. Testing ensures that safety filters work on partial token sequences, not just complete responses.
- **Batch → Optional.** Batch systems typically process curated or internal datasets with known distributions. If the batch input source is controlled and trusted, adversarial testing is less critical. It becomes relevant if batch processing ingests user-submitted content or scrapes external sources.

## The Pattern

### Architecture

```
 ┌────────────────┐   ┌──────────────────┐
 │  Suite Config  │   │   Generators     │
 │  categories,   │   │  ┌────────────┐  │
 │  thresholds,   │   │  │ injection  │  │
 │  concurrency   │   │  │ unicode    │  │
 └───────┬────────┘   │  │ overflow   │  │
         │            │  │ encoding   │  │
         ▼            │  │ multilingual│  │
 ┌───────────────────┐│  │ custom     │  │
 │ AdversarialHarness││  └────────────┘  │
 │                   │└────────┬─────────┘
 │  Step 1: Generate │◄────────┘
 │  test cases       │
 └────────┬──────────┘
          │ for each case
          ▼
 ┌───────────────────┐
 │  Target System    │
 │  (LLM + pipeline) │
 └────────┬──────────┘
          │ response
          ▼
 ┌───────────────────┐
 │  Response Judge   │
 │                   │
 │  pattern match ──►├─── PASS
 │  against rules    │
 │                   ├─── FAIL (+ severity)
 └────────┬──────────┘
          │ all results
          ▼
 ┌───────────────────┐   ┌──────────────┐
 │  Report Builder   │──▶│  Baseline    │
 │                   │   │  (optional)  │
 │  • ASR/category   │◄──│  regression  │
 │  • failed cases   │   │  comparison  │
 │  • pass/fail      │   └──────────────┘
 └───────────────────┘
```

_Values shown (severity levels, category counts) are illustrative — actual configuration depends on your system's threat model and compliance requirements._

The core abstraction is `AdversarialHarness` — a test runner that takes a target function (anything that accepts a string and returns a string), generates adversarial inputs across configurable categories, runs them against the target, judges whether each response indicates a vulnerability, and produces a structured report.

**Core interface:**

```typescript
interface AdversarialHarness {
  // Register attack generators by category
  addGenerator(category: AttackCategory, generator: InputGenerator): void;

  // Register custom judge logic (default: rule-based)
  setJudge(judge: ResponseJudge): void;

  // Run all registered generators against the target
  run(target: TargetFunction, config?: RunConfig): Promise<TestReport>;

  // Run a single category
  runCategory(
    category: AttackCategory,
    target: TargetFunction
  ): Promise<CategoryResult>;
}
```

**Configurability:**

| Parameter             | Default      | Purpose                                        |
| --------------------- | ------------ | ---------------------------------------------- |
| `categories`          | All built-in | Which attack categories to run                 |
| `casesPerCategory`    | 50           | Number of test cases per generator             |
| `maxConcurrency`      | 10           | Parallel test execution limit                  |
| `timeoutMs`           | 30000        | Per-test-case timeout                          |
| `severityThreshold`   | `"low"`      | Minimum severity to include in report          |
| `failOnSeverity`      | `"high"`     | Severity level that causes the run to fail     |
| `includePassingCases` | false        | Whether to include passing cases in the report |
| `baselineResults`     | undefined    | Previous run results for regression comparison |

_These defaults are starting points. Your SLA requirements, threat model, and the sensitivity of your LLM's tool access would shift them — a system with database write access warrants lower `failOnSeverity` and higher `casesPerCategory` than an internal summarization tool._

**Attack categories (built-in):**

| Category              | What It Tests                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `prompt-injection`    | Direct instruction override attempts — "ignore previous instructions", role-play exploits, system prompt extraction |
| `unicode-smuggling`   | Invisible characters (U+E0000–U+E007F tag block), zero-width joiners, homoglyphs, bidirectional text overrides      |
| `input-overflow`      | Extremely long inputs, context window stuffing, repeated tokens designed to exhaust processing budgets              |
| `encoding-bypass`     | Base64-encoded instructions, ROT13 obfuscation, HTML entities, URL encoding used to slip past text filters          |
| `multilingual`        | Language switching mid-prompt, right-to-left scripts, CJK characters, mixed-script inputs that confuse tokenizers   |
| `output-manipulation` | Inputs crafted to produce specific dangerous outputs — XSS payloads, SQL fragments, markdown injection              |

**Key design tradeoffs:**

| Tradeoff                                          | This Implementation                                                                                                                 | Alternative                                                                                                                        | Why This Choice                                                                                                                                                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rule-based judging vs. LLM-as-judge               | Rule-based pattern matching for response judging (checking for leaked system prompts, dangerous output patterns, refusal detection) | LLM-as-judge would catch more subtle failures but adds cost, latency, and its own adversarial surface                              | Rule-based judging is deterministic, fast, and doesn't require an API key — the right default for a testing tool that runs in CI                                                                          |
| Built-in generators vs. external tool integration | Generators built into the library, framework-agnostic and dependency-free                                                           | Wrapping Promptfoo or Garak would give more sophisticated attack generation — uncensored attacker models and multi-turn strategies | Built-in generators cover the 80% case; teams needing deeper red teaming can use [Promptfoo](https://www.promptfoo.dev/docs/red-team/) or [Garak](https://github.com/NVIDIA/garak) alongside this harness |
| Deterministic test cases vs. random fuzzing       | Deterministic test cases from templates and seed data, not random mutations                                                         | True fuzzing finds more edge cases but makes CI flaky                                                                              | Deterministic generation makes test runs reproducible and regressions detectable; fuzzing belongs in periodic security reviews                                                                            |
| Category-based organization vs. flat test lists   | Tests organized by attack category (injection, unicode, overflow) — enables selective testing                                       | Flat test lists where cross-category attacks emerge naturally from combinations                                                    | Selective testing lets teams run only categories relevant to a code change; cross-category attacks require dedicated composite test cases                                                                 |

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

How this pattern itself can fail. Every solution creates new failure modes.

| Failure Mode                                                                                                                                                                 | Detection Signal                                                                                                                                                    | Mitigation                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **False sense of security** — all tests pass but the test suite doesn't cover the attack vectors that matter for your system                                                 | Attack success rate in production (via monitoring) diverges from test results; new vulnerability categories appear in OWASP/MITRE updates that aren't in your suite | Review and update generator categories quarterly; compare test coverage against current [OWASP Top 10 for LLMs](https://genai.owasp.org/llmrisk/llm01-prompt-injection/); add generators for any production incident that wasn't caught |
| **Overfitting to test patterns** — system gets hardened specifically against test templates while remaining vulnerable to novel variations                                   | Test pass rate climbs steadily toward 100% while production incident rate stays flat or increases                                                                   | Rotate test case templates periodically; add variation/mutation to generators; supplement with manual red teaming sessions using different attack approaches                                                                            |
| **Judge calibration drift (silent degradation)** — response judge rules become stale as system prompt or output format changes, causing real failures to be marked as passes | Judge pass rate drifts upward over months without corresponding security improvements; manual spot-checks reveal misclassified responses                            | Schedule monthly judge calibration reviews; maintain a "known bad" response set that the judge must always flag; alert when pass rate changes by >10% between runs without code changes                                                 |
| **Test suite performance degradation** — as test cases accumulate, CI runs become too slow, leading teams to skip adversarial tests or reduce coverage                       | CI pipeline duration increases beyond acceptable thresholds; adversarial test step gets commented out or moved to nightly-only                                      | Set a time budget per category; use `casesPerCategory` to cap generation; run full suite nightly, critical-only in CI; parallelize execution                                                                                            |
| **Dangerous output from generators** — adversarial test cases themselves contain genuinely harmful content that gets logged, cached, or leaked                               | Security scanning flags test artifacts; test outputs appear in application logs or monitoring dashboards                                                            | Run adversarial tests in isolated environments; scrub test artifacts after runs; don't log full adversarial inputs in production logging systems; mark test traffic clearly                                                             |
| **Regression baseline rot** — baseline results used for regression comparison become outdated as the system evolves, causing false positives or hiding real regressions      | Baseline diff shows dozens of "new failures" that are actually expected behavior changes; team starts ignoring regression alerts                                    | Re-baseline after intentional system changes (prompt updates, model swaps); separate true regressions from expected changes in the report; require explicit baseline update commits                                                     |

## Observability & Operations

**Key metrics:**

| Metric                                | Unit      | What It Tells You                                                                                         |
| ------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------- |
| Attack success rate (ASR) by category | %         | Percentage of adversarial inputs that bypass defenses. Baseline this on first run; track trend over time. |
| Regression count per run              | count     | New failures against previous baseline — catches defense regressions.                                     |
| Test suite execution time             | seconds   | Whether adversarial tests fit within CI time budget.                                                      |
| Category coverage                     | count / 6 | How many attack categories are active — dropping categories silently reduces coverage.                    |
| Judge agreement rate                  | %         | When spot-checking: percentage of judge verdicts confirmed by manual review. Tracks judge calibration.    |

**Alerting:**

| Condition                                           | Level    | Threshold                                    |
| --------------------------------------------------- | -------- | -------------------------------------------- |
| ASR increases >5% between runs without code changes | Warning  | Indicates model or provider behavior shift   |
| ASR increases >15% between runs                     | Critical | Defense regression — something broke         |
| Any critical-severity failure in CI run             | Critical | Immediate security review required           |
| Test suite duration exceeds 5 minutes               | Warning  | Performance degradation — review case counts |
| Category coverage drops below configured categories | Warning  | Generator or config issue                    |
| Judge pass rate changes >10% without system changes | Warning  | Judge calibration may be drifting            |

_These thresholds are starting points. Your baseline ASR, SLA sensitivity, and deployment frequency would shift them — a system with financial data access warrants tighter alerting than an internal FAQ bot._

**Runbook — when ASR spikes:**

1. Check first: was there a system prompt change, model swap, or dependency update? If yes, the ASR change may be expected — review and re-baseline.
2. Identify which categories spiked: injection? unicode? encoding? This narrows the investigation.
3. Review the specific failed test cases — are they exploiting a new vulnerability or has a defense been removed?
4. If a real regression: revert the change, add the adversarial case to the regression suite, fix, and re-deploy.
5. If a false positive (judge miscalibration): update judge rules and re-run.

**Runbook — when test suite times out:**

1. Check `casesPerCategory` — has it been increased without adjusting time budget?
2. Check target system latency — is the LLM slower than usual?
3. Reduce `casesPerCategory` for CI; keep full suite in nightly runs.
4. Increase `maxConcurrency` if the target can handle more parallel requests.

## Tuning & Evolution

**Tuning levers:**

| Lever               | Safe Range               | Dangerous Extreme | Effect                                                                                                  |
| ------------------- | ------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------- |
| `casesPerCategory`  | 10–100                   | >500              | More cases = broader coverage but longer runs. Below 10 risks missing attack variations.                |
| `maxConcurrency`    | 1–25                     | >50               | Higher concurrency = faster runs but may trigger rate limits on real LLM targets.                       |
| `failOnSeverity`    | `"high"` to `"critical"` | `"info"`          | Setting too low causes CI to fail on minor issues; setting too high misses real vulnerabilities.        |
| `timeoutMs`         | 5000–60000               | <1000             | Too short causes false failures on slow targets; too long wastes CI time on hanging requests.           |
| `severityThreshold` | `"low"` to `"medium"`    | `"critical"`      | Higher threshold hides lower-severity findings from reports — they still exist, they're just invisible. |

**Drift signals:**

| Signal                                                                                | What It Means                                                 | Action                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| ASR trending toward 0% across all categories over several months                      | Test patterns may have become predictable                     | Rotate templates; supplement with manual red teaming |
| New OWASP LLM Top 10 entries that don't map to existing categories                    | Attack landscape has evolved past current coverage            | Add generators for new vulnerability categories      |
| System prompt changes that aren't followed by adversarial test runs                   | Coverage gap — defenses may not apply to new prompt structure | Run full adversarial suite after any prompt change   |
| Model provider changes (new model version, fine-tuning updates) without re-baselining | Stale comparison — model behavior may have shifted            | Re-baseline after provider updates                   |

**Silent degradation:**

- **Month 3:** Judge rules that matched the original system prompt format may no longer detect leaks if the prompt structure changed. The judge still runs, still reports "all pass," but it's checking for patterns that no longer apply. Symptom: ASR gradually drifts to 0% — feels good but isn't real.
- **Month 6:** Attack landscape has evolved — multi-turn jailbreaks, new encoding tricks, tool-call exploitation techniques emerge. The test suite covers 2024-era attacks against a 2025-era threat landscape. Symptom: adversarial tests pass clean while security researchers find vulnerabilities in minutes using updated techniques.
- **Proactive check:** Monthly manual red team session (even 30 minutes) using current attack tooling ([Promptfoo](https://www.promptfoo.dev/docs/red-team/), [Garak](https://github.com/NVIDIA/garak)). If manual testing finds issues that the automated suite misses, the suite is stale. Update generators and judge rules accordingly.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers.

| Scale        | Additional Cost | ROI vs. No Pattern                                                                           |
| ------------ | --------------- | -------------------------------------------------------------------------------------------- |
| 1K req/day   | +$0.05/day      | Negligible cost; mock provider covers CI runs for free. Real LLM runs add ~$1.41/month.      |
| 10K req/day  | +$0.35/day      | Daily adversarial testing at $10.58/month. One prevented incident covers decades of testing. |
| 100K req/day | +$0.53/day      | $15.86/month — 0.05% of typical production API spend. Clear ROI at any scale.                |

## Testing

How to verify this pattern works correctly. See test files in `src/ts/__tests__/index.test.ts`.

Run tests: `cd src/ts && npm install && npm test`

- **Unit tests (8 tests):** Harness creation, single category execution, `casesPerCategory` configuration, unknown category handling, custom generator registration, custom judge replacement, target error handling, and timeout enforcement.
- **Failure mode tests (6 tests):** One test per failure mode from the table above — false sense of security (vulnerable provider triggers failures), overfitting (secure provider passes more), judge calibration drift (known-bad responses always flagged), test suite performance (runs within time budget), dangerous output from generators (outputs are strings only), and regression baseline rot (detects regressions against baseline).
- **Integration tests (7 tests):** Full pipeline across all 6 categories, vulnerable provider detection, selective category runs, `failOnSeverity` threshold behavior, concurrency limit enforcement, and unicode smuggling detection with tag characters.

## When This Advice Stops Applying

| Condition                                       | Why This Pattern Stops Applying                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Internal tools with trusted users**           | If every user is an authenticated employee and inputs come from controlled forms, the adversarial surface is minimal. The investment in fuzzing and red teaming has low ROI compared to other testing priorities.                                                                                                                |
| **Machine-generated inputs from known schemas** | Systems where all inputs are produced by upstream code with validated schemas don't face adversarial input risks — the input space is constrained by design.                                                                                                                                                                     |
| **Very early prototypes**                       | Before product-market fit, hardening against adversarial inputs is premature optimization. Focus on whether the system solves the right problem first.                                                                                                                                                                           |
| **Batch systems with curated datasets**         | If you control the input corpus and can verify its integrity before processing, adversarial testing adds overhead without proportional safety benefit.                                                                                                                                                                           |
| **Model providers improve input sanitization**  | As model providers build stronger native defenses against injection and encoding attacks, some adversarial test categories may become redundant. That said, I wouldn't count on this happening soon — the architectural vulnerability (models can't distinguish instructions from data) is fundamental to how current LLMs work. |

<!-- ## Companion Content

- Blog post: [Adversarial Inputs — Deep Dive](https://prompt-deploy.com/adversarial-inputs) (coming soon)
- Related patterns:
  - [Eval Harness](../eval-harness/) — provides the evaluation framework that adversarial test suites plug into
  - [Prompt Injection Defense](../../safety/prompt-injection-defense/) — adversarial tests validate that injection defenses hold under creative attacks
  - [Regression Testing](../regression-testing/) — adversarial test cases that catch real failures become permanent regression tests
  - [PII Detection](../../safety/pii-detection/) — adversarial inputs can attempt to bypass PII filters using encoding tricks
  - [Structured Output Validation](../../safety/structured-output-validation/) — validates that adversarial inputs don't corrupt output structure -->

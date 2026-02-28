# PII Detection

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

Users paste sensitive data into LLM-powered features — social security numbers, credit card numbers, medical records, email addresses. Without PII detection, that data flows to third-party API providers, gets logged in your observability stack, and potentially persists in model training data.

In April 2023, [Samsung](https://www.cybersecuritydive.com/news/Samsung-Electronics-ChatGPT-leak-data-privacy/647219/) engineers pasted proprietary source code and internal meeting transcripts into ChatGPT on at least three separate occasions within 20 days of the tool being approved for internal use. The data became irrecoverable — once submitted, it lived on OpenAI's servers and could influence future model outputs. Samsung banned ChatGPT internally, launched disciplinary investigations, and started building an in-house alternative. JPMorgan, Goldman Sachs, Amazon, and Verizon issued similar restrictions after discovering the same patterns among their employees.

[Cyberhaven Labs](https://www.cyberhaven.com/blog/4-2-of-workers-have-pasted-company-data-into-chatgpt) analyzed data from 1.6 million workers and reported that 11% of data pasted into ChatGPT was confidential — source code, client information, strategic documents, even patient medical records. The average company leaked confidential material to ChatGPT hundreds of times per week. Traditional DLP tools missed most of it because employees copy-paste content into browser windows rather than uploading files, and the pasted text doesn't always match recognizable patterns like credit card numbers or SSNs.

This creates regulatory exposure under [GDPR](https://gdpr-info.eu/art-83-gdpr/), HIPAA (violations from unsanctioned PHI processing without a BAA), and CCPA. The exposure scales linearly with user count — every user who interacts with an LLM feature is a potential PII ingestion point.

## What I Would Not Do

It's tempting to reach for a regex-only approach: a handful of patterns for SSNs, credit card numbers, email addresses, and phone numbers. Run them on input text, redact matches, ship it.

This breaks in two specific ways. First, regex-only detection achieves roughly [0.65 recall in academic evaluations](https://ijcjournal.org/InternationalJournalOfComputer/article/download/2458/919/6203) — meaning up to 35% of PII slips through undetected. Names, addresses, medical conditions, and context-dependent identifiers don't follow predictable patterns. "John Smith discussed his diabetes diagnosis with Dr. Chen" contains three pieces of PII that no regex will catch. Second, regex produces significant false positives — any 9-digit number matches an SSN pattern, any 16-digit number matches a credit card pattern. At 10K requests/day, a 5% false positive rate means 500 unnecessary redactions per day, eroding user trust when legitimate content gets mangled.

The other approach I'd avoid: using the LLM itself to detect PII. LLMs operate probabilistically — they'll catch PII sometimes, miss it other times (especially for ambiguous or less common formats like partial addresses or informal references like "my social is..."), and the inconsistency makes compliance audits impossible. A deterministic PII detection layer that runs before the LLM sees the data is the bar I'd set.

## When You Need This

- Your system sends user-generated text to a third-party LLM provider and you don't control what users type
- You log LLM inputs/outputs in your observability stack (most tracing setups do), creating a second copy of any PII
- You operate in a regulated industry — healthcare (HIPAA), finance (PCI-DSS, SOX), or serve EU users (GDPR)
- You've had a compliance audit that flagged LLM data flows, or a data breach scare involving AI features
- Your user base exceeds a few hundred — at that point, the probability of PII in inputs approaches certainty
- You're building features where users describe personal situations (customer support, medical intake, financial planning)

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **RAG → Required.** Retrieval pipelines ingest user queries and embed them alongside retrieved context. PII in queries gets indexed into vector stores, creating a persistent copy that's hard to locate and delete. I wouldn't be comfortable getting paged about a data subject access request without knowing PII was stripped before embedding.
- **Agents → Required.** Autonomous tool-using loops pass user input through multiple steps — each step is a potential PII exposure point. An agent might log the input, pass it to a tool, store intermediate state, and send results to the LLM. That's four copies of any PII from a single user message.
- **Streaming → Required.** Real-time token delivery means PII detection has to run synchronously on the input before streaming begins. The latency constraint is tighter here — detection can't add more than ~50ms without impacting perceived responsiveness. But skipping detection isn't an option when the stream is going to a third-party provider.
- **Batch → Required.** High-throughput offline processing amplifies exposure: 100K documents per batch run means any PII that slips through gets replicated at scale. The upside is that batch processing can tolerate higher detection latency, so you can run more thorough (slower) detection methods.

## The Pattern

### Architecture

```
User Input
    │
    ▼
┌─────────────────────────────────────┐
│       PII Detection Layer           │
│                                     │
│  ┌───────────┐    ┌──────────────┐  │
│  │   Regex   │    │     NER      │  │
│  │ Recognizers│    │  Recognizers │  │
│  │(SSN, CC,  │    │(Names, Orgs,│  │
│  │ email,    │    │ locations,   │  │
│  │ phone)    │    │ medical)     │  │
│  └─────┬─────┘    └──────┬───────┘  │
│        └───────┬─────────┘          │
│                ▼                    │
│     ┌────────────────────┐          │
│     │   Entity Merger    │          │
│     │  (deduplicate,     │          │
│     │   resolve overlaps,│          │
│     │   apply confidence │          │
│     │   threshold)       │          │
│     └────────┬───────────┘          │
│              ▼                      │
│     ┌────────────────────┐          │
│     │ Redaction Strategy │          │
│     │ (replace | mask |  │          │
│     │  hash | placeholder│          │
│     │  with reversal map)│          │
│     └────────┬───────────┘          │
└──────────────┼──────────────────────┘
               │
               ▼
        ┌─────────────┐
        │ Sanitized   │──→ LLM Provider
        │ Text + Map  │
        └──────┬──────┘
               │
               ▼
        ┌─────────────┐
        │  Reversal   │──→ User Response
        │ (Optional)  │
        └─────────────┘
```

_Confidence thresholds, entity types enabled, and redaction strategy are illustrative — they depend on the use case and regulatory requirements._

#### Core Abstraction

The central interface is a `PIIDetector` that accepts raw text and returns sanitized text plus a reversal map. Two detection engines run in parallel: regex recognizers for structured PII (SSN, credit card, email, phone, IP address) and NER recognizers for context-dependent PII (person names, organizations, locations, medical terms). An entity merger resolves overlapping detections, deduplicates, and applies a confidence threshold before passing results to the redaction strategy.

```typescript
interface PIIDetector {
  detect(text: string): Promise<PIIDetectionResult>;
  redact(text: string, options?: RedactionOptions): Promise<RedactedResult>;
}

interface PIIDetectionResult {
  entities: PIIEntity[];
  sanitizedText: string;
  reversalMap: Map<string, string>;
}
```

#### Configurability

| Parameter             | Default            | Description                                                                                                               |
| --------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `confidenceThreshold` | 0.7                | Minimum score to treat a detection as real PII. Lower catches more but increases false positives                          |
| `entityTypes`         | All built-in types | Which PII categories to detect (e.g., `['SSN', 'CREDIT_CARD', 'EMAIL', 'PERSON', 'PHONE']`)                               |
| `redactionStrategy`   | `'placeholder'`    | How to replace PII: `'placeholder'` (`[PERSON_1]`), `'mask'` (`***`), `'hash'` (SHA-256), or `'redact'` (remove entirely) |
| `customRecognizers`   | `[]`               | User-defined recognizers for domain-specific PII (employee IDs, internal account numbers)                                 |
| `allowList`           | `[]`               | Terms that look like PII but aren't (company names, product codes)                                                        |
| `reversible`          | `true`             | Whether to generate a reversal map for de-redaction after LLM response                                                    |

These defaults are starting points. The right `confidenceThreshold` depends on your false positive tolerance (regulated industries lean toward 0.5–0.6 for higher recall; consumer apps lean toward 0.8+ for fewer false positives). Entity types should reflect your actual regulatory exposure.

#### Key Design Tradeoffs

**Hybrid detection (regex + NER) over either alone.** Regex is fast (~1ms per KB) and precise for structured patterns but blind to context-dependent PII. NER catches names and medical terms but is slower (~5–20ms per KB depending on model size) and misses structured patterns without checksum validation. The hybrid approach trades added complexity for significantly better recall — roughly 0.85–0.95 vs. 0.65 for regex-only.

**Pre-LLM detection over post-LLM detection.** Running detection before the LLM call means PII never reaches the provider. The tradeoff: the LLM sees redacted text, which can degrade response quality (e.g., `[PERSON_1] has diabetes` loses context vs. the original). Reversible redaction with placeholders mitigates this — the LLM can reason about `[PERSON_1]` as a reference, and the placeholder gets swapped back in the response.

**Placeholder redaction over full removal.** Replacing PII with typed placeholders (`[PERSON_1]`, `[SSN_1]`) preserves semantic structure for the LLM. Full removal creates grammatical gaps that confuse models. The tradeoff: placeholders are slightly more complex to implement (you need a reversal map) but produce significantly better LLM responses.

**Synchronous detection over async detection.** PII detection runs on the critical path before every LLM call, adding latency. An async approach (detect-and-flag in the background, block only if PII is found) would be faster on the happy path but risks PII reaching the provider during the detection window. For compliance, synchronous is the bar.

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

How this pattern itself can fail. Every solution creates new failure modes.

| Failure Mode                               | Detection Signal                                                                                                                                                                            | Mitigation                                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **False negatives (missed PII)**           | Manual audit of redacted outputs reveals unredacted PII; compliance team flags samples during review                                                                                        | Add custom recognizers for missed PII types; lower confidence threshold; run periodic audit samples through a stricter detection pipeline                                           |
| **False positives (over-redaction)**       | User complaints about mangled content; spike in redaction count per request without corresponding PII increase; LLM response quality degrades                                               | Add domain-specific terms to the allow list; raise confidence threshold; review regex patterns for overly broad matches                                                             |
| **Reversal map leakage**                   | Reversal maps appear in logs, error traces, or are accessible via API; audit reveals plaintext PII in map storage                                                                           | Encrypt reversal maps at rest; exclude from logging middleware; set short TTL (minutes, not hours); never persist to disk in plaintext                                              |
| **Latency budget exceeded**                | p99 detection latency exceeds SLA (e.g., >100ms for streaming); user-facing timeouts increase                                                                                               | Profile recognizers individually; disable slow NER recognizers for latency-sensitive paths; use regex-only mode as a fast fallback                                                  |
| **NER model drift (silent degradation)**   | Detection recall drops gradually over months as user language patterns shift (new slang, new PII formats); no alert fires because the model still returns results — just fewer correct ones | Schedule monthly recall audits using a labeled PII test set; track detection counts per entity type over time; alert on sustained drops in any category (>15% decline over 2 weeks) |
| **Incomplete entity type coverage**        | New regulation requires detecting a PII type not in the recognizer set (e.g., biometric identifiers, genetic data); compliance audit fails                                                  | Maintain a registry of required entity types per regulation; review entity coverage quarterly against regulatory requirements; add custom recognizers proactively                   |
| **Regex pattern collision across locales** | Phone number patterns for one country match non-PII patterns in another (e.g., European postal codes matching US phone formats); false positive rate spikes for international users         | Use locale-aware recognizers; configure allowed locales per deployment; validate matches with contextual signals (surrounding text, user locale)                                    |

## Observability & Operations

**Key metrics:**

| Metric                           | Description                                                                                                                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pii.detection_rate`             | Percentage of requests containing at least one PII entity. Baseline this during the first week; significant shifts indicate either user behavior changes or detection drift        |
| `pii.entity_count_by_type`       | Breakdown of detected entities per type (SSN, email, phone, etc.). Used for coverage monitoring and drift detection                                                                |
| `pii.false_positive_rate`        | Tracked via user feedback ("my content was incorrectly redacted") and manual sampling. Target: <2% for consumer apps, <5% for regulated systems (where higher recall matters more) |
| `pii.detection_latency_ms`       | p50/p95/p99 latency of the detection step. Track separately from the overall request latency                                                                                       |
| `pii.redaction_reversal_success` | Percentage of LLM responses where placeholder reversal successfully restores original text. Failures indicate placeholder corruption in the LLM output                             |

**Alerting:**

| Severity           | Condition                                                                                         | Meaning                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Warning            | `pii.detection_rate` drops >20% below 7-day rolling average                                       | Possible detection regression                                                   |
| Warning            | `pii.detection_latency_ms` p99 exceeds 50ms                                                       | Approaching latency budget for streaming                                        |
| Critical           | `pii.detection_rate` drops to zero for >10 minutes                                                | Detection layer may have failed silently                                        |
| Critical           | `pii.entity_count_by_type` for any type drops to zero for >1 hour when it was previously non-zero | Recognizer may be broken                                                        |
| Warning            | `pii.false_positive_rate` exceeds 5%                                                              | Allow list or confidence threshold needs tuning                                 |
| Warning (low-side) | `pii.detection_rate` drops unusually low                                                          | Could indicate detection is no longer running or users found a way to bypass it |

These thresholds are starting points. The right values depend on your baseline detection rate, traffic profile, and SLA. Systems with higher PII prevalence (healthcare, finance) should set tighter alert thresholds.

- **Runbook:**
  - **Detection rate drop alert:** Check that the detection layer is still running (not silently failing). Verify recognizer list hasn't been modified. Run a canary test with known PII. If detection is working, the drop may reflect genuine user behavior change — verify with manual sampling
  - **Latency alert:** Profile individual recognizers to identify the slow one. Common culprit: NER recognizer on unexpectedly long inputs. Immediate fix: switch to regex-only mode for the affected endpoint. Root cause fix: add input length limits or split long text into chunks
  - **False positive spike:** Review recent allow list changes. Check if new user-generated content patterns match existing regex (e.g., product codes that look like SSNs). Add confirmed false positives to the allow list. Consider raising the confidence threshold for the affected entity type

## Tuning & Evolution

**Tuning levers:**

| Parameter             | Safe Range                   | Guidance                                                                                                                                                                                             |
| --------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `confidenceThreshold` | 0.5–0.9                      | Below 0.5, false positive rate spikes. Above 0.9, only the highest-confidence regex matches survive, and most NER detections get filtered out. Start at 0.7, adjust based on false positive feedback |
| `entityTypes`         | All built-in types (default) | Remove types that consistently produce false positives in your domain. Add custom types as regulatory requirements evolve                                                                            |
| `allowList`           | Grows over time              | Review monthly; stale entries can mask new PII patterns if the allow-listed terms change meaning                                                                                                     |
| `customRecognizers`   | Add as needed                | Add when you discover domain-specific PII that built-in recognizers miss (employee IDs, internal account numbers, API keys). Each additional recognizer adds ~0.0002ms per request                   |
| `redactionStrategy`   | `placeholder` (default)      | Best default for LLM pipelines. Switch to `hash` for audit-trail systems where you need to correlate redacted entities across requests without exposing the original values                          |

- **Drift signals:**
  - Entity type distribution shifts — if emails used to be 40% of detected PII and drop to 15%, either users changed behavior or the email recognizer is regressing. Review monthly
  - Allow list growth rate — if you're adding >5 entries/month, the recognizers may be too broad. Consider tightening regex patterns instead
  - User complaint trend — rising "my content was incorrectly redacted" complaints indicate false positive rate is climbing. Track by entity type to identify which recognizer is the culprit

- **Silent degradation:**
  - **Month 3:** New PII formats emerge that existing recognizers don't cover. International phone numbers in a new market, new types of government IDs, or custom identifier formats from partner integrations. Detection rate appears stable because the new formats are a small percentage, but undetected PII is accumulating in logs and provider systems
  - **Month 6:** User language patterns drift. Names from different cultural backgrounds, informal PII references ("my social is..."), or abbreviated formats that don't match regex patterns. Recall gradually drops without triggering detection rate alerts because the missed PII is spread across many requests. Proactive check: run the full recognizer suite against a fresh labeled sample of 500 requests every month. Compare recall against the initial baseline. If recall drops below 0.80, investigate which entity types are regressing

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers.

| Scale        | Additional Cost | ROI vs. No Pattern                                                                   |
| ------------ | --------------- | ------------------------------------------------------------------------------------ |
| 1K req/day   | +$0.00/day      | Near-zero cost; prevents regulatory exposure (GDPR fines up to €20M)                 |
| 10K req/day  | +$0.01/day      | $3.65/year for compliance coverage across 3.6M annual requests                       |
| 100K req/day | +$0.10/day      | $36.50/year — the pattern pays for itself with a single prevented compliance inquiry |

## Testing

See test files in [`src/ts/__tests__/`](src/ts/__tests__/) and `src/py/tests/`.

- **Unit tests:** Entity detection for each PII type (SSN, credit card with Luhn validation, email, phone, IP, person names), configuration handling (confidence threshold, entity type filter, allow list, custom recognizers), all four redaction strategies, and reversal map generation
- **Failure mode tests:** False negatives for context-dependent PII (names without title prefix), false positives for SSN-like patterns with allow list mitigation, reversal map sensitivity verification, latency budget validation under long text, detection count tracking for drift monitoring, entity type coverage gaps, and regex collision behavior
- **Integration tests:** Full detect → redact → LLM → reverse pipeline with mock provider, multi-entity document processing, clean text passthrough, convenience function validation, and concurrent detection independence

Run tests: `cd patterns/safety/pii-detection/src/ts && npm install && npm test`

## When This Advice Stops Applying

- Systems processing only synthetic or public data with no user-generated content — if users can't type into your system, there's no PII ingestion vector
- Internal tools where all users have security clearance for the data they're processing and the data never leaves your infrastructure
- On-premise deployments with no external API calls where data stays within your network boundary — though even here, logging and observability stacks can create unintended copies
- Systems in jurisdictions with no applicable data protection regulations (increasingly rare)
- When the cost of false positives exceeds the regulatory risk — some systems process content that looks like PII but isn't (e.g., fiction writing tools where character names and made-up SSNs are common), and aggressive detection degrades the user experience more than it protects

## Companion Content

- Blog post: [PII Detection — Deep Dive](https://prompt-deploy.com/pii-detection) (coming soon)
- Related patterns:
  - [Prompt Injection Defense](../prompt-injection-defense/) — another input safety pattern; injection can be used to exfiltrate PII
  - [Structured Output Validation](../structured-output-validation/) — validates output structure; PII detection validates output content
  - [Human-in-the-Loop](../human-in-the-loop/) — human review as a last-resort PII catch
  - [Structured Tracing](../../observability/structured-tracing/) — traces must also be PII-safe; detection informs what gets logged

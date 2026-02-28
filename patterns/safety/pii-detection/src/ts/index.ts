/**
 * PII Detection — Core Implementation
 *
 * Hybrid regex + NER detection pipeline for identifying and redacting
 * personally identifiable information before it reaches LLM providers.
 * Framework-agnostic, no external NLP dependencies — ships with built-in
 * regex recognizers and a pluggable NER interface.
 */

import type {
  PIIEntity,
  PIIEntityType,
  PIIDetectionResult,
  PIIDetectorConfig,
  PIIRecognizer,
  RedactedResult,
  RedactionOptions,
  RedactionStrategy,
  DetectionStats,
} from './types.js';

import { createHash } from 'crypto';

// ── Built-in Regex Recognizers ──────────────────────────────────────

/** US Social Security Number: XXX-XX-XXXX */
const SSN_RECOGNIZER: PIIRecognizer = {
  name: 'ssn-regex',
  entityType: 'SSN',
  recognize(text: string): PIIEntity[] {
    // Negative lookbehind/ahead to avoid matching inside longer numbers
    const pattern = /\b(\d{3}-\d{2}-\d{4})\b/g;
    return matchAll(pattern, text, 'SSN', 0.95, 'regex');
  },
};

/** Credit card numbers: 13–19 digits, optionally separated by dashes or spaces */
const CREDIT_CARD_RECOGNIZER: PIIRecognizer = {
  name: 'credit-card-regex',
  entityType: 'CREDIT_CARD',
  recognize(text: string): PIIEntity[] {
    const pattern = /\b(\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{1,7})\b/g;
    const candidates = matchAll(pattern, text, 'CREDIT_CARD', 0.9, 'regex');
    // Luhn checksum validation reduces false positives
    return candidates.filter((e) => luhnCheck(e.text.replace(/[-\s]/g, '')));
  },
};

/** Email addresses */
const EMAIL_RECOGNIZER: PIIRecognizer = {
  name: 'email-regex',
  entityType: 'EMAIL',
  recognize(text: string): PIIEntity[] {
    const pattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
    return matchAll(pattern, text, 'EMAIL', 0.98, 'regex');
  },
};

/** US/international phone numbers */
const PHONE_RECOGNIZER: PIIRecognizer = {
  name: 'phone-regex',
  entityType: 'PHONE',
  recognize(text: string): PIIEntity[] {
    const pattern =
      /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
    return matchAll(pattern, text, 'PHONE', 0.85, 'regex');
  },
};

/** IPv4 addresses */
const IP_ADDRESS_RECOGNIZER: PIIRecognizer = {
  name: 'ip-regex',
  entityType: 'IP_ADDRESS',
  recognize(text: string): PIIEntity[] {
    const pattern =
      /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g;
    return matchAll(pattern, text, 'IP_ADDRESS', 0.9, 'regex');
  },
};

/**
 * Simple name recognizer using common name patterns.
 * Not as accurate as a full NER model, but catches obvious patterns
 * like "Dr. John Smith" or "Mr. Jane Doe" without external deps.
 */
const PERSON_RECOGNIZER: PIIRecognizer = {
  name: 'person-heuristic',
  entityType: 'PERSON',
  recognize(text: string): PIIEntity[] {
    // Catches title + capitalized names: "Dr. John Smith", "Ms. Jane Doe"
    const titlePattern =
      /\b(?:Mr|Mrs|Ms|Miss|Dr|Prof|Rev|Sr|Jr)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g;
    return matchAll(titlePattern, text, 'PERSON', 0.75, 'ner');
  },
};

/** Date of birth patterns: MM/DD/YYYY, YYYY-MM-DD, etc. */
const DOB_RECOGNIZER: PIIRecognizer = {
  name: 'dob-regex',
  entityType: 'DATE_OF_BIRTH',
  recognize(text: string): PIIEntity[] {
    // Only match when preceded by context clues like "born", "DOB", "date of birth"
    const contextPattern =
      /(?:born|DOB|date of birth|birthday|d\.o\.b\.?)[:\s]+(\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4})/gi;
    return matchAll(contextPattern, text, 'DATE_OF_BIRTH', 0.85, 'regex');
  },
};

const BUILT_IN_RECOGNIZERS: PIIRecognizer[] = [
  SSN_RECOGNIZER,
  CREDIT_CARD_RECOGNIZER,
  EMAIL_RECOGNIZER,
  PHONE_RECOGNIZER,
  IP_ADDRESS_RECOGNIZER,
  PERSON_RECOGNIZER,
  DOB_RECOGNIZER,
];

// ── Utilities ───────────────────────────────────────────────────────

/** Extract all regex matches as PIIEntity objects */
function matchAll(
  pattern: RegExp,
  text: string,
  entityType: PIIEntityType,
  confidence: number,
  source: 'regex' | 'ner'
): PIIEntity[] {
  const entities: PIIEntity[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    // Use capture group 1 if present, otherwise full match
    const matchedText = match[1] ?? match[0];
    const start = match.index + (match[1] ? match[0].indexOf(match[1]) : 0);
    entities.push({
      type: entityType,
      text: matchedText,
      start,
      end: start + matchedText.length,
      confidence,
      source,
    });
  }

  return entities;
}

/** Luhn algorithm for credit card validation */
function luhnCheck(num: string): boolean {
  if (!/^\d+$/.test(num) || num.length < 13 || num.length > 19) return false;

  let sum = 0;
  let alternate = false;

  for (let i = num.length - 1; i >= 0; i--) {
    let n = parseInt(num[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }

  return sum % 10 === 0;
}

/** SHA-256 hash for the 'hash' redaction strategy */
function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/**
 * Merge overlapping entities, preferring higher-confidence detections.
 * When two entities overlap, keep the one with higher confidence.
 * When they're identical spans, deduplicate.
 */
function mergeEntities(entities: PIIEntity[]): PIIEntity[] {
  if (entities.length === 0) return [];

  // Sort by start position, then by confidence descending
  const sorted = [...entities].sort((a, b) =>
    a.start !== b.start ? a.start - b.start : b.confidence - a.confidence
  );

  const merged: PIIEntity[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];

    // Skip if fully contained within a higher-confidence entity
    if (current.start >= last.start && current.end <= last.end) {
      continue;
    }

    // If overlapping but not contained, keep the higher-confidence one
    if (current.start < last.end) {
      if (current.confidence > last.confidence) {
        merged[merged.length - 1] = current;
      }
      continue;
    }

    merged.push(current);
  }

  return merged;
}

// ── Core PII Detector ───────────────────────────────────────────────

export class PIIDetector {
  private config: Required<
    Omit<PIIDetectorConfig, 'customRecognizers' | 'entityTypes'>
  > & {
    customRecognizers: PIIRecognizer[];
    entityTypes: Set<PIIEntityType>;
  };

  private recognizers: PIIRecognizer[];

  constructor(config: PIIDetectorConfig = {}) {
    const entityTypes = new Set<PIIEntityType>(
      config.entityTypes ?? [
        'SSN',
        'CREDIT_CARD',
        'EMAIL',
        'PHONE',
        'IP_ADDRESS',
        'PERSON',
        'DATE_OF_BIRTH',
      ]
    );

    this.config = {
      confidenceThreshold: config.confidenceThreshold ?? 0.7,
      redactionStrategy: config.redactionStrategy ?? 'placeholder',
      customRecognizers: config.customRecognizers ?? [],
      allowList: config.allowList ?? [],
      reversible: config.reversible ?? true,
      entityTypes,
    };

    // Filter built-in recognizers to only enabled entity types,
    // then append custom recognizers
    this.recognizers = [
      ...BUILT_IN_RECOGNIZERS.filter((r) => entityTypes.has(r.entityType)),
      ...this.config.customRecognizers,
    ];
  }

  /** Run full detection + redaction pipeline */
  async detect(text: string): Promise<PIIDetectionResult> {
    const start = performance.now();

    // Run all recognizers and collect raw entities
    const rawEntities = this.runRecognizers(text);

    // Filter by confidence threshold
    const thresholded = rawEntities.filter(
      (e) => e.confidence >= this.config.confidenceThreshold
    );

    // Remove allow-listed terms
    const filtered = this.applyAllowList(thresholded);

    // Merge overlapping detections
    const entities = mergeEntities(filtered);

    // Apply redaction
    const { sanitizedText, reversalMap } = this.applyRedaction(text, entities);

    const detectionTimeMs = performance.now() - start;

    return {
      entities,
      sanitizedText,
      reversalMap,
      stats: {
        inputLength: text.length,
        entityCount: entities.length,
        detectionTimeMs,
        recognizersUsed: this.recognizers.map((r) => r.name),
      },
    };
  }

  /** Run detection only — returns entities without redacting */
  detectEntities(text: string): PIIEntity[] {
    const rawEntities = this.runRecognizers(text);
    const thresholded = rawEntities.filter(
      (e) => e.confidence >= this.config.confidenceThreshold
    );
    const filtered = this.applyAllowList(thresholded);
    return mergeEntities(filtered);
  }

  /** Apply redaction to text using provided entities */
  redact(text: string, entities: PIIEntity[], options?: RedactionOptions): RedactedResult {
    const strategy = options?.strategy ?? this.config.redactionStrategy;
    const reversible = options?.reversible ?? this.config.reversible;
    const maskChar = options?.maskChar ?? '*';

    const reversalMap = new Map<string, string>();
    const entityCountByType = new Map<string, number>();

    // Process entities from end to start so indices stay valid
    const sorted = [...entities].sort((a, b) => b.start - a.start);
    let result = text;

    for (const entity of sorted) {
      const count = (entityCountByType.get(entity.type) ?? 0) + 1;
      entityCountByType.set(entity.type, count);

      let replacement: string;

      switch (strategy) {
        case 'placeholder':
          replacement = `[${entity.type}_${count}]`;
          break;
        case 'mask':
          replacement = maskChar.repeat(entity.text.length);
          break;
        case 'hash':
          replacement = `[HASH:${sha256(entity.text)}]`;
          break;
        case 'redact':
          replacement = `[REDACTED]`;
          break;
        default:
          replacement = `[${entity.type}]`;
      }

      if (reversible) {
        reversalMap.set(replacement, entity.text);
      }

      result =
        result.slice(0, entity.start) + replacement + result.slice(entity.end);
    }

    return {
      sanitizedText: result,
      reversalMap,
      entityCount: entities.length,
    };
  }

  /**
   * Reverse redaction on an LLM response using the reversal map.
   * Swaps placeholders back to original values.
   */
  reverse(text: string, reversalMap: Map<string, string>): string {
    let result = text;
    for (const [placeholder, original] of reversalMap) {
      // Replace all occurrences of each placeholder
      result = result.split(placeholder).join(original);
    }
    return result;
  }

  // ── Private methods ─────────────────────────────────────────────

  private runRecognizers(text: string): PIIEntity[] {
    const allEntities: PIIEntity[] = [];

    for (const recognizer of this.recognizers) {
      const entities = recognizer.recognize(text);
      allEntities.push(...entities);
    }

    return allEntities;
  }

  private applyAllowList(entities: PIIEntity[]): PIIEntity[] {
    if (this.config.allowList.length === 0) return entities;

    const allowSet = new Set(
      this.config.allowList.map((term) => term.toLowerCase())
    );

    return entities.filter(
      (e) => !allowSet.has(e.text.toLowerCase())
    );
  }

  private applyRedaction(
    text: string,
    entities: PIIEntity[]
  ): { sanitizedText: string; reversalMap: Map<string, string> } {
    const { sanitizedText, reversalMap } = this.redact(text, entities, {
      strategy: this.config.redactionStrategy,
      reversible: this.config.reversible,
    });

    return { sanitizedText, reversalMap };
  }
}

/**
 * Convenience factory: creates a PIIDetector and runs detection in one call.
 */
export async function detectPII(
  text: string,
  config?: PIIDetectorConfig
): Promise<PIIDetectionResult> {
  const detector = new PIIDetector(config);
  return detector.detect(text);
}

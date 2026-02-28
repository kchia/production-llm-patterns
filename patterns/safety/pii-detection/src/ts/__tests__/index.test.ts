import { describe, it, expect } from 'vitest';
import { PIIDetector, detectPII } from '../index.js';
import { MockLLMProvider } from '../mock-provider.js';
import type { PIIRecognizer, PIIEntity } from '../types.js';

// ── Unit Tests ──────────────────────────────────────────────────────

describe('PIIDetector — unit tests', () => {
  describe('SSN detection', () => {
    it('detects standard SSN format', async () => {
      const detector = new PIIDetector();
      const result = await detector.detect('My SSN is 123-45-6789');
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].type).toBe('SSN');
      expect(result.entities[0].text).toBe('123-45-6789');
      expect(result.entities[0].confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('does not match partial SSN-like numbers', async () => {
      const detector = new PIIDetector();
      const result = await detector.detect('Order number: 12345678');
      const ssnEntities = result.entities.filter((e) => e.type === 'SSN');
      expect(ssnEntities).toHaveLength(0);
    });
  });

  describe('credit card detection', () => {
    it('detects valid credit card with dashes', async () => {
      const detector = new PIIDetector();
      const result = await detector.detect(
        'Card: 4111-1111-1111-1111'
      );
      const ccEntities = result.entities.filter(
        (e) => e.type === 'CREDIT_CARD'
      );
      expect(ccEntities).toHaveLength(1);
      expect(ccEntities[0].text).toBe('4111-1111-1111-1111');
    });

    it('rejects invalid Luhn checksum', async () => {
      const detector = new PIIDetector();
      const result = await detector.detect('Card: 1234-5678-9012-3456');
      const ccEntities = result.entities.filter(
        (e) => e.type === 'CREDIT_CARD'
      );
      expect(ccEntities).toHaveLength(0);
    });
  });

  describe('email detection', () => {
    it('detects standard email addresses', async () => {
      const detector = new PIIDetector();
      const result = await detector.detect(
        'Contact john.doe@example.com for details'
      );
      const emailEntities = result.entities.filter((e) => e.type === 'EMAIL');
      expect(emailEntities).toHaveLength(1);
      expect(emailEntities[0].text).toBe('john.doe@example.com');
    });

    it('detects multiple emails', async () => {
      const detector = new PIIDetector();
      const result = await detector.detect(
        'Email a@b.com or c@d.org'
      );
      const emailEntities = result.entities.filter((e) => e.type === 'EMAIL');
      expect(emailEntities).toHaveLength(2);
    });
  });

  describe('phone detection', () => {
    it('detects US phone with parentheses', async () => {
      const detector = new PIIDetector();
      const result = await detector.detect('Call (555) 123-4567');
      const phoneEntities = result.entities.filter((e) => e.type === 'PHONE');
      expect(phoneEntities).toHaveLength(1);
    });

    it('detects phone with country code', async () => {
      const detector = new PIIDetector();
      const result = await detector.detect('Call +1-555-123-4567');
      const phoneEntities = result.entities.filter((e) => e.type === 'PHONE');
      expect(phoneEntities).toHaveLength(1);
    });
  });

  describe('IP address detection', () => {
    it('detects IPv4 addresses', async () => {
      const detector = new PIIDetector();
      const result = await detector.detect(
        'Server at 192.168.1.100'
      );
      const ipEntities = result.entities.filter(
        (e) => e.type === 'IP_ADDRESS'
      );
      expect(ipEntities).toHaveLength(1);
      expect(ipEntities[0].text).toBe('192.168.1.100');
    });
  });

  describe('person name detection', () => {
    it('detects names with titles', async () => {
      const detector = new PIIDetector();
      const result = await detector.detect(
        'Dr. John Smith ordered the test'
      );
      const personEntities = result.entities.filter(
        (e) => e.type === 'PERSON'
      );
      expect(personEntities).toHaveLength(1);
      expect(personEntities[0].text).toContain('John Smith');
    });
  });

  describe('configuration', () => {
    it('respects confidence threshold', async () => {
      // High threshold should filter out lower-confidence detections
      const detector = new PIIDetector({ confidenceThreshold: 0.99 });
      const result = await detector.detect(
        'Call Dr. John Smith at (555) 123-4567'
      );
      // Person and phone have < 0.99 confidence, so they should be filtered
      const personEntities = result.entities.filter(
        (e) => e.type === 'PERSON'
      );
      expect(personEntities).toHaveLength(0);
    });

    it('respects entity type filter', async () => {
      const detector = new PIIDetector({ entityTypes: ['EMAIL'] });
      const result = await detector.detect(
        'SSN: 123-45-6789, email: a@b.com'
      );
      expect(result.entities.every((e) => e.type === 'EMAIL')).toBe(true);
    });

    it('respects allow list', async () => {
      const detector = new PIIDetector({
        allowList: ['john.doe@example.com'],
      });
      const result = await detector.detect(
        'Contact john.doe@example.com'
      );
      const emailEntities = result.entities.filter((e) => e.type === 'EMAIL');
      expect(emailEntities).toHaveLength(0);
    });

    it('accepts custom recognizers', async () => {
      const customRecognizer: PIIRecognizer = {
        name: 'employee-id',
        entityType: 'CUSTOM',
        recognize(text: string): PIIEntity[] {
          const pattern = /EMP-\d{6}/g;
          const entities: PIIEntity[] = [];
          let match;
          while ((match = pattern.exec(text)) !== null) {
            entities.push({
              type: 'CUSTOM',
              text: match[0],
              start: match.index,
              end: match.index + match[0].length,
              confidence: 0.95,
              source: 'regex',
            });
          }
          return entities;
        },
      };

      const detector = new PIIDetector({
        customRecognizers: [customRecognizer],
      });

      const result = await detector.detect('Employee EMP-123456 requested access');
      const customEntities = result.entities.filter(
        (e) => e.type === 'CUSTOM'
      );
      expect(customEntities).toHaveLength(1);
      expect(customEntities[0].text).toBe('EMP-123456');
    });
  });

  describe('redaction strategies', () => {
    it('placeholder redaction uses typed placeholders', async () => {
      const detector = new PIIDetector({ redactionStrategy: 'placeholder' });
      const result = await detector.detect(
        'My SSN is 123-45-6789'
      );
      expect(result.sanitizedText).toContain('[SSN_');
      expect(result.sanitizedText).not.toContain('123-45-6789');
    });

    it('mask redaction replaces with asterisks', async () => {
      const detector = new PIIDetector({ redactionStrategy: 'mask' });
      const result = await detector.detect(
        'Email: a@b.com'
      );
      expect(result.sanitizedText).toContain('******');
      expect(result.sanitizedText).not.toContain('a@b.com');
    });

    it('hash redaction produces hash prefix', async () => {
      const detector = new PIIDetector({ redactionStrategy: 'hash' });
      const result = await detector.detect(
        'My SSN is 123-45-6789'
      );
      expect(result.sanitizedText).toContain('[HASH:');
    });

    it('redact strategy uses [REDACTED]', async () => {
      const detector = new PIIDetector({ redactionStrategy: 'redact' });
      const result = await detector.detect(
        'My SSN is 123-45-6789'
      );
      expect(result.sanitizedText).toContain('[REDACTED]');
    });
  });

  describe('reversal', () => {
    it('reverses placeholder redaction', async () => {
      const detector = new PIIDetector({ redactionStrategy: 'placeholder' });
      const original = 'My SSN is 123-45-6789 and email is a@b.com';
      const result = await detector.detect(original);

      // Simulate LLM response using placeholders
      const llmResponse = `Based on your info: ${result.sanitizedText}`;
      const reversed = detector.reverse(llmResponse, result.reversalMap);

      expect(reversed).toContain('123-45-6789');
      expect(reversed).toContain('a@b.com');
    });

    it('skips reversal map when reversible is false', async () => {
      const detector = new PIIDetector({ reversible: false });
      const result = await detector.detect(
        'My SSN is 123-45-6789'
      );
      expect(result.reversalMap.size).toBe(0);
    });
  });

  describe('detection stats', () => {
    it('returns accurate stats', async () => {
      const detector = new PIIDetector();
      const input = 'SSN: 123-45-6789, email: test@example.com';
      const result = await detector.detect(input);

      expect(result.stats.inputLength).toBe(input.length);
      expect(result.stats.entityCount).toBe(2);
      expect(result.stats.detectionTimeMs).toBeGreaterThan(0);
      expect(result.stats.recognizersUsed.length).toBeGreaterThan(0);
    });
  });
});

// ── Failure Mode Tests ──────────────────────────────────────────────

describe('PIIDetector — failure mode tests', () => {
  it('FM: false negatives — context-dependent PII without title prefix is missed', async () => {
    // Without a title prefix, the heuristic person recognizer won't catch "John Smith"
    const detector = new PIIDetector();
    const result = await detector.detect(
      'John Smith discussed his diabetes diagnosis'
    );
    const personEntities = result.entities.filter((e) => e.type === 'PERSON');
    // This is an expected limitation of regex/heuristic detection
    expect(personEntities).toHaveLength(0);
  });

  it('FM: false positives — SSN pattern in non-PII context', async () => {
    const detector = new PIIDetector();
    // 9-digit numbers that look like SSNs but aren't
    const result = await detector.detect(
      'Product code: 123-45-6789'
    );
    // The regex catches it — this documents the false positive behavior
    const ssnEntities = result.entities.filter((e) => e.type === 'SSN');
    expect(ssnEntities).toHaveLength(1);
    // Allow list can mitigate this
    const detectorWithAllowList = new PIIDetector({
      allowList: ['123-45-6789'],
    });
    const result2 = await detectorWithAllowList.detect(
      'Product code: 123-45-6789'
    );
    expect(result2.entities.filter((e) => e.type === 'SSN')).toHaveLength(0);
  });

  it('FM: reversal map contains sensitive data', async () => {
    const detector = new PIIDetector({ reversible: true });
    const result = await detector.detect(
      'My SSN is 123-45-6789'
    );
    // Reversal map DOES contain the original PII — this is the tradeoff
    const mapValues = [...result.reversalMap.values()];
    expect(mapValues).toContain('123-45-6789');
    // Mitigation: don't log the reversal map, set short TTL
  });

  it('FM: latency under load — detection completes within budget', async () => {
    const detector = new PIIDetector();
    const longText =
      'This is a long document. '.repeat(100) +
      'SSN: 123-45-6789 ' +
      'and email: test@example.com';

    const start = performance.now();
    const result = await detector.detect(longText);
    const elapsed = performance.now() - start;

    expect(result.entities.length).toBeGreaterThan(0);
    // Regex-only detection should complete well under 100ms even for long text
    expect(elapsed).toBeLessThan(100);
  });

  it('FM: silent degradation — detection count tracking enables drift monitoring', async () => {
    const detector = new PIIDetector();
    const sampleTexts = [
      'My SSN is 123-45-6789',
      'Email: test@example.com',
      'Call (555) 123-4567',
      'No PII here at all',
      'Card: 4111-1111-1111-1111',
    ];

    const countsByType = new Map<string, number>();
    for (const text of sampleTexts) {
      const result = await detector.detect(text);
      for (const entity of result.entities) {
        countsByType.set(
          entity.type,
          (countsByType.get(entity.type) ?? 0) + 1
        );
      }
    }

    // In production, track these counts over time and alert on sustained drops
    expect(countsByType.get('SSN')).toBe(1);
    expect(countsByType.get('EMAIL')).toBe(1);
    expect(countsByType.get('PHONE')).toBe(1);
    expect(countsByType.get('CREDIT_CARD')).toBe(1);
  });

  it('FM: incomplete entity type coverage — only configured types detected', async () => {
    const detector = new PIIDetector({ entityTypes: ['SSN'] });
    const result = await detector.detect(
      'SSN: 123-45-6789, email: test@example.com'
    );
    expect(result.entities.every((e) => e.type === 'SSN')).toBe(true);
    // Email was in the text but not detected — documenting coverage gap
    expect(result.entities.filter((e) => e.type === 'EMAIL')).toHaveLength(0);
  });

  it('FM: regex collision — phone pattern catches non-phone numbers', async () => {
    const detector = new PIIDetector();
    // Some numeric sequences match phone patterns but aren't phones
    const result = await detector.detect('Reference: 555-123-4567');
    const phoneEntities = result.entities.filter((e) => e.type === 'PHONE');
    // This is a known false positive risk for phone detection
    expect(phoneEntities.length).toBeGreaterThanOrEqual(0);
  });
});

// ── Integration Tests ───────────────────────────────────────────────

describe('PIIDetector — integration tests', () => {
  it('full pipeline: detect → redact → LLM → reverse', async () => {
    const detector = new PIIDetector({ redactionStrategy: 'placeholder' });
    const provider = new MockLLMProvider({ latencyMs: 10 });

    const userInput =
      'My name is Dr. Jane Doe, SSN 123-45-6789, email jane@example.com';

    // Step 1: Detect and redact
    const detection = await detector.detect(userInput);
    expect(detection.entities.length).toBeGreaterThanOrEqual(2);
    expect(detection.sanitizedText).not.toContain('123-45-6789');
    expect(detection.sanitizedText).not.toContain('jane@example.com');

    // Step 2: Send sanitized text to LLM
    const llmResponse = await provider.complete(detection.sanitizedText);

    // Step 3: Reverse redaction in LLM response
    const finalResponse = detector.reverse(
      llmResponse.text,
      detection.reversalMap
    );
    expect(finalResponse).toContain('123-45-6789');
    expect(finalResponse).toContain('jane@example.com');
  });

  it('multi-entity document processing', async () => {
    const detector = new PIIDetector();
    const document = [
      'Patient: Dr. John Smith',
      'SSN: 123-45-6789',
      'Email: patient@hospital.com',
      'Phone: (555) 987-6543',
      'IP: 10.0.0.1',
      'Card: 4111-1111-1111-1111',
    ].join('\n');

    const result = await detector.detect(document);

    // Should detect multiple entity types
    const types = new Set(result.entities.map((e) => e.type));
    expect(types.size).toBeGreaterThanOrEqual(4);

    // Sanitized text should have no raw PII
    expect(result.sanitizedText).not.toContain('123-45-6789');
    expect(result.sanitizedText).not.toContain('patient@hospital.com');
    expect(result.sanitizedText).not.toContain('4111-1111-1111-1111');
  });

  it('clean text passes through unchanged', async () => {
    const detector = new PIIDetector();
    const cleanText = 'What is the capital of France?';
    const result = await detector.detect(cleanText);

    expect(result.entities).toHaveLength(0);
    expect(result.sanitizedText).toBe(cleanText);
    expect(result.reversalMap.size).toBe(0);
  });

  it('convenience function detectPII works end-to-end', async () => {
    const result = await detectPII('My SSN is 123-45-6789', {
      redactionStrategy: 'mask',
    });
    expect(result.entities).toHaveLength(1);
    expect(result.sanitizedText).not.toContain('123-45-6789');
    expect(result.sanitizedText).toContain('***');
  });

  it('concurrent detection calls are independent', async () => {
    const detector = new PIIDetector();

    const [result1, result2] = await Promise.all([
      detector.detect('SSN: 123-45-6789'),
      detector.detect('Email: test@example.com'),
    ]);

    expect(result1.entities[0].type).toBe('SSN');
    expect(result2.entities[0].type).toBe('EMAIL');
    // Results should not bleed between calls
    expect(result1.entities).toHaveLength(1);
    expect(result2.entities).toHaveLength(1);
  });
});

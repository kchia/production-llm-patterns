/**
 * PII Detection — Type definitions
 *
 * Defines entity types, detection results, redaction strategies,
 * and configuration interfaces for the PII detection pipeline.
 */

/** Supported PII entity categories */
export type PIIEntityType =
  | 'SSN'
  | 'CREDIT_CARD'
  | 'EMAIL'
  | 'PHONE'
  | 'IP_ADDRESS'
  | 'PERSON'
  | 'ORGANIZATION'
  | 'LOCATION'
  | 'DATE_OF_BIRTH'
  | 'MEDICAL'
  | 'CUSTOM';

/** How detected PII gets replaced in the output text */
export type RedactionStrategy = 'placeholder' | 'mask' | 'hash' | 'redact';

/** A single PII entity detected in text */
export interface PIIEntity {
  type: PIIEntityType;
  text: string;
  start: number;
  end: number;
  confidence: number;
  source: 'regex' | 'ner';
}

/** Result from running detection on a text input */
export interface PIIDetectionResult {
  entities: PIIEntity[];
  sanitizedText: string;
  reversalMap: Map<string, string>;
  stats: DetectionStats;
}

/** Performance and detection statistics */
export interface DetectionStats {
  inputLength: number;
  entityCount: number;
  detectionTimeMs: number;
  recognizersUsed: string[];
}

/** Options for the redaction step */
export interface RedactionOptions {
  strategy?: RedactionStrategy;
  /** If true, generate a reversal map for de-redaction */
  reversible?: boolean;
  /** Custom mask character (for 'mask' strategy) */
  maskChar?: string;
}

/** A recognizer matches PII in text — regex or NER-based */
export interface PIIRecognizer {
  name: string;
  entityType: PIIEntityType;
  /** Detect entities in text, returning raw matches */
  recognize(text: string): PIIEntity[];
}

/** Full configuration for the PII detector */
export interface PIIDetectorConfig {
  /** Minimum confidence to treat detection as real PII (0–1) */
  confidenceThreshold?: number;
  /** Which entity types to detect. Defaults to all built-in types */
  entityTypes?: PIIEntityType[];
  /** How to replace detected PII */
  redactionStrategy?: RedactionStrategy;
  /** User-defined recognizers for domain-specific PII */
  customRecognizers?: PIIRecognizer[];
  /** Terms that look like PII but aren't — skip these */
  allowList?: string[];
  /** Whether to produce a reversal map */
  reversible?: boolean;
}

/** Result of applying redaction to detected entities */
export interface RedactedResult {
  sanitizedText: string;
  reversalMap: Map<string, string>;
  entityCount: number;
}

/** Configuration for the mock LLM provider */
export interface MockProviderConfig {
  /** Simulated latency in ms */
  latencyMs?: number;
  /** Simulated output token count */
  outputTokens?: number;
  /** If set, provider throws this error */
  errorToThrow?: Error;
  /** Fixed response text (if not set, echoes input) */
  responseText?: string;
}

/** A mock LLM call result */
export interface MockLLMResponse {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  latencyMs: number;
}

/**
 * Structured Output Validation — Type Definitions
 *
 * Core types for the parse → repair → validate → retry pipeline.
 * Framework-agnostic, no external dependencies.
 */

/** A request to an LLM provider. */
export interface LLMRequest {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  metadata?: Record<string, unknown>;
}

/** A response from an LLM provider. */
export interface LLMResponse {
  content: string;
  tokensUsed?: number;
  model?: string;
  finishReason?: string;
}

/** An LLM provider callable — any function matching this signature works. */
export type LLMProvider = (request: LLMRequest) => Promise<LLMResponse>;

/**
 * Schema definition that the validator uses to parse and validate output.
 *
 * Implementations provide their own parsing logic — Zod, Pydantic, or
 * hand-written validators all work as long as they implement this interface.
 */
export interface OutputSchema<T> {
  /** Parse and validate raw string. Throws SchemaValidationError on failure. */
  parse(raw: string): T;

  /** JSON Schema representation for including in prompts. */
  toJsonSchema(): Record<string, unknown>;

  /** Human-readable schema description for prompt instructions. */
  toPromptInstructions(): string;
}

/** Configuration for the OutputValidator. */
export interface ValidatorConfig {
  /** Maximum retry attempts after initial call. Default: 2 (so 3 total attempts). */
  maxRetries?: number;

  /** Whether to attempt JSON repair before retrying. Default: true. */
  repair?: boolean;

  /** Whether to strip markdown code fences before parsing. Default: true. */
  stripMarkdown?: boolean;

  /** Whether to append JSON schema instructions to the prompt. Default: true. */
  includeSchemaInPrompt?: boolean;

  /**
   * How to format validation errors for model retry.
   * 'structured' = JSON list of errors; 'natural' = prose description.
   * Default: 'structured'.
   */
  errorFeedbackFormat?: 'structured' | 'natural';

  /** Callback fired before each retry attempt. */
  onRetry?: (errors: string[], attempt: number) => void;

  /** Callback fired when all attempts are exhausted. */
  onValidationFailure?: (result: ValidationResult<unknown>) => void;
}

/** How the output was successfully parsed. */
export type ParseMethod = 'direct' | 'repaired' | 'retry';

/** The result of a validation attempt. */
export interface ValidationResult<T> {
  /** Whether validation succeeded. */
  success: boolean;

  /** The typed, validated data — present only when success is true. */
  data?: T;

  /** The raw LLM output string from the final attempt. */
  raw: string;

  /** How many retry attempts were made (0 = first attempt succeeded). */
  retries: number;

  /** Whether JSON repair was applied to get a valid result. */
  repaired: boolean;

  /** Validation errors from the final attempt (present when success is false). */
  validationErrors?: string[];

  /** How the output was successfully parsed. */
  parseMethod: ParseMethod;

  /** Total wall-clock time for all attempts in milliseconds. */
  totalLatencyMs: number;
}

/** Error thrown when schema validation fails. */
export class SchemaValidationError extends Error {
  public readonly errors: string[];

  constructor(errors: string[]) {
    const summary = errors.length === 1
      ? errors[0]
      : `${errors.length} validation errors: ${errors.join('; ')}`;
    super(summary);
    this.name = 'SchemaValidationError';
    this.errors = errors;
  }
}

/** Error thrown when all validation attempts are exhausted. */
export class ValidationExhaustedError extends Error {
  public readonly result: ValidationResult<unknown>;

  constructor(result: ValidationResult<unknown>) {
    const errorSummary = result.validationErrors?.join('; ') ?? 'unknown error';
    super(
      `All ${result.retries + 1} validation attempts exhausted. Last errors: ${errorSummary}`
    );
    this.name = 'ValidationExhaustedError';
    this.result = result;
  }
}

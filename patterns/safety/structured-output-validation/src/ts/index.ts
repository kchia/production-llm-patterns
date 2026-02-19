/**
 * Structured Output Validation — Core Implementation
 *
 * Parse → Repair → Validate → Retry pipeline for LLM structured output.
 * Framework-agnostic. No provider-specific imports.
 *
 * The validator wraps any LLM provider call and ensures the output conforms
 * to a schema. On failure, it attempts JSON repair (sub-millisecond), then
 * falls back to retry with error feedback (full round-trip).
 */

import type {
  LLMProvider,
  LLMRequest,
  OutputSchema,
  ValidatorConfig,
  ValidationResult,
  ParseMethod,
} from './types.js';
import { SchemaValidationError, ValidationExhaustedError } from './types.js';

// ─── JSON Repair ─────────────────────────────────────────────────────────────

/**
 * Strip markdown code fences from LLM output.
 * Models commonly wrap JSON in ```json ... ``` blocks.
 */
export function stripMarkdownFences(raw: string): string {
  const trimmed = raw.trim();
  // Match ```json ... ``` or ``` ... ```
  const fencePattern = /^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```$/;
  const match = trimmed.match(fencePattern);
  return match ? match[1].trim() : trimmed;
}

/**
 * Extract JSON from text that contains prose around it.
 * Finds the first complete JSON object or array in the string.
 */
export function extractJson(raw: string): string {
  const trimmed = raw.trim();

  // Already starts with { or [ — try as-is
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return trimmed;
  }

  // Find first { or [ and extract to the matching closing bracket
  const objectStart = trimmed.indexOf('{');
  const arrayStart = trimmed.indexOf('[');

  let start: number;
  let open: string;
  let close: string;

  if (objectStart === -1 && arrayStart === -1) return trimmed;
  if (objectStart === -1) { start = arrayStart; open = '['; close = ']'; }
  else if (arrayStart === -1) { start = objectStart; open = '{'; close = '}'; }
  else if (objectStart < arrayStart) { start = objectStart; open = '{'; close = '}'; }
  else { start = arrayStart; open = '['; close = ']'; }

  // Walk forward tracking brace depth, respecting strings
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (escape) { escape = false; continue; }
    if (char === '\\' && inString) { escape = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (char === open) depth++;
    if (char === close) {
      depth--;
      if (depth === 0) {
        return trimmed.slice(start, i + 1);
      }
    }
  }

  // Unbalanced — return from start to end (repair may fix it)
  return trimmed.slice(start);
}

/**
 * Attempt lightweight JSON repair for common LLM output issues.
 * Handles: trailing commas, missing closing braces/brackets, unbalanced nesting.
 */
export function repairJson(raw: string): string {
  let text = raw.trim();

  // Remove trailing commas before } or ]
  text = text.replace(/,\s*([\]}])/g, '$1');

  // Remove trailing comma at end of string (before we append closers)
  text = text.replace(/,\s*$/, '');

  // Track the order of unmatched openers so we close them in reverse order
  const openStack: string[] = [];
  let inString = false;
  let escape = false;

  for (const char of text) {
    if (escape) { escape = false; continue; }
    if (char === '\\' && inString) { escape = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (char === '{' || char === '[') {
      openStack.push(char);
    } else if (char === '}') {
      if (openStack.length > 0 && openStack[openStack.length - 1] === '{') {
        openStack.pop();
      }
    } else if (char === ']') {
      if (openStack.length > 0 && openStack[openStack.length - 1] === '[') {
        openStack.pop();
      }
    }
  }

  // Close unmatched openers in reverse order
  while (openStack.length > 0) {
    const opener = openStack.pop()!;
    text += opener === '{' ? '}' : ']';
  }

  return text;
}

// ─── Error Feedback Formatting ───────────────────────────────────────────────

/** Format validation errors for feeding back to the model on retry. */
function formatErrorFeedback(
  errors: string[],
  format: 'structured' | 'natural'
): string {
  if (format === 'structured') {
    return [
      'Your previous response had validation errors:',
      JSON.stringify(errors, null, 2),
      'Please fix these errors and return valid JSON matching the schema.',
    ].join('\n');
  }

  // Natural prose format
  const errorList = errors.map((e, i) => `${i + 1}. ${e}`).join('\n');
  return [
    'Your previous response didn\'t match the expected format.',
    errorList,
    'Please try again with valid JSON matching the schema.',
  ].join('\n');
}

// ─── Output Validator ────────────────────────────────────────────────────────

/**
 * OutputValidator — the core abstraction.
 *
 * Wraps an LLM provider call in a parse → repair → validate → retry loop.
 * Schema defines what valid output looks like. Every result carries metadata
 * about how it was obtained (direct parse, repair, or retry).
 */
export class OutputValidator<T> {
  private schema: OutputSchema<T>;
  private config: Required<ValidatorConfig>;

  constructor(schema: OutputSchema<T>, config: ValidatorConfig = {}) {
    this.schema = schema;
    this.config = {
      maxRetries: config.maxRetries ?? 2,
      repair: config.repair ?? true,
      stripMarkdown: config.stripMarkdown ?? true,
      includeSchemaInPrompt: config.includeSchemaInPrompt ?? true,
      errorFeedbackFormat: config.errorFeedbackFormat ?? 'structured',
      onRetry: config.onRetry ?? (() => {}),
      onValidationFailure: config.onValidationFailure ?? (() => {}),
    };
  }

  /**
   * Call the LLM provider and validate the output against the schema.
   *
   * Attempts: parse → repair (if enabled) → retry with error feedback.
   * Returns a ValidationResult with metadata about the process.
   * Throws ValidationExhaustedError if all attempts fail.
   */
  async execute(
    provider: LLMProvider,
    request: LLMRequest
  ): Promise<ValidationResult<T>> {
    const startTime = performance.now();

    // Augment prompt with schema instructions if configured
    const augmentedRequest = this.config.includeSchemaInPrompt
      ? this.augmentRequest(request)
      : request;

    let lastErrors: string[] = [];
    let lastRaw = '';
    let currentRequest = augmentedRequest;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      const isRetry = attempt > 0;

      if (isRetry) {
        this.config.onRetry(lastErrors, attempt);
        // Augment the request with error feedback for the retry
        currentRequest = this.augmentWithFeedback(augmentedRequest, lastErrors, lastRaw);
      }

      // Call the LLM provider
      const response = await provider(currentRequest);
      lastRaw = response.content;

      // Step 1: Pre-process (strip markdown, extract JSON)
      let processed = lastRaw;
      if (this.config.stripMarkdown) {
        processed = stripMarkdownFences(processed);
      }
      processed = extractJson(processed);

      // Step 2: Try direct parse + validate
      try {
        const data = this.schema.parse(processed);
        return {
          success: true,
          data,
          raw: lastRaw,
          retries: attempt,
          repaired: false,
          parseMethod: isRetry ? 'retry' : 'direct',
          totalLatencyMs: performance.now() - startTime,
        };
      } catch (err) {
        // Direct parse failed — try repair if enabled
        if (this.config.repair) {
          const repaired = repairJson(processed);
          if (repaired !== processed) {
            try {
              const data = this.schema.parse(repaired);
              return {
                success: true,
                data,
                raw: lastRaw,
                retries: attempt,
                repaired: true,
                parseMethod: 'repaired',
                totalLatencyMs: performance.now() - startTime,
              };
            } catch {
              // Repair didn't help — fall through to retry
            }
          }
        }

        // Collect errors for next retry attempt
        lastErrors = err instanceof SchemaValidationError
          ? err.errors
          : [err instanceof Error ? err.message : String(err)];
      }
    }

    // All attempts exhausted
    const result: ValidationResult<T> = {
      success: false,
      raw: lastRaw,
      retries: this.config.maxRetries,
      repaired: false,
      validationErrors: lastErrors,
      parseMethod: 'retry',
      totalLatencyMs: performance.now() - startTime,
    };

    this.config.onValidationFailure(result);
    throw new ValidationExhaustedError(result);
  }

  /** Append schema instructions to the prompt. */
  private augmentRequest(request: LLMRequest): LLMRequest {
    const schemaInstructions = this.schema.toPromptInstructions();
    return {
      ...request,
      prompt: `${request.prompt}\n\n${schemaInstructions}`,
    };
  }

  /** Add error feedback context for retry attempts. */
  private augmentWithFeedback(
    baseRequest: LLMRequest,
    errors: string[],
    previousOutput: string
  ): LLMRequest {
    const feedback = formatErrorFeedback(errors, this.config.errorFeedbackFormat);
    return {
      ...baseRequest,
      prompt: `${baseRequest.prompt}\n\n---\nPrevious output:\n${previousOutput}\n\n${feedback}`,
    };
  }
}

// ─── Built-in Schema Helpers ─────────────────────────────────────────────────

/**
 * JsonObjectSchema — a simple schema that validates JSON objects against
 * a field definition. No external dependencies (no Zod, no Pydantic).
 *
 * For production use, wrapping Zod or another validation library in the
 * OutputSchema interface is recommended. This built-in handles common cases
 * without adding a dependency.
 */
export interface FieldDef {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  description?: string;
  enum?: unknown[];
}

export class JsonObjectSchema<T extends Record<string, unknown>> implements OutputSchema<T> {
  private fields: Record<string, FieldDef>;
  private schemaName: string;

  constructor(schemaName: string, fields: Record<string, FieldDef>) {
    this.schemaName = schemaName;
    this.fields = fields;
  }

  parse(raw: string): T {
    // Step 1: Parse as JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SchemaValidationError([
        `Invalid JSON: ${raw.length > 100 ? raw.slice(0, 100) + '...' : raw}`,
      ]);
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new SchemaValidationError(['Expected a JSON object, got ' + typeof parsed]);
    }

    const obj = parsed as Record<string, unknown>;
    const errors: string[] = [];

    // Step 2: Validate required fields and types
    for (const [field, def] of Object.entries(this.fields)) {
      const value = obj[field];

      if (value === undefined || value === null) {
        if (def.required !== false) {
          errors.push(`Missing required field: "${field}"`);
        }
        continue;
      }

      // Type check
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (actualType !== def.type) {
        errors.push(
          `Field "${field}" expected type "${def.type}", got "${actualType}" (value: ${JSON.stringify(value)})`
        );
      }

      // Enum check
      if (def.enum && !def.enum.includes(value)) {
        errors.push(
          `Field "${field}" value ${JSON.stringify(value)} not in allowed values: ${JSON.stringify(def.enum)}`
        );
      }
    }

    if (errors.length > 0) {
      throw new SchemaValidationError(errors);
    }

    return obj as T;
  }

  toJsonSchema(): Record<string, unknown> {
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];

    for (const [field, def] of Object.entries(this.fields)) {
      const prop: Record<string, unknown> = { type: def.type };
      if (def.description) prop.description = def.description;
      if (def.enum) prop.enum = def.enum;
      properties[field] = prop;

      if (def.required !== false) {
        required.push(field);
      }
    }

    return {
      type: 'object',
      properties,
      required,
    };
  }

  toPromptInstructions(): string {
    const fieldDescriptions = Object.entries(this.fields)
      .map(([field, def]) => {
        let desc = `- "${field}" (${def.type}${def.required === false ? ', optional' : ', required'})`;
        if (def.description) desc += `: ${def.description}`;
        if (def.enum) desc += `. Allowed values: ${def.enum.map(v => JSON.stringify(v)).join(', ')}`;
        return desc;
      })
      .join('\n');

    return [
      `Respond with a JSON object matching the "${this.schemaName}" schema:`,
      fieldDescriptions,
      '',
      'Return ONLY the JSON object. No markdown, no explanation, no additional text.',
    ].join('\n');
  }
}

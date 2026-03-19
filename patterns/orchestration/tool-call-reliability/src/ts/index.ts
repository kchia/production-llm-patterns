// Tool Call Reliability — core implementation.
//
// Validates LLM tool calls for:
//   1. Allowlist membership (no hallucinated tool names)
//   2. Schema compliance (correct types, required fields present)
//   3. Self-repair (sends structured error feedback back to the LLM for correction)

import type {
  LLMProvider,
  Message,
  OnRepairFailure,
  RawToolCall,
  RepairFeedbackMode,
  SchemaStrictness,
  ToolCallResult,
  ToolSchema,
  ValidatorConfig,
  ValidationError,
} from './types.js';

export type {
  LLMProvider,
  Message,
  OnRepairFailure,
  RawToolCall,
  RepairFeedbackMode,
  SchemaStrictness,
  ToolCallResult,
  ToolSchema,
  ValidatorConfig,
  ValidationError,
} from './types.js';

const DEFAULT_CONFIG: ValidatorConfig = {
  maxRepairAttempts: 2,
  strictAllowlist: true,
  schemaStrictness: 'required-only',
  repairFeedbackMode: 'structured',
  onRepairFailure: 'throw',
};

export class ToolCallValidator {
  private config: ValidatorConfig;
  private provider: LLMProvider;

  constructor(provider: LLMProvider, config: Partial<ValidatorConfig> = {}) {
    this.provider = provider;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Validate a raw tool call against the provided tool schemas.
   * If invalid, attempt repair up to maxRepairAttempts times.
   *
   * @param toolCall - The raw tool call from the LLM response
   * @param tools - The tool schemas that were provided to the LLM
   * @param messages - The conversation history (needed for repair context)
   */
  async validate(
    toolCall: RawToolCall,
    tools: ToolSchema[],
    messages: Message[],
  ): Promise<ToolCallResult> {
    // Step 1: parse the arguments (may be a JSON string)
    const { parsed, parseError } = this.parseArguments(toolCall.arguments);

    if (parseError) {
      return this.handleValidationFailure(
        toolCall,
        tools,
        messages,
        [{ field: 'arguments', expected: 'valid JSON', received: String(toolCall.arguments), message: parseError }],
        0,
      );
    }

    // Step 2: allowlist check — reject hallucinated tool names
    if (this.config.strictAllowlist) {
      const allowlistError = this.checkAllowlist(toolCall.name, tools);
      if (allowlistError) {
        // Allowlist failures are not repairable — the model called a nonexistent tool.
        // Return error immediately without repair loop to avoid burning retry budget.
        return {
          valid: false,
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          arguments: parsed ?? {},
          errors: [allowlistError],
          repairAttempts: 0,
        };
      }
    }

    // Step 3: schema validation
    const schema = tools.find((t) => t.name === toolCall.name);
    if (!schema) {
      // Should only happen when strictAllowlist is false
      return {
        valid: true,
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        arguments: parsed ?? {},
        repairAttempts: 0,
      };
    }

    const schemaErrors = this.validateSchema(parsed!, schema);
    if (schemaErrors.length === 0) {
      return {
        valid: true,
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        arguments: parsed!,
        repairAttempts: 0,
      };
    }

    return this.handleValidationFailure(toolCall, tools, messages, schemaErrors, 0);
  }

  /**
   * Attempt to repair a tool call by sending error context back to the LLM.
   * Called recursively up to maxRepairAttempts.
   */
  private async handleValidationFailure(
    toolCall: RawToolCall,
    tools: ToolSchema[],
    messages: Message[],
    errors: ValidationError[],
    attempt: number,
  ): Promise<ToolCallResult> {
    if (attempt >= this.config.maxRepairAttempts) {
      return this.applyRepairFailurePolicy(toolCall, errors, attempt);
    }

    // Build repair prompt with structured error feedback
    const repairMessages = this.buildRepairMessages(messages, toolCall, errors);

    let response: Message;
    try {
      response = await this.provider.chat(repairMessages, tools);
    } catch (err) {
      return this.applyRepairFailurePolicy(toolCall, errors, attempt);
    }

    const repairedCall = response.tool_calls?.[0];
    if (!repairedCall) {
      // Model responded with text instead of a tool call — repair failed
      return this.applyRepairFailurePolicy(toolCall, errors, attempt + 1);
    }

    // Re-validate the repaired call
    const { parsed, parseError } = this.parseArguments(repairedCall.arguments);
    if (parseError) {
      return this.handleValidationFailure(
        repairedCall,
        tools,
        repairMessages,
        [{ field: 'arguments', expected: 'valid JSON', received: String(repairedCall.arguments), message: parseError }],
        attempt + 1,
      );
    }

    const schema = tools.find((t) => t.name === repairedCall.name);
    if (!schema) {
      return this.applyRepairFailurePolicy(repairedCall, errors, attempt + 1);
    }

    const schemaErrors = this.validateSchema(parsed!, schema);
    if (schemaErrors.length === 0) {
      return {
        valid: true,
        toolName: repairedCall.name,
        toolCallId: repairedCall.id,
        arguments: parsed!,
        repairAttempts: attempt + 1,
      };
    }

    return this.handleValidationFailure(repairedCall, tools, repairMessages, schemaErrors, attempt + 1);
  }

  private parseArguments(
    args: string | Record<string, unknown>,
  ): { parsed: Record<string, unknown> | null; parseError: string | null } {
    if (typeof args === 'object' && args !== null) {
      return { parsed: args, parseError: null };
    }
    try {
      const parsed = JSON.parse(args as string);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { parsed: null, parseError: `Expected JSON object, got ${typeof parsed}` };
      }
      return { parsed: parsed as Record<string, unknown>, parseError: null };
    } catch (e) {
      return { parsed: null, parseError: `JSON parse failed: ${(e as Error).message}` };
    }
  }

  private checkAllowlist(toolName: string, tools: ToolSchema[]): ValidationError | null {
    const allowed = new Set(tools.map((t) => t.name));
    if (!allowed.has(toolName)) {
      return {
        field: 'name',
        expected: `one of: ${[...allowed].join(', ')}`,
        received: toolName,
        message: `Tool '${toolName}' is not in the provided tool schema. This call will not be executed.`,
      };
    }
    return null;
  }

  private validateSchema(
    args: Record<string, unknown>,
    schema: ToolSchema,
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    const { properties, required } = schema.parameters;
    const fieldsToCheck = this.config.schemaStrictness === 'all'
      ? Object.keys(properties)
      : (required ?? []);

    // Check required fields are present
    for (const field of (required ?? [])) {
      if (!(field in args)) {
        errors.push({
          field,
          expected: 'present',
          received: 'missing',
          message: `Required field '${field}' is missing`,
        });
      }
    }

    // Type-check the fields in scope
    for (const field of fieldsToCheck) {
      if (!(field in args)) continue;  // missing required fields are caught above

      const propSchema = properties[field];
      if (!propSchema) continue;

      const typeError = this.checkType(field, args[field], propSchema);
      if (typeError) errors.push(typeError);
    }

    return errors;
  }

  private checkType(
    field: string,
    value: unknown,
    schema: import('./types.js').JSONSchemaProperty,
  ): ValidationError | null {
    const jsType = typeof value;

    // Enum check takes precedence over type check
    if (schema.enum !== undefined && !schema.enum.includes(value)) {
      return {
        field,
        expected: `one of: ${JSON.stringify(schema.enum)}`,
        received: JSON.stringify(value),
        message: `Field '${field}' must be one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`,
      };
    }

    switch (schema.type) {
      case 'string':
        if (jsType !== 'string') {
          return {
            field,
            expected: 'string',
            received: jsType,
            message: `Field '${field}' expected string, got ${jsType}`,
          };
        }
        break;
      case 'number':
        if (jsType !== 'number') {
          return {
            field,
            expected: 'number',
            received: jsType,
            message: `Field '${field}' expected number, got ${jsType}`,
          };
        }
        break;
      case 'integer':
        if (jsType !== 'number' || !Number.isInteger(value)) {
          return {
            field,
            expected: 'integer',
            received: Number.isInteger(value) ? 'number (non-integer)' : jsType,
            message: `Field '${field}' expected integer, got ${jsType} (${value})`,
          };
        }
        break;
      case 'boolean':
        if (jsType !== 'boolean') {
          return {
            field,
            expected: 'boolean',
            received: jsType,
            message: `Field '${field}' expected boolean, got ${jsType}`,
          };
        }
        break;
      case 'array':
        if (!Array.isArray(value)) {
          return {
            field,
            expected: 'array',
            received: jsType,
            message: `Field '${field}' expected array, got ${jsType}`,
          };
        }
        break;
      case 'object':
        if (jsType !== 'object' || Array.isArray(value) || value === null) {
          return {
            field,
            expected: 'object',
            received: value === null ? 'null' : Array.isArray(value) ? 'array' : jsType,
            message: `Field '${field}' expected object`,
          };
        }
        break;
    }
    return null;
  }

  private buildRepairMessages(
    originalMessages: Message[],
    toolCall: RawToolCall,
    errors: ValidationError[],
  ): Message[] {
    const errorText = this.config.repairFeedbackMode === 'structured'
      ? errors.map((e) => `- ${e.message}`).join('\n')
      : errors.map((e) => `- Field '${e.field}': expected ${e.expected}, received ${e.received}. ${e.message}`).join('\n');

    const repairMessage: Message = {
      role: 'user',
      content: `The previous tool call to '${toolCall.name}' failed validation:\n${errorText}\n\nPlease call the tool again with corrected arguments.`,
    };

    return [...originalMessages, repairMessage];
  }

  private applyRepairFailurePolicy(
    toolCall: RawToolCall,
    errors: ValidationError[],
    repairAttempts: number,
  ): ToolCallResult {
    const result: ToolCallResult = {
      valid: false,
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      arguments: {},
      errors,
      repairAttempts,
    };

    switch (this.config.onRepairFailure) {
      case 'throw':
        throw new ToolCallValidationError(
          `Tool call '${toolCall.name}' failed validation after ${repairAttempts} repair attempt(s). Errors: ${errors.map((e) => e.message).join('; ')}`,
          result,
        );
      case 'return-error':
        return result;
      case 'silent-drop':
        // Silently returns an invalid result — caller must check result.valid
        return result;
    }
  }
}

export class ToolCallValidationError extends Error {
  readonly result: ToolCallResult;

  constructor(message: string, result: ToolCallResult) {
    super(message);
    this.name = 'ToolCallValidationError';
    this.result = result;
  }
}

// Core types for the Tool Call Reliability pattern.
// All types are framework-agnostic — no LangChain, no LlamaIndex imports.

export interface JSONSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';
  description?: string;
  enum?: unknown[];
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, JSONSchemaProperty>;
    required?: string[];
  };
}

// Raw tool call as returned by the LLM provider (before validation)
export interface RawToolCall {
  id: string;
  name: string;
  // May be a string (needs JSON parsing) or already parsed
  arguments: string | Record<string, unknown>;
}

export interface ValidationError {
  field: string;
  expected: string;
  received: string;
  message: string;
}

export interface ToolCallResult {
  valid: boolean;
  toolName: string;
  toolCallId: string;
  arguments: Record<string, unknown>;
  errors?: ValidationError[];
  // Number of repair attempts made before this result
  repairAttempts: number;
}

// Message format for the repair conversation (provider-agnostic)
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: RawToolCall[];
}

export type SchemaStrictness = 'required-only' | 'all';
export type RepairFeedbackMode = 'structured' | 'verbose';
export type OnRepairFailure = 'throw' | 'return-error' | 'silent-drop';

export interface ValidatorConfig {
  // Maximum number of repair round-trips with the LLM. Default: 2
  maxRepairAttempts: number;
  // Reject tool calls for names not in provided schemas. Default: true
  strictAllowlist: boolean;
  // Whether to validate only required fields, or all defined fields. Default: 'required-only'
  schemaStrictness: SchemaStrictness;
  // How to convey validation errors back to the model in the repair prompt. Default: 'structured'
  repairFeedbackMode: RepairFeedbackMode;
  // What to do when all repair attempts fail. Default: 'throw'
  onRepairFailure: OnRepairFailure;
}

export interface LLMProvider {
  chat(messages: Message[], tools: ToolSchema[]): Promise<Message>;
}

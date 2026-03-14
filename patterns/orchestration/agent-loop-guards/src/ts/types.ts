/**
 * Agent Loop Guards — Type Definitions
 *
 * Defines configuration, state, and result types for the loop guard pattern.
 */

/** Reasons the guard can halt execution */
export type HaltReason =
  | 'max_turns'
  | 'max_tokens'
  | 'max_duration'
  | 'repeated_calls'
  | 'no_progress'
  | 'abort_signal';

/** A single tool call made by the LLM */
export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** LLM response containing optional tool calls and text */
export interface LLMResponse {
  text?: string;
  toolCalls: ToolCall[];
  tokensUsed: number;
}

/** Result of executing a tool */
export interface ToolResult {
  toolName: string;
  result: unknown;
  error?: string;
}

/** Snapshot of loop state at any point during execution */
export interface LoopContext {
  turnCount: number;
  totalTokens: number;
  elapsedMs: number;
  toolCallHistory: ToolCall[];
  haltReason?: HaltReason;
}

/** Configuration for the loop guard */
export interface LoopGuardConfig {
  /** Hard cap on LLM round-trips per session */
  maxTurns: number;
  /** Cumulative token budget across all turns */
  maxTokens: number;
  /** Wall-clock timeout for entire session (ms) */
  maxDurationMs: number;
  /** Consecutive identical tool calls before halt */
  maxRepeatedCalls: number;
  /** Number of recent turns to check for patterns */
  convergenceWindow: number;
  /** Callback when guard halts execution */
  onHalt?: (reason: HaltReason, context: LoopContext) => void;
}

/** An LLM provider interface — implemented by both mock and real providers */
export interface LLMProvider {
  call(messages: Message[], tools: ToolDefinition[]): Promise<LLMResponse>;
}

/** A message in the conversation */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
}

/** Definition of a tool the LLM can call */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** A tool executor function */
export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>
) => Promise<unknown>;

/** Result returned by the guarded agent loop */
export interface AgentResult {
  /** Final text response from the agent */
  response: string;
  /** Whether the loop completed naturally or was halted */
  halted: boolean;
  /** Reason for halting, if applicable */
  haltReason?: HaltReason;
  /** Final loop context with metrics */
  context: LoopContext;
}

/** Default configuration values */
export const DEFAULT_CONFIG: LoopGuardConfig = {
  maxTurns: 25,
  maxTokens: 100_000,
  maxDurationMs: 120_000,
  maxRepeatedCalls: 3,
  convergenceWindow: 5,
};

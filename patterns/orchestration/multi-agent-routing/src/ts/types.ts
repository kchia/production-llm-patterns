/**
 * Type definitions for the Multi-Agent Routing pattern.
 */

/** A registered agent and its routing metadata. */
export interface AgentCapability {
  /** Unique identifier used in routing decisions and audit logs. */
  id: string;
  /** Natural language description of what this agent handles. Used in the router prompt. */
  description: string;
  /**
   * Few-shot examples of requests this agent should handle.
   * 3–5 examples per agent is the sweet spot; more bloats the router prompt.
   */
  examples: string[];
  /**
   * Tiebreaker when two agents have similar confidence scores.
   * Higher number = higher priority. Use to prefer lower-cost agents.
   */
  priority: number;
}

/** The router's classification decision for a single request. */
export interface RoutingDecision {
  /** ID of the agent selected to handle this request. */
  agentId: string;
  /** Classification confidence, 0–1. Below threshold triggers fallback. */
  confidence: number;
  /** Brief reasoning from the classification call, for audit logs. */
  reasoning: string;
  /** True if this decision used the fallback path (confidence below threshold). */
  fallback: boolean;
}

/** Response from a dispatched agent. */
export interface AgentResponse {
  /** The agent that handled the request. */
  agentId: string;
  /** The agent's output. */
  content: string;
  /** Tokens consumed by the agent (for cost tracking). */
  tokensUsed: number;
  /** Wall-clock execution time in milliseconds. */
  latencyMs: number;
  /** The routing decision that dispatched this agent. */
  routingDecision: RoutingDecision;
}

/** Structured audit log entry for each routing decision. */
export interface RoutingAuditEntry {
  timestamp: string;
  request: string;
  decision: RoutingDecision;
  agentResponse?: AgentResponse;
  totalLatencyMs: number;
}

/** Configuration for the MultiAgentRouter. */
export interface RouterConfig {
  /**
   * Minimum confidence required to route to a specific agent.
   * Requests below this threshold are sent to fallbackAgentId (or throw if not set).
   * Default: 0.75. Raise if misroutes are causing issues; lower if fallback handles
   * uncertainty well and you prefer it to guess.
   */
  confidenceThreshold?: number;
  /**
   * Agent ID to use when confidence is below threshold.
   * If not set, low-confidence requests throw an error.
   */
  fallbackAgentId?: string;
  /**
   * Maximum tokens for the classification call.
   * Increase if the capability registry is large; decrease to reduce latency.
   * Default: 512.
   */
  maxRoutingTokens?: number;
  /**
   * Model name for the classification call. Can be a lighter/cheaper model
   * than the agents themselves (e.g., use Haiku for routing, Sonnet for agents).
   */
  routingModel?: string;
  /**
   * Timeout in ms for the classification call.
   * On timeout, falls back to fallbackAgentId if set, otherwise throws.
   * Default: 5000ms.
   */
  routingTimeoutMs?: number;
}

/** The LLM provider interface — implemented by both real and mock providers. */
export interface LLMProvider {
  complete(prompt: string, options?: CompletionOptions): Promise<LLMCompletion>;
}

export interface CompletionOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LLMCompletion {
  content: string;
  tokensUsed: number;
  latencyMs: number;
}

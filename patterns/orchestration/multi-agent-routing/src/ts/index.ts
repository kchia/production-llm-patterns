/**
 * Multi-Agent Routing pattern implementation.
 *
 * Classifies incoming requests and dispatches them to the most appropriate
 * registered agent, with confidence gating and fallback support.
 *
 * Usage:
 *   const router = new MultiAgentRouter(provider, config);
 *   router.register({ id: "billing", description: "...", examples: [...], priority: 1 });
 *   router.register({ id: "support", description: "...", examples: [...], priority: 0 });
 *   const response = await router.handle(userRequest);
 */

import type {
  AgentCapability,
  AgentResponse,
  LLMProvider,
  RouterConfig,
  RoutingAuditEntry,
  RoutingDecision,
} from "./types.js";

const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;
const DEFAULT_MAX_ROUTING_TOKENS = 512;
const DEFAULT_ROUTING_TIMEOUT_MS = 5_000;

export class MultiAgentRouter {
  private agents = new Map<string, AgentCapability>();
  private auditLog: RoutingAuditEntry[] = [];
  private config: Required<RouterConfig>;

  constructor(
    private readonly provider: LLMProvider,
    config: RouterConfig = {}
  ) {
    this.config = {
      confidenceThreshold: config.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
      fallbackAgentId: config.fallbackAgentId ?? "",
      maxRoutingTokens: config.maxRoutingTokens ?? DEFAULT_MAX_ROUTING_TOKENS,
      routingModel: config.routingModel ?? "default",
      routingTimeoutMs: config.routingTimeoutMs ?? DEFAULT_ROUTING_TIMEOUT_MS,
    };
  }

  /** Register a specialized agent. Can be called multiple times to build the pool. */
  register(agent: AgentCapability): void {
    if (this.agents.has(agent.id)) {
      throw new Error(`Agent "${agent.id}" is already registered`);
    }
    this.agents.set(agent.id, agent);
  }

  /** Remove a registered agent. */
  unregister(agentId: string): void {
    this.agents.delete(agentId);
  }

  /**
   * Main entry point: classify the request, dispatch to the chosen agent,
   * and return the combined result with audit metadata.
   */
  async handle(request: string): Promise<AgentResponse> {
    if (this.agents.size === 0) {
      throw new Error("No agents registered. Call register() before handle().");
    }

    const routingStart = Date.now();

    // Step 1: Classify
    const decision = await this.route(request);

    // Step 2: Dispatch
    const agentResponse = await this.dispatch(decision, request);

    // Step 4: Audit
    const entry: RoutingAuditEntry = {
      timestamp: new Date().toISOString(),
      request,
      decision,
      agentResponse,
      totalLatencyMs: Date.now() - routingStart,
    };
    this.auditLog.push(entry);

    return agentResponse;
  }

  /**
   * Classify a request and return a routing decision.
   * Exposed separately to allow callers to inspect decisions before dispatch.
   */
  async route(request: string): Promise<RoutingDecision> {
    const prompt = this.buildRoutingPrompt(request);

    let rawResponse: string;
    try {
      // Wrap classification call in a timeout — routing delays shouldn't block
      // indefinitely, and falling back is safer than waiting forever.
      const completion = await withTimeout(
        this.provider.complete(prompt, {
          model: this.config.routingModel,
          maxTokens: this.config.maxRoutingTokens,
          temperature: 0,
        }),
        this.config.routingTimeoutMs,
        `Routing classification timed out after ${this.config.routingTimeoutMs}ms`
      );
      rawResponse = completion.content;
    } catch (err) {
      // Timeout or provider error: activate fallback if configured
      return this.buildFallbackDecision(
        `Classification failed: ${(err as Error).message}`
      );
    }

    return this.parseRoutingResponse(rawResponse, request);
  }

  /**
   * Dispatch a routing decision to the selected agent.
   * The agent receives the original request — not a transformed version.
   */
  async dispatch(decision: RoutingDecision, request: string): Promise<AgentResponse> {
    const agent = this.agents.get(decision.agentId);
    if (!agent) {
      throw new Error(
        `Routing decision references unknown agent "${decision.agentId}". ` +
        `Registered agents: ${[...this.agents.keys()].join(", ")}`
      );
    }

    const agentStart = Date.now();

    // Build an agent-specific prompt using the agent's description as context.
    // In production, each agent would have its own system prompt; here we simulate
    // by prepending the agent's role to the request.
    const agentPrompt = buildAgentPrompt(agent, request);

    const completion = await this.provider.complete(agentPrompt, {
      model: agent.id, // Agents could use different models in production
    });

    return {
      agentId: agent.id,
      content: completion.content,
      tokensUsed: completion.tokensUsed,
      latencyMs: Date.now() - agentStart,
      routingDecision: decision,
    };
  }

  /** Returns a copy of the routing audit log for inspection. */
  getAuditLog(): RoutingAuditEntry[] {
    return [...this.auditLog];
  }

  /** Returns routing distribution stats — useful for monitoring. */
  getRoutingStats(): Record<string, { count: number; avgConfidence: number; fallbackCount: number }> {
    const stats: Record<string, { count: number; totalConfidence: number; fallbackCount: number }> = {};

    for (const entry of this.auditLog) {
      const id = entry.decision.agentId;
      if (!stats[id]) {
        stats[id] = { count: 0, totalConfidence: 0, fallbackCount: 0 };
      }
      stats[id].count++;
      stats[id].totalConfidence += entry.decision.confidence;
      if (entry.decision.fallback) stats[id].fallbackCount++;
    }

    return Object.fromEntries(
      Object.entries(stats).map(([id, s]) => [
        id,
        {
          count: s.count,
          avgConfidence: s.count > 0 ? s.totalConfidence / s.count : 0,
          fallbackCount: s.fallbackCount,
        },
      ])
    );
  }

  /** Current list of registered agents. */
  get registeredAgents(): AgentCapability[] {
    return [...this.agents.values()];
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private buildRoutingPrompt(request: string): string {
    const agentDescriptions = [...this.agents.values()]
      .sort((a, b) => b.priority - a.priority) // Higher priority agents listed first
      .map((agent) => {
        const examples = agent.examples.map((e) => `  - "${e}"`).join("\n");
        return `Agent ID: ${agent.id}\nDescription: ${agent.description}\nExample requests:\n${examples}`;
      })
      .join("\n\n");

    return `You are a request router. Classify the following request to the most appropriate agent.

Available agents:
${agentDescriptions}

Request to classify: "${request}"

Respond with JSON only:
{
  "agentId": "<agent id from the list above>",
  "confidence": <number between 0 and 1>,
  "reasoning": "<one sentence explanation>"
}`;
  }

  private parseRoutingResponse(rawResponse: string, request: string): RoutingDecision {
    let parsed: { agentId?: string; confidence?: number; reasoning?: string };

    try {
      // Strip markdown code fences if the LLM wrapped the JSON
      const cleaned = rawResponse.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      // Unparseable response: fall back rather than crash
      return this.buildFallbackDecision(
        `Router returned unparseable response: "${rawResponse.slice(0, 100)}"`
      );
    }

    const agentId = parsed.agentId ?? "";
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
    const reasoning = parsed.reasoning ?? "";

    // Validate: agent must be registered
    if (!this.agents.has(agentId)) {
      return this.buildFallbackDecision(
        `Router returned unknown agent ID "${agentId}"`
      );
    }

    // Confidence gate: below threshold → fallback
    if (confidence < this.config.confidenceThreshold) {
      if (this.config.fallbackAgentId) {
        return {
          agentId: this.config.fallbackAgentId,
          confidence,
          reasoning: `Low confidence (${confidence.toFixed(2)} < ${this.config.confidenceThreshold}): ${reasoning}`,
          fallback: true,
        };
      }
      throw new Error(
        `Routing confidence ${confidence.toFixed(2)} is below threshold ` +
        `${this.config.confidenceThreshold} and no fallbackAgentId is configured. ` +
        `Request: "${request.slice(0, 100)}"`
      );
    }

    return { agentId, confidence, reasoning, fallback: false };
  }

  private buildFallbackDecision(reason: string): RoutingDecision {
    if (!this.config.fallbackAgentId) {
      throw new Error(
        `Routing failed and no fallbackAgentId configured. Reason: ${reason}`
      );
    }
    if (!this.agents.has(this.config.fallbackAgentId)) {
      throw new Error(
        `fallbackAgentId "${this.config.fallbackAgentId}" is not registered. ` +
        `Register it before using it as a fallback.`
      );
    }
    return {
      agentId: this.config.fallbackAgentId,
      confidence: 0,
      reasoning: reason,
      fallback: true,
    };
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function buildAgentPrompt(agent: AgentCapability, request: string): string {
  return `You are a specialized agent for: ${agent.description}\n\nRequest: ${request}`;
}

/**
 * Race a promise against a timeout.
 * Rejects with a clear message if the timeout fires first.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err)   => { clearTimeout(timer); reject(err); }
    );
  });
}

// Re-export types for consumers
export type {
  AgentCapability,
  AgentResponse,
  RouterConfig,
  RoutingAuditEntry,
  RoutingDecision,
} from "./types.js";

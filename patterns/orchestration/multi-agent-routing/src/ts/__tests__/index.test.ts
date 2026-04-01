/**
 * Tests for the Multi-Agent Routing pattern.
 *
 * Three categories:
 *   1. Unit tests — core routing logic, confidence gating, registry operations
 *   2. Failure mode tests — one per failure mode in the README Failure Modes table
 *   3. Integration tests — end-to-end with mock provider
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MultiAgentRouter } from "../index.js";
import { MockLLMProvider } from "../mock-provider.js";
import type { AgentCapability } from "../types.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const billingAgent: AgentCapability = {
  id: "billing",
  description: "Handles billing and payment questions, invoices, refunds",
  examples: ["How do I update my credit card?", "I was charged twice", "Where is my invoice?"],
  priority: 1,
};

const supportAgent: AgentCapability = {
  id: "support",
  description: "Handles general product support, troubleshooting, and how-to questions",
  examples: ["How do I reset my password?", "The app is crashing", "Where is the settings page?"],
  priority: 0,
};

const fallbackAgent: AgentCapability = {
  id: "fallback",
  description: "General-purpose fallback for unclassified requests",
  examples: [],
  priority: 0,
};

function makeRouter(config?: Parameters<typeof MultiAgentRouter>[1], providerConfig?: ConstructorParameters<typeof MockLLMProvider>[0]) {
  const provider = new MockLLMProvider(providerConfig);
  const router = new MultiAgentRouter(provider, config);
  router.register(billingAgent);
  router.register(supportAgent);
  return { router, provider };
}

// ─── Unit Tests ─────────────────────────────────────────────────────────────

describe("Unit: agent registry", () => {
  it("registers agents and lists them", () => {
    const router = new MultiAgentRouter(new MockLLMProvider());
    router.register(billingAgent);
    router.register(supportAgent);
    expect(router.registeredAgents).toHaveLength(2);
    expect(router.registeredAgents.map((a) => a.id)).toEqual(
      expect.arrayContaining(["billing", "support"])
    );
  });

  it("throws on duplicate agent ID", () => {
    const router = new MultiAgentRouter(new MockLLMProvider());
    router.register(billingAgent);
    expect(() => router.register(billingAgent)).toThrow(/already registered/);
  });

  it("unregisters agents", () => {
    const router = new MultiAgentRouter(new MockLLMProvider());
    router.register(billingAgent);
    router.unregister("billing");
    expect(router.registeredAgents).toHaveLength(0);
  });

  it("throws when handle() is called with no registered agents", async () => {
    const router = new MultiAgentRouter(new MockLLMProvider());
    await expect(router.handle("any request")).rejects.toThrow(/No agents registered/);
  });
});

describe("Unit: confidence gating", () => {
  it("routes high-confidence decisions to the classified agent", async () => {
    const { router } = makeRouter(
      { confidenceThreshold: 0.75 },
      {
        routingOverride: {
          agentId: "billing",
          confidence: 0.92,
          reasoning: "Billing question",
        },
      }
    );
    const response = await router.handle("I need a refund");
    expect(response.agentId).toBe("billing");
    expect(response.routingDecision.fallback).toBe(false);
  });

  it("activates fallback when confidence is below threshold", async () => {
    const provider = new MockLLMProvider({
      routingOverride: {
        agentId: "billing",
        confidence: 0.40, // below 0.75 threshold
        reasoning: "Uncertain",
      },
    });
    const router = new MultiAgentRouter(provider, { fallbackAgentId: "fallback" });
    router.register(billingAgent);
    router.register(fallbackAgent);

    const response = await router.handle("something unclear");
    expect(response.agentId).toBe("fallback");
    expect(response.routingDecision.fallback).toBe(true);
  });

  it("throws when confidence is low and no fallback is configured", async () => {
    const { router } = makeRouter(
      { confidenceThreshold: 0.75 },
      {
        routingOverride: {
          agentId: "billing",
          confidence: 0.40,
          reasoning: "Low confidence",
        },
      }
    );
    await expect(router.handle("unclear request")).rejects.toThrow(/below threshold/);
  });

  it("respects custom confidence threshold", async () => {
    // With threshold=0.5, confidence=0.6 should route normally (not fallback)
    const { router } = makeRouter(
      { confidenceThreshold: 0.5 },
      {
        routingOverride: {
          agentId: "support",
          confidence: 0.6,
          reasoning: "Support question",
        },
      }
    );
    const response = await router.handle("how do I reset my password?");
    expect(response.agentId).toBe("support");
    expect(response.routingDecision.fallback).toBe(false);
  });
});

describe("Unit: routing decision parsing", () => {
  it("falls back on unparseable JSON from the router", async () => {
    const provider = new MockLLMProvider({
      responseSequence: ["this is not valid json at all"],
    });
    const router = new MultiAgentRouter(provider, { fallbackAgentId: "fallback" });
    router.register(billingAgent);
    router.register(fallbackAgent);

    const response = await router.handle("any request");
    expect(response.agentId).toBe("fallback");
    expect(response.routingDecision.fallback).toBe(true);
  });

  it("falls back when router returns an unknown agent ID", async () => {
    const provider = new MockLLMProvider({
      routingOverride: {
        agentId: "nonexistent-agent",
        confidence: 0.99,
        reasoning: "Ghost agent",
      },
    });
    const router = new MultiAgentRouter(provider, { fallbackAgentId: "fallback" });
    router.register(billingAgent);
    router.register(fallbackAgent);

    const response = await router.handle("any request");
    expect(response.agentId).toBe("fallback");
    expect(response.routingDecision.fallback).toBe(true);
  });

  it("throws on unknown agent ID when no fallback configured", async () => {
    const provider = new MockLLMProvider({
      routingOverride: {
        agentId: "nonexistent-agent",
        confidence: 0.99,
        reasoning: "Ghost agent",
      },
    });
    const router = new MultiAgentRouter(provider);
    router.register(billingAgent);

    await expect(router.handle("any request")).rejects.toThrow();
  });
});

describe("Unit: audit log", () => {
  it("logs each routing decision", async () => {
    const { router } = makeRouter(
      {},
      {
        routingOverride: { agentId: "billing", confidence: 0.9, reasoning: "Billing" },
      }
    );
    await router.handle("first request");
    await router.handle("second request");

    const log = router.getAuditLog();
    expect(log).toHaveLength(2);
    expect(log[0].decision.agentId).toBe("billing");
    expect(log[1].decision.agentId).toBe("billing");
  });

  it("getRoutingStats tracks counts and fallbacks", async () => {
    const provider = new MockLLMProvider({
      routingOverride: { agentId: "billing", confidence: 0.4, reasoning: "Low" },
    });
    const router = new MultiAgentRouter(provider, { fallbackAgentId: "fallback" });
    router.register(billingAgent);
    router.register(fallbackAgent);

    await router.handle("request 1");
    await router.handle("request 2");

    const stats = router.getRoutingStats();
    expect(stats["fallback"].count).toBe(2);
    expect(stats["fallback"].fallbackCount).toBe(2);
  });
});

// ─── Failure Mode Tests ──────────────────────────────────────────────────────

describe("Failure modes", () => {
  // FM: Misclassification cascade — wrong agent gets the request.
  // Test: The audit log captures the routing decision so misroutes can be identified retrospectively.
  it("FM1: audit log captures misrouted requests for retrospective analysis", async () => {
    // Simulate a "wrong" routing: support question routed to billing
    const provider = new MockLLMProvider({
      routingOverride: {
        agentId: "billing",
        confidence: 0.91,
        reasoning: "Incorrectly classified as billing",
      },
    });
    const router = new MultiAgentRouter(provider);
    router.register(billingAgent);
    router.register(supportAgent);

    const response = await router.handle("how do I reset my password?");
    expect(response.agentId).toBe("billing"); // Wrong — but logged

    const log = router.getAuditLog();
    // The audit log contains the routing decision, enabling retrospective analysis
    expect(log[0].decision.agentId).toBe("billing");
    expect(log[0].request).toBe("how do I reset my password?");
  });

  // FM: Capability description drift — stale descriptions route to fallback.
  // Test: Low-confidence routing (caused by stale descriptions) activates fallback.
  it("FM2: low-confidence routing (stale capability descriptions) activates fallback", async () => {
    const provider = new MockLLMProvider({
      routingOverride: {
        agentId: "billing",
        confidence: 0.30, // Very low — stale description doesn't match request
        reasoning: "Uncertain match with outdated description",
      },
    });
    const router = new MultiAgentRouter(provider, { fallbackAgentId: "fallback" });
    router.register(billingAgent);
    router.register(fallbackAgent);

    const response = await router.handle("process my enterprise license renewal");
    expect(response.agentId).toBe("fallback");
    expect(response.routingDecision.fallback).toBe(true);
    expect(response.routingDecision.reasoning).toMatch(/Low confidence/);
  });

  // FM: Ambiguous multi-intent queries — request spans two domains, low confidence.
  // Test: Multi-domain request falls back when neither agent is clearly correct.
  it("FM3: ambiguous multi-intent query falls back when confidence is low", async () => {
    const provider = new MockLLMProvider({
      routingOverride: {
        agentId: "billing",
        confidence: 0.55, // Below threshold — neither agent is clearly right
        reasoning: "Unclear — spans billing and support",
      },
    });
    const router = new MultiAgentRouter(provider, {
      confidenceThreshold: 0.75,
      fallbackAgentId: "fallback",
    });
    router.register(billingAgent);
    router.register(supportAgent);
    router.register(fallbackAgent);

    const response = await router.handle("I need to cancel my subscription and get a refund but also my account is broken");
    expect(response.agentId).toBe("fallback");
    expect(response.routingDecision.fallback).toBe(true);
  });

  // FM: Fallback overload — all requests fall to fallback.
  // Test: Routing stats show all requests as fallbacks, enabling detection.
  it("FM4: routing stats detect fallback overload", async () => {
    const provider = new MockLLMProvider({
      routingOverride: {
        agentId: "billing",
        confidence: 0.20, // All requests below threshold
        reasoning: "No match",
      },
    });
    const router = new MultiAgentRouter(provider, { fallbackAgentId: "fallback" });
    router.register(billingAgent);
    router.register(fallbackAgent);

    // Simulate 5 requests all falling back
    for (let i = 0; i < 5; i++) {
      await router.handle(`request ${i}`);
    }

    const stats = router.getRoutingStats();
    const fallbackCount = stats["fallback"]?.fallbackCount ?? 0;
    expect(fallbackCount).toBe(5); // All 5 went to fallback — detectable overload signal
  });

  // FM: Router latency spike — classification call times out, fallback activates.
  it("FM5: routing timeout activates fallback", async () => {
    const slowProvider = new MockLLMProvider({
      latencyMs: 200, // Slower than timeout
    });
    const router = new MultiAgentRouter(slowProvider, {
      routingTimeoutMs: 50, // Very short timeout to force timeout
      fallbackAgentId: "fallback",
    });
    router.register(billingAgent);
    router.register(fallbackAgent);

    const response = await router.handle("any request");
    expect(response.agentId).toBe("fallback");
    expect(response.routingDecision.fallback).toBe(true);
    expect(response.routingDecision.reasoning).toMatch(/timed out/i);
  });

  // FM: Silent misroute accumulation — routing distribution shifts without alerting.
  // Test: getRoutingStats() provides the data needed to detect distribution shifts.
  it("FM6 (silent degradation): routing stats enable distribution shift detection", async () => {
    // Simulate a routing pattern where one agent captures all traffic
    const provider = new MockLLMProvider({
      routingOverride: { agentId: "billing", confidence: 0.95, reasoning: "Overfit" },
    });
    const router = new MultiAgentRouter(provider);
    router.register(billingAgent);
    router.register(supportAgent);

    // 10 requests, all routed to billing (even support-type requests — the silent failure)
    for (let i = 0; i < 10; i++) {
      await router.handle(`request ${i}`);
    }

    const stats = router.getRoutingStats();
    // In production, a billing concentration of 100% when only 50% of requests
    // should be billing is the signal. Here we verify the stats enable detection.
    expect(stats["billing"].count).toBe(10);
    expect(stats["support"]?.count ?? 0).toBe(0);
    // The distribution imbalance is measurable — this is how the failure gets caught
  });
});

// ─── Integration Tests ───────────────────────────────────────────────────────

describe("Integration: end-to-end routing with mock provider", () => {
  it("routes a request end-to-end and returns a response", async () => {
    const { router } = makeRouter(
      {},
      {
        routingOverride: { agentId: "support", confidence: 0.88, reasoning: "Support question" },
        responseSequence: ["routing JSON (overridden)", "Here is how to reset your password."],
      }
    );

    const response = await router.handle("how do I reset my password?");
    expect(response.agentId).toBe("support");
    expect(response.content).toBeTruthy();
    expect(response.routingDecision.confidence).toBe(0.88);
    expect(response.routingDecision.fallback).toBe(false);
  });

  it("audit log entry contains full request, decision, and response", async () => {
    const { router } = makeRouter(
      {},
      {
        routingOverride: { agentId: "billing", confidence: 0.95, reasoning: "Billing" },
      }
    );

    await router.handle("where is my invoice?");
    const log = router.getAuditLog();

    expect(log).toHaveLength(1);
    expect(log[0].request).toBe("where is my invoice?");
    expect(log[0].decision.agentId).toBe("billing");
    expect(log[0].agentResponse).toBeDefined();
    expect(log[0].totalLatencyMs).toBeGreaterThan(0);
  });

  it("handles concurrent routing requests correctly", async () => {
    const { router } = makeRouter(
      {},
      {
        routingOverride: { agentId: "support", confidence: 0.85, reasoning: "Support" },
      }
    );

    const requests = Array.from({ length: 10 }, (_, i) => `request ${i}`);
    const responses = await Promise.all(requests.map((r) => router.handle(r)));

    expect(responses).toHaveLength(10);
    responses.forEach((r) => expect(r.agentId).toBe("support"));
    expect(router.getAuditLog()).toHaveLength(10);
  });

  it("throws a clear error when fallbackAgentId is not registered", async () => {
    const provider = new MockLLMProvider({
      routingOverride: { agentId: "billing", confidence: 0.2, reasoning: "Low" },
    });
    const router = new MultiAgentRouter(provider, { fallbackAgentId: "unregistered-fallback" });
    router.register(billingAgent);

    await expect(router.handle("some request")).rejects.toThrow(/not registered/);
  });

  it("route() returns decision independently of dispatch", async () => {
    const { router } = makeRouter(
      {},
      {
        routingOverride: { agentId: "billing", confidence: 0.92, reasoning: "Billing" },
      }
    );

    const decision = await router.route("how do I get a refund?");
    expect(decision.agentId).toBe("billing");
    expect(decision.confidence).toBe(0.92);
    expect(decision.fallback).toBe(false);
  });
});

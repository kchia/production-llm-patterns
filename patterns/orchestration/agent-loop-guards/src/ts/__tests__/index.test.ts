import { describe, it, expect, vi } from 'vitest';
import { AgentLoopGuard } from '../index';
import { MockProvider } from '../mock-provider';
import type { ToolDefinition, LLMResponse, HaltReason, LoopContext } from '../types';

// ---------- Shared fixtures ----------

const tools: ToolDefinition[] = [
  { name: 'search', description: 'Search the web', parameters: { query: { type: 'string' } } },
  { name: 'calculate', description: 'Do math', parameters: { expression: { type: 'string' } } },
];

const executor = async (_name: string, _args: Record<string, unknown>) => ({ result: 'ok' });

const failingExecutor = async (_name: string, _args: Record<string, unknown>) => {
  throw new Error('Tool execution failed');
};

function makeToolResponse(name: string, args: Record<string, unknown>, tokens = 100): LLMResponse {
  return { toolCalls: [{ name, arguments: args }], tokensUsed: tokens };
}

function makeDoneResponse(text = 'Done', tokens = 50): LLMResponse {
  return { text, toolCalls: [], tokensUsed: tokens };
}

// ---------- Unit Tests ----------

describe('AgentLoopGuard — Unit Tests', () => {
  it('uses default config when none provided', () => {
    const guard = new AgentLoopGuard();
    const config = guard.getConfig();
    expect(config.maxTurns).toBe(25);
    expect(config.maxTokens).toBe(100_000);
    expect(config.maxDurationMs).toBe(120_000);
    expect(config.maxRepeatedCalls).toBe(3);
    expect(config.convergenceWindow).toBe(5);
  });

  it('merges partial config with defaults', () => {
    const guard = new AgentLoopGuard({ maxTurns: 10 });
    const config = guard.getConfig();
    expect(config.maxTurns).toBe(10);
    expect(config.maxTokens).toBe(100_000); // default preserved
  });

  it('completes naturally when model returns no tool calls', async () => {
    const provider = new MockProvider({
      scriptedResponses: [makeDoneResponse('Hello!')],
    });
    const guard = new AgentLoopGuard();
    const result = await guard.run(provider, tools, executor, [{ role: 'user', content: 'hi' }]);

    expect(result.halted).toBe(false);
    expect(result.response).toBe('Hello!');
    expect(result.context.turnCount).toBe(1);
  });

  it('tracks token usage across multiple turns', async () => {
    const provider = new MockProvider({
      scriptedResponses: [
        makeToolResponse('search', { query: 'a' }, 200),
        makeToolResponse('calculate', { expression: '1+1' }, 300),
        makeDoneResponse('Result', 100),
      ],
    });
    const guard = new AgentLoopGuard();
    const result = await guard.run(provider, tools, executor, [{ role: 'user', content: 'task' }]);

    expect(result.halted).toBe(false);
    expect(result.context.totalTokens).toBe(600); // 200 + 300 + 100
    expect(result.context.turnCount).toBe(3);
  });

  it('handles tool execution errors gracefully', async () => {
    const provider = new MockProvider({
      scriptedResponses: [
        makeToolResponse('search', { query: 'test' }),
        makeDoneResponse('Done despite error'),
      ],
    });
    const guard = new AgentLoopGuard();
    const result = await guard.run(
      provider, tools, failingExecutor,
      [{ role: 'user', content: 'test' }]
    );

    expect(result.halted).toBe(false);
    expect(result.response).toBe('Done despite error');
  });
});

// ---------- Failure Mode Tests ----------

describe('AgentLoopGuard — Failure Mode: Guard too aggressive (max_turns)', () => {
  it('halts at maxTurns and reports the reason', async () => {
    const responses: LLMResponse[] = Array.from({ length: 10 }, (_, i) =>
      makeToolResponse('search', { query: `q${i}` })
    );

    const provider = new MockProvider({ scriptedResponses: responses });
    const guard = new AgentLoopGuard({ maxTurns: 5 });
    const result = await guard.run(provider, tools, executor, [{ role: 'user', content: 'go' }]);

    expect(result.halted).toBe(true);
    expect(result.haltReason).toBe('max_turns');
    expect(result.context.turnCount).toBe(5);
  });
});

describe('AgentLoopGuard — Failure Mode: Guard too permissive (token budget)', () => {
  it('halts when cumulative token budget is exceeded', async () => {
    const responses: LLMResponse[] = Array.from({ length: 100 }, (_, i) =>
      makeToolResponse('search', { query: `q${i}` }, 500)
    );

    const provider = new MockProvider({ scriptedResponses: responses });
    const guard = new AgentLoopGuard({ maxTurns: 100, maxTokens: 2000 });
    const result = await guard.run(provider, tools, executor, [{ role: 'user', content: 'go' }]);

    expect(result.halted).toBe(true);
    expect(result.haltReason).toBe('max_tokens');
    expect(result.context.totalTokens).toBeGreaterThanOrEqual(2000);
  });
});

describe('AgentLoopGuard — Failure Mode: Convergence false positives (repeated_calls)', () => {
  it('detects consecutive identical tool calls', async () => {
    const sameCall = makeToolResponse('search', { query: 'stuck' });
    const provider = new MockProvider({
      scriptedResponses: [sameCall, sameCall, sameCall, sameCall],
    });
    const guard = new AgentLoopGuard({ maxTurns: 20, maxRepeatedCalls: 3 });
    const result = await guard.run(provider, tools, executor, [{ role: 'user', content: 'go' }]);

    expect(result.halted).toBe(true);
    expect(result.haltReason).toBe('repeated_calls');
  });

  it('does NOT halt when similar but different tool calls are made', async () => {
    const provider = new MockProvider({
      scriptedResponses: [
        makeToolResponse('search', { query: 'a' }),
        makeToolResponse('search', { query: 'b' }),
        makeToolResponse('search', { query: 'c' }),
        makeDoneResponse('Found it'),
      ],
    });
    const guard = new AgentLoopGuard({ maxTurns: 20, maxRepeatedCalls: 3 });
    const result = await guard.run(provider, tools, executor, [{ role: 'user', content: 'go' }]);

    expect(result.halted).toBe(false);
    expect(result.response).toBe('Found it');
  });
});

describe('AgentLoopGuard — Failure Mode: No progress (cycle detection)', () => {
  it('detects cyclic patterns in tool call history', async () => {
    // Create A-B-A-B-A-B pattern (window of 3, repeated twice)
    const callA = makeToolResponse('search', { query: 'x' });
    const callB = makeToolResponse('calculate', { expression: '1+1' });
    const callC = makeToolResponse('search', { query: 'y' });
    const provider = new MockProvider({
      scriptedResponses: [callA, callB, callC, callA, callB, callC],
    });
    const guard = new AgentLoopGuard({
      maxTurns: 20,
      convergenceWindow: 3,
      maxRepeatedCalls: 10,
    });
    const result = await guard.run(provider, tools, executor, [{ role: 'user', content: 'go' }]);

    expect(result.halted).toBe(true);
    expect(result.haltReason).toBe('no_progress');
  });
});

describe('AgentLoopGuard — Failure Mode: Duration timeout', () => {
  it('halts when wall-clock duration exceeds maxDurationMs', async () => {
    // Use a provider with high latency to trigger timeout
    const responses: LLMResponse[] = Array.from({ length: 100 }, (_, i) =>
      makeToolResponse('search', { query: `q${i}` })
    );
    const provider = new MockProvider({
      scriptedResponses: responses,
      latencyMs: 100,
      latencyJitterMs: 0,
    });
    const guard = new AgentLoopGuard({
      maxTurns: 100,
      maxDurationMs: 250,
    });
    const result = await guard.run(provider, tools, executor, [{ role: 'user', content: 'go' }]);

    expect(result.halted).toBe(true);
    expect(result.haltReason).toBe('max_duration');
  });
});

describe('AgentLoopGuard — Failure Mode: Abort signal ignored', () => {
  it('halts when abort signal fires before a turn', async () => {
    const controller = new AbortController();
    const responses: LLMResponse[] = Array.from({ length: 10 }, (_, i) =>
      makeToolResponse('search', { query: `q${i}` })
    );
    const provider = new MockProvider({ scriptedResponses: responses, latencyMs: 10 });

    // Abort after a short delay
    setTimeout(() => controller.abort(), 50);

    const guard = new AgentLoopGuard({ maxTurns: 100 });
    const result = await guard.run(
      provider, tools, executor,
      [{ role: 'user', content: 'go' }],
      controller.signal
    );

    expect(result.halted).toBe(true);
    expect(result.haltReason).toBe('abort_signal');
  });
});

describe('AgentLoopGuard — Failure Mode: Silent degradation', () => {
  it('onHalt callback fires with context for monitoring drift', async () => {
    const haltLog: { reason: HaltReason; context: LoopContext }[] = [];
    const sameCall = makeToolResponse('search', { query: 'stuck' });
    const provider = new MockProvider({
      scriptedResponses: [sameCall, sameCall, sameCall],
    });
    const guard = new AgentLoopGuard({
      maxTurns: 20,
      maxRepeatedCalls: 3,
      onHalt: (reason, context) => {
        haltLog.push({ reason, context: { ...context } });
      },
    });

    await guard.run(provider, tools, executor, [{ role: 'user', content: 'go' }]);

    expect(haltLog).toHaveLength(1);
    expect(haltLog[0].reason).toBe('repeated_calls');
    expect(haltLog[0].context.turnCount).toBe(3);
    expect(haltLog[0].context.toolCallHistory).toHaveLength(3);
  });
});

// ---------- Integration Tests ----------

describe('AgentLoopGuard — Integration: Full agent run with mock provider', () => {
  it('completes a multi-step tool-calling agent task', async () => {
    const provider = new MockProvider({
      scriptedResponses: [
        makeToolResponse('search', { query: 'weather in NYC' }),
        makeToolResponse('calculate', { expression: '72 - 32' }),
        makeDoneResponse('The temperature in NYC is 72°F (40°C difference from freezing).'),
      ],
    });

    const toolResults: { name: string; args: Record<string, unknown> }[] = [];
    const trackingExecutor = async (name: string, args: Record<string, unknown>) => {
      toolResults.push({ name, args });
      if (name === 'search') return { weather: '72°F' };
      if (name === 'calculate') return { result: 40 };
      return { result: 'unknown' };
    };

    const guard = new AgentLoopGuard({ maxTurns: 10 });
    const result = await guard.run(
      provider, tools, trackingExecutor,
      [
        { role: 'system', content: 'You are a helpful assistant with access to tools.' },
        { role: 'user', content: 'What is the weather in NYC?' },
      ]
    );

    expect(result.halted).toBe(false);
    expect(result.context.turnCount).toBe(3);
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0].name).toBe('search');
    expect(toolResults[1].name).toBe('calculate');
  });

  it('handles a loop simulation with the mock provider', async () => {
    const provider = new MockProvider({
      simulateLoop: true,
      loopToolCall: { name: 'search', arguments: { query: 'same thing' } },
      loopStartAfter: 0,
      latencyMs: 1,
    });

    const guard = new AgentLoopGuard({
      maxTurns: 20,
      maxRepeatedCalls: 3,
    });

    const result = await guard.run(
      provider, tools, executor,
      [{ role: 'user', content: 'search for something' }]
    );

    expect(result.halted).toBe(true);
    expect(result.haltReason).toBe('repeated_calls');
    expect(result.context.turnCount).toBe(3);
  });

  it('handles concurrent usage with independent guard instances', async () => {
    const provider1 = new MockProvider({
      scriptedResponses: [
        makeToolResponse('search', { query: 'task1' }),
        makeDoneResponse('Result 1'),
      ],
      latencyMs: 10,
    });
    const provider2 = new MockProvider({
      simulateLoop: true,
      loopToolCall: { name: 'search', arguments: { query: 'loop' } },
      loopStartAfter: 0,
      latencyMs: 10,
    });

    const guard1 = new AgentLoopGuard({ maxTurns: 10 });
    const guard2 = new AgentLoopGuard({ maxTurns: 10, maxRepeatedCalls: 3 });

    const [result1, result2] = await Promise.all([
      guard1.run(provider1, tools, executor, [{ role: 'user', content: 'task1' }]),
      guard2.run(provider2, tools, executor, [{ role: 'user', content: 'task2' }]),
    ]);

    expect(result1.halted).toBe(false);
    expect(result1.response).toBe('Result 1');
    expect(result2.halted).toBe(true);
    expect(result2.haltReason).toBe('repeated_calls');
  });
});

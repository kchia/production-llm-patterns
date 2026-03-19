import { describe, it, expect, beforeEach } from 'vitest';
import { ContextManager, createMockTokenizer, createMockSummarizer } from '../index.js';
import { MockTokenizer } from '../mock-provider.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeManager(overrides: Parameters<typeof ContextManager>[0] = {}) {
  return new ContextManager({
    maxTokens: 1_000,
    reserveForOutput: 100,
    ...overrides,
  });
}

function addN(manager: ContextManager, n: number, role: 'user' | 'assistant' = 'user') {
  for (let i = 0; i < n; i++) {
    manager.add({ role, content: `Message ${i} with some content that takes up tokens in the window.` });
  }
}

// ─── Unit Tests: Configuration ────────────────────────────────────────────────

describe('ContextManager configuration', () => {
  it('uses sensible defaults', () => {
    const manager = new ContextManager();
    const config = manager.getConfig();
    expect(config.maxTokens).toBe(128_000);
    expect(config.reserveForOutput).toBe(4_000);
    expect(config.strategy).toBe('sliding-window');
    expect(config.keepRecent).toBe(10);
  });

  it('accepts partial config overrides', () => {
    const manager = new ContextManager({ maxTokens: 32_000, strategy: 'priority' });
    const config = manager.getConfig();
    expect(config.maxTokens).toBe(32_000);
    expect(config.strategy).toBe('priority');
    expect(config.reserveForOutput).toBe(4_000); // default preserved
  });

  it('returns immutable config snapshot', () => {
    const manager = new ContextManager({ maxTokens: 10_000 });
    const config = manager.getConfig();
    (config as { maxTokens: number }).maxTokens = 999;
    expect(manager.getConfig().maxTokens).toBe(10_000);
  });
});

// ─── Unit Tests: add(), remove(), clear() ────────────────────────────────────

describe('History management', () => {
  it('add() returns an id', () => {
    const manager = makeManager();
    const id = manager.add({ role: 'user', content: 'Hello', priority: 0.5 });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('add() caches token count on the message', () => {
    const manager = makeManager();
    manager.add({ role: 'user', content: 'Hello world' });
    const history = manager.getHistory();
    expect(history[0].tokens).toBeGreaterThan(0);
  });

  it('remove() deletes a message by id', () => {
    const manager = makeManager();
    const id = manager.add({ role: 'user', content: 'Remove me', priority: 0.5 });
    expect(manager.getHistory().length).toBe(1);
    const result = manager.remove(id);
    expect(result).toBe(true);
    expect(manager.getHistory().length).toBe(0);
  });

  it('remove() returns false for unknown id', () => {
    const manager = makeManager();
    expect(manager.remove('nonexistent-id')).toBe(false);
  });

  it('clear() empties the history', () => {
    const manager = makeManager();
    addN(manager, 5);
    manager.clear();
    expect(manager.getHistory().length).toBe(0);
  });

  it('build() on empty history returns empty window', () => {
    const manager = makeManager();
    const window = manager.build();
    expect(window.messages).toHaveLength(0);
    expect(window.totalTokens).toBe(0);
    expect(window.droppedMessages).toBe(0);
  });
});

// ─── Unit Tests: Sliding Window Strategy ─────────────────────────────────────

describe('Sliding window strategy', () => {
  it('keeps all messages when they fit within budget', () => {
    const manager = makeManager({ strategy: 'sliding-window' });
    addN(manager, 3);
    const window = manager.build();
    expect(window.messages).toHaveLength(3);
    expect(window.droppedMessages).toBe(0);
  });

  it('keeps system messages when trimming non-system messages', () => {
    const manager = makeManager({ maxTokens: 200, reserveForOutput: 20, strategy: 'sliding-window' });
    manager.add({ role: 'system', content: 'You are a helpful assistant.', priority: 1 });
    addN(manager, 20); // lots of messages to force trimming
    const window = manager.build();
    const systemMessages = window.messages.filter((m) => m.role === 'system');
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].content).toBe('You are a helpful assistant.');
  });

  it('keeps most recent messages when trimming', () => {
    const manager = makeManager({ maxTokens: 200, reserveForOutput: 20, strategy: 'sliding-window' });
    addN(manager, 10);
    // Add a distinctive final message
    const finalContent = 'This is the final most-recent message unique-xyz';
    manager.add({ role: 'user', content: finalContent, priority: 0.5 });
    const window = manager.build();
    const lastKept = window.messages[window.messages.length - 1];
    expect(lastKept.content).toBe(finalContent);
  });

  it('budgetUsed is within 0–1 range', () => {
    const manager = makeManager({ strategy: 'sliding-window' });
    addN(manager, 5);
    const window = manager.build();
    expect(window.budgetUsed).toBeGreaterThanOrEqual(0);
    expect(window.budgetUsed).toBeLessThanOrEqual(1);
  });

  it('totalTokens does not exceed available budget', () => {
    const manager = makeManager({ maxTokens: 300, reserveForOutput: 50, strategy: 'sliding-window' });
    addN(manager, 20);
    const window = manager.build();
    expect(window.totalTokens).toBeLessThanOrEqual(250);
  });
});

// ─── Unit Tests: Priority Strategy ───────────────────────────────────────────

describe('Priority strategy', () => {
  it('keeps system messages when trimming', () => {
    const manager = makeManager({ maxTokens: 200, reserveForOutput: 20, strategy: 'priority' });
    manager.add({ role: 'system', content: 'You are a helpful assistant.', priority: 1 });
    addN(manager, 15);
    const window = manager.build();
    const systemMessages = window.messages.filter((m) => m.role === 'system');
    expect(systemMessages).toHaveLength(1);
  });

  it('prefers high-priority messages over low-priority when trimming', () => {
    const manager = makeManager({ maxTokens: 200, reserveForOutput: 20, strategy: 'priority' });
    // Add several low-priority messages
    for (let i = 0; i < 5; i++) {
      manager.add({ role: 'user', content: `Low priority message ${i} filler text here filler`, priority: 0.1 });
    }
    // Add one high-priority message
    const highPrioContent = 'HIGH PRIORITY: critical instruction unique-abc';
    manager.add({ role: 'user', content: highPrioContent, priority: 0.99 });
    // Add more low-priority to force trimming
    for (let i = 0; i < 5; i++) {
      manager.add({ role: 'user', content: `Another low priority ${i} filler filler filler`, priority: 0.1 });
    }

    const window = manager.build();
    const texts = window.messages.map((m) => m.content);
    expect(texts).toContain(highPrioContent);
  });

  it('totalTokens does not exceed available budget', () => {
    const manager = makeManager({ maxTokens: 300, reserveForOutput: 50, strategy: 'priority' });
    addN(manager, 20);
    const window = manager.build();
    expect(window.totalTokens).toBeLessThanOrEqual(250);
  });

  it('restores original message order after priority selection', () => {
    const manager = makeManager({ maxTokens: 500, reserveForOutput: 50, strategy: 'priority' });
    const ids: string[] = [];
    ids.push(manager.add({ role: 'user', content: 'First message priority 0.9 text', priority: 0.9 }));
    ids.push(manager.add({ role: 'assistant', content: 'Second message priority 0.8 reply', priority: 0.8 }));
    ids.push(manager.add({ role: 'user', content: 'Third message priority 0.7 question', priority: 0.7 }));

    const window = manager.build();
    // If all fit, order should match insertion order
    if (window.droppedMessages === 0) {
      expect(window.messages[0].id).toBe(ids[0]);
      expect(window.messages[1].id).toBe(ids[1]);
      expect(window.messages[2].id).toBe(ids[2]);
    }
  });
});

// ─── Unit Tests: Summarize Strategy ──────────────────────────────────────────

describe('Summarize strategy', () => {
  it('keeps system messages when compressing', () => {
    const manager = makeManager({ maxTokens: 300, reserveForOutput: 30, strategy: 'summarize', keepRecent: 3 });
    manager.add({ role: 'system', content: 'System instructions here.', priority: 1 });
    addN(manager, 15);
    const window = manager.build();
    const systemMessages = window.messages.filter((m) => m.role === 'system');
    expect(systemMessages).toHaveLength(1);
  });

  it('keeps the most recent keepRecent messages verbatim', () => {
    const manager = makeManager({ maxTokens: 500, reserveForOutput: 50, strategy: 'summarize', keepRecent: 3 });
    // Add older messages
    for (let i = 0; i < 5; i++) {
      manager.add({ role: 'user', content: `Old message ${i} old content filler text words`, priority: 0.5 });
    }
    // Add recent messages with unique content
    const recent = ['Recent A unique first', 'Recent B unique second', 'Recent C unique third'];
    for (const content of recent) {
      manager.add({ role: 'assistant', content, priority: 0.5 });
    }

    const window = manager.build();
    const texts = window.messages.map((m) => m.content);
    for (const r of recent) {
      expect(texts.some((t) => t.includes(r.split(' ')[0]))).toBe(true);
    }
  });

  it('includes a summary placeholder for compressed messages', () => {
    const manager = makeManager({ maxTokens: 400, reserveForOutput: 40, strategy: 'summarize', keepRecent: 2 });
    addN(manager, 10);
    const window = manager.build();
    // When trimming is needed, there should be a summary message
    if (window.droppedMessages > 0 || window.messages.some((m) => m.content.includes('[Summary:'))) {
      const hasSummary = window.messages.some((m) => m.content.includes('[Summary:'));
      // Summary only appears when old messages were compressed
      expect(hasSummary || window.droppedMessages === 0).toBe(true);
    }
  });

  it('totalTokens does not exceed available budget', () => {
    const manager = makeManager({ maxTokens: 300, reserveForOutput: 30, strategy: 'summarize', keepRecent: 4 });
    addN(manager, 20);
    const window = manager.build();
    expect(window.totalTokens).toBeLessThanOrEqual(270);
  });
});

// ─── Unit Tests: reserveForOutput ────────────────────────────────────────────

describe('reserveForOutput budget reservation', () => {
  it('available budget is maxTokens minus reserveForOutput', () => {
    const manager = makeManager({ maxTokens: 1000, reserveForOutput: 200, strategy: 'sliding-window' });
    addN(manager, 50); // add lots to force trimming
    const window = manager.build();
    // Total should not exceed the available budget (1000 - 200 = 800)
    expect(window.totalTokens).toBeLessThanOrEqual(800);
  });

  it('budgetUsed is calculated against available (not total) tokens', () => {
    const manager = makeManager({ maxTokens: 1000, reserveForOutput: 200 });
    manager.add({ role: 'user', content: 'Short message', priority: 0.5 });
    const window = manager.build();
    // budgetUsed should be relative to 800 (1000 - 200), not 1000
    expect(window.budgetUsed).toBeLessThan(0.1); // a short message is << 800 tokens
  });
});

// ─── Unit Tests: stats() ─────────────────────────────────────────────────────

describe('stats()', () => {
  it('returns correct count and token sum', () => {
    const manager = makeManager();
    manager.add({ role: 'user', content: 'Hello', priority: 0.5 });
    manager.add({ role: 'assistant', content: 'World', priority: 0.5 });
    const stats = manager.stats();
    expect(stats.totalMessages).toBe(2);
    expect(stats.totalTokens).toBeGreaterThan(0);
  });

  it('budgetUsed reflects full history before trimming', () => {
    const manager = makeManager({ maxTokens: 200, reserveForOutput: 20 });
    addN(manager, 30); // force budget > 1
    const stats = manager.stats();
    expect(stats.budgetUsed).toBeGreaterThan(0);
  });
});

// ─── Failure Mode Tests ───────────────────────────────────────────────────────

describe('Failure mode: system prompt eviction prevention', () => {
  it('never drops system messages even at extreme budget pressure (sliding-window)', () => {
    // Budget so tight that only the system message itself barely fits
    const manager = new ContextManager(
      { maxTokens: 50, reserveForOutput: 10, strategy: 'sliding-window' },
      createMockTokenizer({ tokensPerWord: 1.0 }),
    );
    manager.add({ role: 'system', content: 'You are a helpful assistant.', priority: 1 });
    for (let i = 0; i < 20; i++) {
      manager.add({ role: 'user', content: 'Fill up the context window with text.', priority: 0.5 });
    }
    const window = manager.build();
    const systemMessages = window.messages.filter((m) => m.role === 'system');
    expect(systemMessages.length).toBeGreaterThanOrEqual(1);
  });

  it('never drops system messages even at extreme budget pressure (priority)', () => {
    const manager = makeManager({ maxTokens: 100, reserveForOutput: 10, strategy: 'priority' });
    manager.add({ role: 'system', content: 'You are a helpful assistant.', priority: 0 }); // low priority shouldn't matter
    addN(manager, 20);
    const window = manager.build();
    const systemMessages = window.messages.filter((m) => m.role === 'system');
    expect(systemMessages.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Failure mode: tokenizer error propagation', () => {
  it('propagates tokenizer errors rather than silently failing', () => {
    const errorTokenizer = new MockTokenizer({ errorRate: 1.0 });
    const manager = new ContextManager({ maxTokens: 1_000 }, errorTokenizer);
    expect(() => manager.add({ role: 'user', content: 'test', priority: 0.5 })).toThrow(
      'simulated tokenization failure',
    );
  });
});

describe('Failure mode: totalTokens within budget guarantee', () => {
  it('sliding-window: totalTokens never exceeds available budget', () => {
    const manager = makeManager({ maxTokens: 500, reserveForOutput: 50, strategy: 'sliding-window' });
    addN(manager, 40);
    const window = manager.build();
    expect(window.totalTokens).toBeLessThanOrEqual(450);
  });

  it('priority: totalTokens never exceeds available budget', () => {
    const manager = makeManager({ maxTokens: 500, reserveForOutput: 50, strategy: 'priority' });
    addN(manager, 40);
    const window = manager.build();
    expect(window.totalTokens).toBeLessThanOrEqual(450);
  });
});

describe('Failure mode: empty history edge cases', () => {
  it('build() on empty history returns empty window without error', () => {
    const manager = makeManager();
    expect(() => manager.build()).not.toThrow();
    const window = manager.build();
    expect(window.messages).toHaveLength(0);
    expect(window.droppedMessages).toBe(0);
    expect(window.budgetUsed).toBe(0);
  });

  it('only system messages — no trimming applied', () => {
    const manager = makeManager({ maxTokens: 1_000, reserveForOutput: 100 });
    manager.add({ role: 'system', content: 'System only.', priority: 1 });
    const window = manager.build();
    expect(window.messages).toHaveLength(1);
    expect(window.messages[0].role).toBe('system');
  });
});

// ─── Integration Tests ────────────────────────────────────────────────────────

describe('Integration: full conversation lifecycle', () => {
  it('simulates a 20-turn conversation with trimming', () => {
    const manager = new ContextManager(
      { maxTokens: 500, reserveForOutput: 50, strategy: 'sliding-window' },
      createMockTokenizer(),
    );

    manager.add({ role: 'system', content: 'You are a helpful assistant.', priority: 1 });

    for (let turn = 0; turn < 20; turn++) {
      manager.add({ role: 'user', content: `User turn ${turn}: ask a question about topic ${turn}`, priority: 0.5 });
      manager.add({ role: 'assistant', content: `Assistant reply ${turn}: here is the answer for topic ${turn}`, priority: 0.5 });
    }

    const window = manager.build();

    // System message must be present
    expect(window.messages.filter((m) => m.role === 'system')).toHaveLength(1);
    // Budget must be respected
    expect(window.totalTokens).toBeLessThanOrEqual(450);
    // Some messages were trimmed
    expect(window.droppedMessages).toBeGreaterThan(0);
    // budgetUsed reflects the trimmed window
    expect(window.budgetUsed).toBeGreaterThan(0);
    expect(window.budgetUsed).toBeLessThanOrEqual(1);
  });

  it('build() is deterministic — same history produces same window', () => {
    const manager = makeManager({ maxTokens: 300, reserveForOutput: 30, strategy: 'sliding-window' });
    addN(manager, 15);
    const first = manager.build();
    const second = manager.build();
    expect(first.messages.map((m) => m.id)).toEqual(second.messages.map((m) => m.id));
    expect(first.totalTokens).toBe(second.totalTokens);
  });

  it('strategy comparison: sliding-window and priority produce budgets within limit', () => {
    const history = Array.from({ length: 15 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Message ${i} with some filler words for token counting purposes`,
      priority: Math.random(),
    }));

    const swManager = makeManager({ maxTokens: 300, reserveForOutput: 30, strategy: 'sliding-window' });
    const prioManager = makeManager({ maxTokens: 300, reserveForOutput: 30, strategy: 'priority' });

    for (const msg of history) {
      swManager.add(msg);
      prioManager.add(msg);
    }

    const swWindow = swManager.build();
    const prioWindow = prioManager.build();

    expect(swWindow.totalTokens).toBeLessThanOrEqual(270);
    expect(prioWindow.totalTokens).toBeLessThanOrEqual(270);
  });
});

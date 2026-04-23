# Shared Utility: test-fixtures

A reusable mock LLM infrastructure library for testing all 35 production patterns. Every pattern's `mock-provider.ts` (or `mock_provider.py`) duplicated a subset of this interface — this utility extracts the canonical implementation so behavior is consistent across tests.

## What it provides

| Export | What it does |
|--------|-------------|
| `MockProvider` | Mock LLM with configurable latency, failure rate, error injection, and deterministic error sequences |
| `ProviderError` | Typed error carrying `statusCode` (HTTP-like) and optional `retryAfterMs` — same shape as real provider errors |
| `createStaticHandler` | Always returns the same content — the last resort in graceful degradation chains |
| `createCacheHandler` | Prompt-keyed in-memory cache. `populate(prompt, content)` seeds it; `clear()` resets it |
| `createRuleBasedHandler` | Regex-matched rule tiers — first match wins, throws on no match |
| `createSequenceProvider` | Returns responses from a fixed list in order, cycling when exhausted |
| `mockLLMStream` | Async generator simulating token streaming — honors abort signals, supports mid-stream error injection |
| `MockSlowConsumer` | Writable sink with configurable backpressure — mirrors the Node.js Writable stream interface |

## When to use this vs. writing a local mock

Use this library when a pattern needs mock LLM behavior. Don't write a new `mock-provider.ts` — the duplication is what this utility replaces.

Write a local mock only when a pattern needs mock behavior specific to its own internal types that can't be expressed through `LLMRequest`/`LLMResponse` (e.g., a pattern that wraps a multi-modal API with image inputs).

## Installation

This is a shared internal utility — import the source directly:

```typescript
// TypeScript
import { MockProvider, ProviderError, mockLLMStream } from '../../shared/test-fixtures/src/ts/index.js';
```

```python
# Python
from shared.test_fixtures import MockProvider, ProviderError, mock_llm_stream
```

## Usage

### MockProvider

```typescript
import { MockProvider, ProviderError } from '../../shared/test-fixtures/src/ts/index.js';

// Basic setup — 0ms latency for fast tests
const provider = new MockProvider({ latencyMs: 0 });
const res = await provider.call({ prompt: 'summarize this' });
// { content: 'Mock response for: summarize this', tokensUsed: 100, model: 'mock-model', finishReason: 'stop' }

// Scripted failure sequence — no Math.random() nondeterminism
const flaky = new MockProvider({
  latencyMs: 0,
  errorSequence: [503, 'success', 429],
  retryAfterMs: 1000,
});
// Call 1 → ProviderError (503)
// Call 2 → success
// Call 3 → ProviderError (429, retryAfterMs: 1000)
// Call 4+ → probabilistic (failureRate, default 0.0)

// Mid-test config changes — no new instance needed
provider.updateConfig({ failureRate: 1.0 });
await expect(provider.call(req)).rejects.toBeInstanceOf(ProviderError);

// Reset between test cases
provider.reset(); // clears callCount and sequence index
```

### createSequenceProvider

```typescript
import { createSequenceProvider } from '../../shared/test-fixtures/src/ts/index.js';

// Useful when the Nth call must return a specific response
const provider = createSequenceProvider(['first', 'second', 'fallback'], { latencyMs: 0 });
const r1 = await provider.call(req); // 'first'
const r2 = await provider.call(req); // 'second'
const r3 = await provider.call(req); // 'fallback'
const r4 = await provider.call(req); // cycles: 'first'

provider.callIndex; // 4
provider.reset();   // back to 0
```

### mockLLMStream

```typescript
import { mockLLMStream } from '../../shared/test-fixtures/src/ts/index.js';

// Collect all tokens
const chunks: string[] = [];
for await (const chunk of mockLLMStream({ tokenCount: 10, tokenDelayMs: 0 })) {
  chunks.push(chunk);
}

// Test mid-stream errors
const gen = mockLLMStream({ tokenCount: 100, tokenDelayMs: 0, errorAfterTokens: 5 });
// throws after emitting 5 tokens

// Test abort / cancellation
const controller = new AbortController();
for await (const chunk of mockLLMStream({ tokenCount: 1000, tokenDelayMs: 5 }, controller.signal)) {
  if (shouldStop) controller.abort(); // stream stops on next iteration
}
```

### createCacheHandler

```typescript
import { createCacheHandler } from '../../shared/test-fixtures/src/ts/index.js';

const { handler, populate, clear, size } = createCacheHandler();

// Seed the cache for test setup
populate('what is the capital of France?', 'Paris');

const res = await handler({ prompt: 'what is the capital of France?' });
// { content: 'Paris', finishReason: 'cache_hit' }

await handler({ prompt: 'unknown' }); // throws Error('Cache miss')
```

### MockSlowConsumer

```typescript
import { MockSlowConsumer } from '../../shared/test-fixtures/src/ts/index.js';

const consumer = new MockSlowConsumer(/* bufferCapacity= */ 5, /* drainDelayMs= */ 20);

let canWrite = consumer.write('chunk1'); // true — buffer has capacity
canWrite = consumer.write('chunk2');     // false — buffer full, drain pending

consumer.once('drain', () => {
  // Resume writing after drain
});
```

## Python equivalents

The Python API mirrors the TypeScript API with snake_case naming:

```python
from shared.test_fixtures import (
    MockProvider, ProviderError,
    create_static_handler, create_cache_handler,
    create_rule_based_handler, create_sequence_provider,
    mock_llm_stream, MockSlowConsumer,
)
from shared.test_fixtures.types import MockProviderConfig, MockStreamOptions, LLMRequest

import asyncio

async def example():
    provider = MockProvider(MockProviderConfig(latency_ms=0, tokens_per_response=42))
    res = await provider.call(LLMRequest(prompt="hello"))

    # Error sequences
    flaky = MockProvider(MockProviderConfig(
        latency_ms=0,
        error_sequence=[503, "success", 429],
        retry_after_ms=1000,
    ))

    # Streaming
    chunks = []
    async for token in mock_llm_stream(MockStreamOptions(token_count=5, token_delay_ms=0)):
        chunks.append(token)

    # Rule-based
    import re
    handler = create_rule_based_handler([
        (re.compile(r"hello", re.IGNORECASE), "Hi there!"),
        (re.compile(r".*"), "Fallback"),
    ])
    resp = await handler(LLMRequest(prompt="hello world"))
```

Key differences from TypeScript:
- `MockProvider.update_config(**kwargs)` instead of `updateConfig(partial)`
- `create_cache_handler()` returns a dict: `{ 'handler', 'populate', 'clear', 'size' }` where `size` is a callable
- `create_rule_based_handler` takes `List[Tuple[re.Pattern, str]]` — compile patterns with `re.compile()`
- `mock_llm_stream` accepts an `asyncio.Event` (`stop_event`) instead of `AbortSignal`
- `MockSlowConsumer.on_drain(callback)` instead of `.on('drain', callback)` / `.once('drain', callback)`

## How consuming patterns use it

### resilience/retry-with-budget

Uses `MockProvider` with `errorSequence` to script exact failure patterns — 2 × 503 then success — without relying on `Math.random()`. Uses `ProviderError.retryAfterMs` to test rate-limit retry timing.

### resilience/circuit-breaker

Uses `MockProvider.updateConfig({ failureRate: 1.0 })` mid-test to trip the circuit breaker, then `updateConfig({ failureRate: 0.0 })` to simulate recovery. Uses `reset()` between state machine tests.

### resilience/graceful-degradation

Uses `createStaticHandler` as the final tier in a degradation chain test. Uses `createCacheHandler` as the second tier, seeded with `populate()` in test setup.

### performance/streaming-backpressure

Uses `mockLLMStream` to simulate a fast upstream producer. Uses `MockSlowConsumer` to simulate a slow TCP sink, testing that the backpressure handler pauses production and resumes on drain.

## Running the tests

```bash
# TypeScript
cd shared/test-fixtures/src/ts
npm install
npm test

# Python
cd shared/test-fixtures/src/py
python -m pytest tests/ -v
```

## Design decisions

**Why `errorSequence` instead of only `failureRate`?** Probabilistic failures make tests flaky — a `failureRate: 0.3` test passes 70% of the time on the first call. `errorSequence` lets you script `[503, 'success', 429]` and get deterministic coverage of all retry paths in one test run.

**Why `createSequenceProvider` separately from `MockProvider`?** `MockProvider` covers failure injection. `createSequenceProvider` covers the case where you need call N to return a specific *successful* response — multi-turn flows, A/B comparisons, routing decisions. They compose: use a sequence provider as a stand-in for a real provider in a middleware under test.

**Why no singleton?** Singleton mocks create test coupling — state from one test leaks into the next. Each test constructs its own instance and calls `reset()` if it needs to reuse one across cases.

**Why mirror the Node.js Writable interface in `MockSlowConsumer`?** The streaming patterns use Node.js streams. A mock that mirrors the `write() → boolean`, `on('drain')` interface lets you test backpressure handling code paths without spinning up a real TCP connection or file stream.

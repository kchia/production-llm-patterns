# Shared Utility: latency-tracker

A minimal, reusable library for measuring LLM request latencies and computing percentile statistics. The stopwatch, percentile computation, and rolling-window logic were either duplicated or partially duplicated across `latency-budget`, `multi-provider-failover`, and `request-batching` — this utility extracts the common interface.

## What it provides

| Export | What it does |
|--------|-------------|
| `Stopwatch` | Wraps `performance.now()` (TS) / `time.perf_counter()` (Py) for precise, monotonic timing. Freeze-on-stop semantics so elapsed values don't drift after measurement. |
| `computeStats(samples)` | Pure function — computes p50, p95, p99, min, max, mean, count from an array of latency values using linear interpolation. |
| `LatencyAccumulator` | Accumulates latency samples grouped by label (provider name, step name, user ID). Returns `LatencyStats` per label on demand. |
| `SlidingWindowRecorder` | Fixed-capacity rolling window. Evicts oldest sample when full — useful for per-provider health tracking where stale data should age out. |

## When to use this vs. the latency-budget pattern

This utility measures and accumulates latency. It's the right choice when a pattern needs to time operations or compute percentiles but doesn't need deadline propagation.

Use the [latency-budget pattern](../../patterns/performance/latency-budget/) when you need:
- A propagated deadline passed through a multi-step pipeline
- Adaptive decisions based on remaining budget (skip optional steps, abort)
- Child budget scoping (parent deadline caps child deadlines)
- Step-level timeout enforcement

The `Stopwatch` in this utility and the `LatencyBudget` in that pattern serve different concerns — one measures, the other constrains.

## Installation

This is a shared internal utility — import the source directly, not from npm:

```typescript
// TypeScript
import { Stopwatch, computeStats, LatencyAccumulator, SlidingWindowRecorder } from '../../shared/latency-tracker/src/ts/index.js';
```

```python
# Python
from shared.latency_tracker import Stopwatch, compute_stats, LatencyAccumulator, SlidingWindowRecorder
```

## Usage

### TypeScript

```typescript
import { Stopwatch, LatencyAccumulator, SlidingWindowRecorder } from './shared/latency-tracker/src/ts/index.js';

const acc = new LatencyAccumulator();

// Time an LLM call and record it
const sw = Stopwatch.start();
const response = await provider.complete(request);
const latencyMs = sw.stop();

acc.record(latencyMs, 'provider-a');

// Get stats after a batch of requests
const stats = acc.stats('provider-a');
console.log(`p99: ${stats.p99Ms.toFixed(1)}ms  mean: ${stats.meanMs.toFixed(1)}ms  n=${stats.count}`);

// Per-provider rolling window (health tracking)
const window = new SlidingWindowRecorder(50);
window.record(latencyMs);
const healthStats = window.stats();
```

### Python

```python
from shared.latency_tracker import Stopwatch, LatencyAccumulator, SlidingWindowRecorder

acc = LatencyAccumulator()

# Time an LLM call and record it
sw = Stopwatch()
response = await provider.complete(request)
latency_ms = sw.stop()

acc.record(latency_ms, label="provider-a")

# Get stats after a batch of requests
stats = acc.stats("provider-a")
print(f"p99: {stats.p99_ms:.1f}ms  mean: {stats.mean_ms:.1f}ms  n={stats.count}")

# Per-provider rolling window
window = SlidingWindowRecorder(max_size=50)
window.record(latency_ms)
health_stats = window.stats()
```

## How consuming patterns use it

### latency-budget

The `LatencyBudget` class in that pattern uses `performance.now()` directly for its deadline arithmetic — it's a deadline propagator, not a recorder. The `Stopwatch` here is useful alongside it: time an individual step, then call `acc.record(sw.stop(), stepName)` to accumulate step-level latency distributions across many pipeline executions. Previously, each caller that wanted per-step histograms reinvented the measurement and percentile logic.

### multi-provider-failover

The pattern's `HealthWindow` class tracks `avgLatencyMs` per provider using a hand-rolled fixed-size array and average calculation. `SlidingWindowRecorder` replaces that internal class: same eviction semantics, plus `p95Ms` and `p99Ms` that the current `HealthWindow` doesn't expose. Tail latency is often more useful than average for deciding when a provider is degraded.

### request-batching

The pattern records `durationMs = Date.now() - startTime` for each batch job. `Stopwatch` provides a monotonic alternative (unaffected by clock adjustments during long batch runs), and `LatencyAccumulator` adds per-batch-size or per-provider breakdown when grouping by label.

## Wiring example: latency-budget + latency-tracker

```typescript
import { LatencyBudget, createStep } from '../patterns/performance/latency-budget/src/ts/index.js';
import { Stopwatch, LatencyAccumulator } from '../shared/latency-tracker/src/ts/index.js';

const acc = new LatencyAccumulator();

// Wrap each step to record its latency distribution
function timedStep<I, O>(name: string, fn: (input: I) => Promise<O>) {
  return createStep<I, O>(name, async (input, budget) => {
    const sw = Stopwatch.start();
    try {
      return await fn(input);
    } finally {
      acc.record(sw.stop(), name);
    }
  });
}

// After many pipeline executions:
const embeddingStats = acc.stats('embedding');
console.log(`embedding p99: ${embeddingStats.p99Ms.toFixed(0)}ms`);
```

## Wiring example: multi-provider-failover + latency-tracker

```typescript
import { FailoverRouter } from '../patterns/resilience/multi-provider-failover/src/ts/index.js';
import { SlidingWindowRecorder } from '../shared/latency-tracker/src/ts/index.js';

const windows = new Map<string, SlidingWindowRecorder>([
  ['openai', new SlidingWindowRecorder(50)],
  ['anthropic', new SlidingWindowRecorder(50)],
]);

const router = new FailoverRouter({
  providers: [
    {
      name: 'openai',
      handler: async (req) => {
        const sw = Stopwatch.start();
        const result = await openaiClient.complete(req);
        windows.get('openai')!.record(sw.stop());
        return result;
      },
    },
    // ...
  ],
});

// Health dashboard — sliding p99 per provider
for (const [name, window] of windows.entries()) {
  const s = window.stats();
  console.log(`${name}: p99=${s.p99Ms.toFixed(0)}ms  n=${s.count}`);
}
```

## Running the tests

```bash
# TypeScript
cd shared/latency-tracker/src/ts
npm install
npm test

# Python
cd shared/latency-tracker/src/py
python -m pytest tests/ -v
```

## Design decisions

**Why `performance.now()` and not `Date.now()`?** `Date.now()` is wall-clock time — it can jump backward or forward during NTP adjustments. `performance.now()` is monotonic and has sub-millisecond precision. For latency measurement, monotonic always wins. The Python equivalent is `time.perf_counter()`.

**Why linear interpolation for percentiles?** It's the default in NumPy, R, and most statistics libraries. The "nearest rank" method produces step-function artifacts at small sample sizes — linear interpolation gives smoother estimates that are easier to reason about in dashboards.

**Why not a singleton?** Same reason as cost-tracker — singletons create test coupling and make it hard to isolate different tracking contexts. Each instance owns its own state; callers decide scope.

**Why does `SlidingWindowRecorder` use `shift()` instead of a circular buffer?** Windows are typically small (10–200 entries). `shift()` on a small array is fast enough, and a circular buffer adds ~30 lines of non-obvious code. The comment in the source notes the tradeoff explicitly — if window sizes reach thousands of entries, replace with a circular buffer.

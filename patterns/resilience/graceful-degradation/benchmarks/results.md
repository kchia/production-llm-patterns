# Benchmark Results: Graceful Degradation

## Pattern Overhead (mock provider, 10K iterations)

### TypeScript

| Metric           | Without Pattern | With Pattern | Delta     |
| ---------------- | --------------- | ------------ | --------- |
| p50 latency      | 0.0002ms        | 0.0010ms     | +0.0008ms |
| p95 latency      | 0.0003ms        | 0.0011ms     | +0.0008ms |
| p99 latency      | 0.0004ms        | 0.0017ms     | +0.0013ms |
| Throughput (r/s) | 2,909,091       | 854,862      | -70.6%    |

**Note on throughput delta:** The -70.6% throughput reduction looks dramatic but is misleading in absolute terms. The "without pattern" case is a direct function call with ~0.0002ms latency — effectively measuring function call overhead alone. The "with pattern" case adds the degradation chain logic (health checks, timeout wrapping, metadata construction) at ~0.001ms per call. In real production usage where LLM calls take 200ms–5000ms, the pattern adds <0.002ms overhead — effectively zero.

### Memory

| Metric          | At Init | After 10K | Growth  |
| --------------- | ------- | --------- | ------- |
| Heap usage (MB) | 8.97    | 9.21      | +0.24MB |

Memory growth is minimal — the chain doesn't accumulate state across calls. The 0.24MB growth is GC churn from 10K `DegradationResult` objects, not retained state.

### Environment
- Machine: Apple Silicon (arm64)
- Node.js: v24.11.1
- Platform: darwin arm64
- Date: 2026-02-17
- Mock provider latency: 0ms (isolates pattern overhead)
- Warm-up: 1,000 iterations (discarded)

---

## Python

| Metric           | Without Pattern | With Pattern | Delta     |
| ---------------- | --------------- | ------------ | --------- |
| p50 latency      | 0.0005ms        | 0.0519ms     | +0.0514ms |
| p95 latency      | 0.0006ms        | 0.0723ms     | +0.0717ms |
| p99 latency      | 0.0007ms        | 0.1473ms     | +0.1466ms |
| Throughput (r/s) | 1,547,538       | 17,778       | -98.9%    |

**Note on Python overhead:** Python's `asyncio` event loop has higher per-call overhead than Node.js promises. The ~0.05ms p50 is ~50x the TypeScript overhead — but this is the cost of `asyncio.wait_for()` task scheduling, not the pattern logic itself. In production where LLM calls take 200ms–5000ms, 0.05ms is noise (<0.003% of a typical call).

### Memory

| Metric   | At Init  | After 10K | Growth  |
| -------- | -------- | --------- | ------- |
| RSS (MB) | 24.69    | 24.88     | +0.19MB |

### Environment
- Machine: Apple Silicon (arm64)
- Python: 3.11.5
- Platform: darwin arm64
- Date: 2026-02-17
- Mock provider latency: 0ms (isolates pattern overhead)
- Warm-up: 1,000 iterations (discarded)

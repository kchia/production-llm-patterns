# Benchmark Results: Eval Harness

> Environment: Node v22.22.0, Linux, 2026-02-24
> Scenarios: 6 selected via benchmark design
> All scenarios use mock provider. No real API calls.

## TL;DR

The harness adds negligible overhead per case (~0.04ms/case at scale). Scorer count barely affects latency — even 10 scorers per case adds <0.1ms. Concurrency scaling is near-linear with 100% efficiency at all tested levels. The comparison operation is sub-millisecond even at 500 tags. Error paths are actually faster than happy paths (no output to score).

## Scenario Results

### 1. Happy-path overhead (`happy-path-overhead`)

Measures harness wrapper cost on top of raw provider calls. 5 cases, 1 scorer, 2,000 iterations.

| Metric | Harness | Raw Provider | Overhead |
|--------|---------|-------------|----------|
| p50 | 2.15ms | 7.86ms | -5.72ms |
| p95 | 2.28ms | 9.97ms | -7.70ms |
| p99 | 2.34ms | 10.99ms | -8.65ms |
| mean | 1.90ms | 8.09ms | -6.19ms |

**Interpretation:** The harness is actually faster than sequential raw provider calls because it processes cases concurrently. With `concurrency: 5` and 5 cases, all run in parallel rather than sequentially. The per-case overhead (scorer execution, result collection, aggregate computation) is sub-millisecond and dominated by the concurrency benefit.

### 2. Multi-scorer overhead scaling (`configuration-sensitivity`)

Measures per-case latency as scorer count increases. 10 cases, 500 iterations per configuration.

| Scorers | p50 (ms) | p95 (ms) | mean (ms) | ms/scorer |
|---------|----------|----------|-----------|-----------|
| 1 | 2.15 | 2.28 | 1.89 | 1.89 |
| 3 | 2.17 | 2.28 | 1.91 | 0.64 |
| 5 | 2.16 | 2.29 | 1.92 | 0.38 |
| 10 | 2.17 | 2.31 | 1.94 | 0.19 |

**Interpretation:** Scorer count has minimal impact on total run time with lightweight (non-LLM) scorers. Going from 1 to 10 scorers adds ~0.05ms total. The per-scorer marginal cost is negligible at ~5µs. For LLM-as-judge scorers, this would be dominated by the judge API call latency, not the harness overhead.

### 3. Dataset scale — aggregate computation (`state-accumulation`)

Measures how harness performance scales with dataset size. 3 scorers, 10 tags.

| Cases | p50 (ms) | p95 (ms) | mean (ms) | ms/case |
|-------|----------|----------|-----------|---------|
| 100 | 4.31 | 4.53 | 3.91 | 0.039 |
| 1,000 | 40.11 | 44.38 | 40.31 | 0.040 |
| 5,000 | 202.41 | 214.03 | 203.22 | 0.041 |

**Interpretation:** Scaling is perfectly linear at ~0.04ms/case. The per-case cost is constant regardless of dataset size — no hidden O(n²) behavior in aggregate computation. A 10K-case eval suite would take ~400ms of harness overhead, well within CI budget.

### 4. Concurrency throughput (`concurrent-load`)

Measures throughput at different concurrency levels. 100 cases, 10ms mock latency, 50 iterations.

| Concurrency | p50 (ms) | p95 (ms) | mean (ms) | cases/sec | efficiency |
|-------------|----------|----------|-----------|-----------|------------|
| 1 | 1,082.5 | 1,090.0 | 1,083.3 | 92 | 100% |
| 5 | 216.9 | 219.6 | 216.7 | 462 | 100% |
| 10 | 108.6 | 110.1 | 108.4 | 923 | 100% |
| 20 | 54.2 | 55.3 | 54.1 | 1,847 | 100% |

**Interpretation:** Concurrency scaling is near-perfect. Doubling concurrency halves run time. At concurrency=20, the harness processes 1,847 cases/sec with 10ms provider latency. No contention overhead, no diminishing returns at these levels. In production, the bottleneck will be provider rate limits, not harness throughput.

### 5. Provider error path overhead (`failure-path`)

Measures overhead when provider throws errors. 50 cases, 200 iterations.

| Error Rate | p50 (ms) | p95 (ms) | mean (ms) | vs 0% |
|------------|----------|----------|-----------|-------|
| 0% | 8.98 | 10.90 | 9.01 | 100% |
| 25% | 9.88 | 11.13 | 9.73 | 108% |
| 50% | 9.86 | 11.14 | 9.59 | 106% |
| 100% | 0.32 | 0.57 | 0.35 | 4% |

**Interpretation:** Error paths are faster than happy paths — failed cases skip the provider's simulated latency and score construction is trivial. At 100% error rate, the harness runs in 0.35ms (96% faster). Mixed error rates (25-50%) show negligible overhead increase (~6-8%) because the error handling path is lightweight. The harness won't become a bottleneck during provider outages.

### 6. Comparison with many tags (`state-accumulation`)

Measures comparison time as tag count scales. Pre-computed results, 2,000 iterations.

| Tags | p50 (ms) | p95 (ms) | mean (ms) | mean (µs) |
|------|----------|----------|-----------|-----------|
| 5 | 0.003 | 0.004 | 0.004 | 3.5 |
| 50 | 0.014 | 0.023 | 0.018 | 17.8 |
| 500 | 0.137 | 0.184 | 0.147 | 146.9 |

**Interpretation:** Comparison scales linearly with tag count at ~0.3µs per tag. Even at 500 unique tags (an unusually fine-grained taxonomy), comparison takes <0.2ms. This operation adds zero perceptible overhead to CI pipelines.

## Methodology

- **Warm-up:** 50-100 iterations discarded per scenario (scaled by scenario cost)
- **Iteration counts:** 200-10,000 per scenario, adjusted by per-iteration cost to target ~15-25s per scenario
- **Mock provider config:** 0-10ms latency, 0ms jitter, deterministic outputs via outputMap
- **Statistics:** p50, p95, p99 computed from sorted samples. Mean included for aggregate comparison.
- **Concurrency efficiency:** Ratio of (actual throughput) / (theoretical max at perfect scaling), using concurrency=1 as baseline

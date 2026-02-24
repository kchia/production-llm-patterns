# Benchmark Scenarios: Eval Harness

## Analysis Source

- **Failure Modes table:** 6 rows (stale dataset, overfitted threshold, LLM-judge drift, non-determinism masking, silent baseline rot, scorer disagreement)
- **Implementation branching paths:** provider call → timeout → scorer loop → aggregate computation → comparison
- **State structures:** Results array, aggregate maps (overall + byTag), comparison delta maps
- **Config parameters with performance implications:** `concurrency` (parallelism), dataset size, scorer count

## Proposed Scenarios

| # | Scenario | Category | Rationale | Est. Runtime |
|---|----------|----------|-----------|-------------|
| 1 | Happy-path overhead | happy-path-overhead | Baseline: measure harness wrapper cost (scorer loop, aggregate computation) on top of provider latency. Answers "how much overhead does the eval harness add per case?" | ~15s |
| 2 | Multi-scorer overhead scaling | configuration-sensitivity | Each case runs N scorers sequentially. Measures how per-case latency scales with scorer count (1, 3, 5, 10 scorers). | ~20s |
| 3 | Dataset scale — aggregate computation | state-accumulation | Aggregate computation iterates all results and tags. Measures memory and time for aggregate/comparison at 100, 1K, 10K cases. | ~20s |
| 4 | Concurrency throughput | concurrent-load | Measures throughput at different concurrency levels (1, 5, 10, 20) against a mock provider with fixed latency. Answers "what's the optimal concurrency for a given provider rate limit?" | ~25s |
| 5 | Provider error path overhead | failure-path | When provider throws, the harness catches the error and creates zero-score results. Measures overhead of the error path vs happy path at 0%, 25%, 50%, 100% error rates. | ~15s |
| 6 | Comparison with many tags | state-accumulation | Comparison iterates all tags × all scorers. Measures comparison time with 5, 50, 500 unique tags. Catches O(tags × scorers) scaling issues. | ~10s |

### Excluded Scenarios (with rationale)

- **FM: Stale dataset** — correctness concern (dataset doesn't represent production), not a performance characteristic. No distinct latency or throughput signal.
- **FM: Overfitted threshold** — configuration correctness issue. `passes()` is a trivial comparison, no measurable overhead.
- **FM: LLM-judge drift** — quality concern about judge model behavior. Not a performance characteristic of the harness itself.
- **FM: Silent baseline rot** — correctness concern about baseline management policy. Comparison performance is covered by scenario 6.

## Scenario Definitions

### Scenario 1: Happy-path overhead
- **Category:** happy-path-overhead
- **Source:** Baseline measurement
- **Setup:** 5 cases, 1 scorer (exact match), mock provider with 1ms latency
- **Baseline:** Direct provider call without harness
- **Iterations:** 10,000
- **Key metrics:** p50/p95/p99 latency per case, overhead vs raw provider call

### Scenario 2: Multi-scorer overhead scaling
- **Category:** configuration-sensitivity
- **Source:** Scorer loop in evaluateCase()
- **Setup:** 10 cases, variable scorer count (1, 3, 5, 10)
- **Iterations:** 5,000 per configuration
- **Key metrics:** Per-case latency by scorer count, latency/scorer ratio

### Scenario 3: Dataset scale — aggregate computation
- **Category:** state-accumulation
- **Source:** computeAggregates() function, byTag map growth
- **Setup:** Variable dataset size (100, 1K, 10K cases), 3 scorers, 5 tags
- **Iterations:** 1,000 / 500 / 100 (scaled by dataset size)
- **Key metrics:** Aggregate computation time, memory delta, results array size

### Scenario 4: Concurrency throughput
- **Category:** concurrent-load
- **Source:** processInBatches() concurrency parameter
- **Setup:** 100 cases, 1 scorer, mock provider with 10ms latency, variable concurrency (1, 5, 10, 20)
- **Iterations:** 500 per configuration
- **Key metrics:** Total run time, effective throughput (cases/sec), concurrency efficiency ratio

### Scenario 5: Provider error path overhead
- **Category:** failure-path
- **Source:** Error catch in evaluateCase(), zero-score result construction
- **Setup:** 50 cases, 2 scorers, variable error rate (0%, 25%, 50%, 100%)
- **Iterations:** 2,000 per configuration
- **Key metrics:** Per-case latency by error rate, overhead vs happy path

### Scenario 6: Comparison with many tags
- **Category:** state-accumulation
- **Source:** compare() method, byTagDelta iteration
- **Setup:** Pre-computed results with variable tag count (5, 50, 500), 3 scorers
- **Iterations:** 10,000
- **Key metrics:** Comparison time by tag count, scaling factor

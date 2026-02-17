/**
 * Graceful Degradation — Tier 1 Overhead Benchmark
 *
 * Measures the latency overhead of the DegradationChain vs. direct provider calls.
 * Uses the mock provider — no API keys needed.
 *
 * Run: npx tsx bench.ts
 */

import { DegradationChain } from '../src/ts/index.js';
import {
  MockProvider,
  createCacheHandler,
  createRuleBasedHandler,
  createStaticHandler,
} from '../src/ts/mock-provider.js';
import type { DegradationTier, LLMRequest } from '../src/ts/types.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const WARMUP_ITERATIONS = 1_000;
const BENCHMARK_ITERATIONS = 10_000;
const MOCK_LATENCY_MS = 0; // Zero simulated latency to isolate pattern overhead

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const request: LLMRequest = { prompt: 'Benchmark test prompt' };

// Direct provider (no pattern)
const directProvider = new MockProvider({
  latencyMs: MOCK_LATENCY_MS,
  modelName: 'direct',
});

// Full 5-tier chain (with pattern)
const primaryProvider = new MockProvider({
  latencyMs: MOCK_LATENCY_MS,
  modelName: 'primary',
});

const fallbackProvider = new MockProvider({
  latencyMs: MOCK_LATENCY_MS,
  modelName: 'fallback',
});

const cache = createCacheHandler();
cache.populate('Benchmark test prompt', 'Cached response');

const tiers: DegradationTier[] = [
  {
    name: 'primary',
    handler: (req) => primaryProvider.call(req),
    qualityScore: 1.0,
    timeoutMs: 1000,
    isHealthy: () => true,
  },
  {
    name: 'fallback',
    handler: (req) => fallbackProvider.call(req),
    qualityScore: 0.7,
    timeoutMs: 1000,
  },
  {
    name: 'cache',
    handler: cache.handler,
    qualityScore: 0.5,
    timeoutMs: 500,
  },
  {
    name: 'rule-based',
    handler: createRuleBasedHandler([
      { pattern: /benchmark/i, response: 'Rule response' },
    ]),
    qualityScore: 0.3,
    timeoutMs: 100,
  },
  {
    name: 'static',
    handler: createStaticHandler('Static response'),
    qualityScore: 0.1,
    timeoutMs: 100,
  },
];

const chain = new DegradationChain({
  tiers,
  globalTimeoutMs: 5000,
});

// ---------------------------------------------------------------------------
// Benchmark utilities
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function benchmark(
  label: string,
  fn: () => Promise<void>,
  iterations: number
): Promise<{ p50: number; p95: number; p99: number; throughput: number }> {
  const latencies: number[] = [];

  const totalStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    latencies.push(performance.now() - start);
  }
  const totalMs = performance.now() - totalStart;

  latencies.sort((a, b) => a - b);

  const result = {
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    throughput: Math.round((iterations / totalMs) * 1000),
  };

  console.log(`\n${label}:`);
  console.log(`  p50:        ${result.p50.toFixed(4)}ms`);
  console.log(`  p95:        ${result.p95.toFixed(4)}ms`);
  console.log(`  p99:        ${result.p99.toFixed(4)}ms`);
  console.log(`  Throughput: ${result.throughput.toLocaleString()} req/s`);

  return result;
}

// ---------------------------------------------------------------------------
// Memory measurement (stateful pattern — cache + chain state)
// ---------------------------------------------------------------------------

function measureMemory(): { heapUsedMB: number; rss: number } {
  if (typeof process !== 'undefined' && process.memoryUsage) {
    const mem = process.memoryUsage();
    return {
      heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
      rss: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
    };
  }
  return { heapUsedMB: 0, rss: 0 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Graceful Degradation — Tier 1 Overhead Benchmark ===');
  console.log(`Warm-up: ${WARMUP_ITERATIONS.toLocaleString()} iterations`);
  console.log(`Benchmark: ${BENCHMARK_ITERATIONS.toLocaleString()} iterations`);
  console.log(`Mock provider latency: ${MOCK_LATENCY_MS}ms`);

  // Warm-up
  console.log('\nWarming up...');
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    await directProvider.call(request);
    await chain.execute(request);
  }

  // Memory at init
  const memInit = measureMemory();

  // Benchmark: without pattern
  const without = await benchmark(
    'Without Pattern (direct provider)',
    () => directProvider.call(request).then(() => {}),
    BENCHMARK_ITERATIONS
  );

  // Benchmark: with pattern (primary succeeds)
  const withPattern = await benchmark(
    'With Pattern (5-tier chain, primary succeeds)',
    () => chain.execute(request).then(() => {}),
    BENCHMARK_ITERATIONS
  );

  // Memory after benchmark
  const memAfter = measureMemory();

  // Delta
  console.log('\n--- Delta ---');
  console.log(`  p50:        +${(withPattern.p50 - without.p50).toFixed(4)}ms`);
  console.log(`  p95:        +${(withPattern.p95 - without.p95).toFixed(4)}ms`);
  console.log(`  p99:        +${(withPattern.p99 - without.p99).toFixed(4)}ms`);
  const throughputDelta = ((withPattern.throughput - without.throughput) / without.throughput * 100).toFixed(1);
  console.log(`  Throughput: ${throughputDelta}%`);

  // Memory
  console.log('\n--- Memory ---');
  console.log(`  Heap at init:     ${memInit.heapUsedMB} MB`);
  console.log(`  Heap after bench: ${memAfter.heapUsedMB} MB`);
  console.log(`  Growth:           ${(memAfter.heapUsedMB - memInit.heapUsedMB).toFixed(2)} MB`);

  // Environment
  console.log('\n--- Environment ---');
  console.log(`  Node.js: ${process.version}`);
  console.log(`  Platform: ${process.platform} ${process.arch}`);
  console.log(`  Date: ${new Date().toISOString().slice(0, 10)}`);

  // Machine-readable output
  console.log('\n--- JSON ---');
  console.log(JSON.stringify({
    without,
    withPattern,
    delta: {
      p50: +(withPattern.p50 - without.p50).toFixed(4),
      p95: +(withPattern.p95 - without.p95).toFixed(4),
      p99: +(withPattern.p99 - without.p99).toFixed(4),
      throughputPercent: +throughputDelta,
    },
    memory: {
      initMB: memInit.heapUsedMB,
      afterMB: memAfter.heapUsedMB,
      growthMB: +(memAfter.heapUsedMB - memInit.heapUsedMB).toFixed(2),
    },
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      date: new Date().toISOString().slice(0, 10),
    },
  }, null, 2));
}

main().catch(console.error);

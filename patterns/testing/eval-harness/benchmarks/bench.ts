/**
 * Eval Harness Benchmarks
 *
 * Runs 6 scenarios from benchmarks/scenarios.md.
 * All scenarios use mock provider — no real API calls.
 */

import {
  EvalHarness,
  exactMatchScorer,
  containsScorer,
  lengthScorer,
  customScorer,
} from "../src/ts/index";
import { createMockProvider } from "../src/ts/mock-provider";
import type { EvalCase, EvalRunResult, Scorer } from "../src/ts/types";

// --- Utilities ---

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function makeDataset(count: number, tagCount = 5): EvalCase[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `case-${i}`,
    input: `input-${i}`,
    expected: `output-${i}`,
    tags: [`tag-${i % tagCount}`],
  }));
}

function makeSimpleScorers(count: number): Scorer[] {
  return Array.from({ length: count }, (_, i) =>
    customScorer(`scorer-${i}`, (_input, output, expected) => {
      return output === expected ? 1 : 0;
    })
  );
}

// --- Scenario 1: Happy-path overhead ---

async function scenario1() {
  console.log("\n## Scenario 1: Happy-path overhead\n");

  const dataset = makeDataset(5);
  const outputMap = new Map(dataset.map((c) => [c.input, c.expected!]));
  const provider = createMockProvider({
    outputMap,
    latencyMs: 1,
    latencyJitterMs: 0,
  });

  // Warmup
  for (let i = 0; i < 100; i++) {
    const h = new EvalHarness({
      dataset,
      scorers: [exactMatchScorer()],
      provider,
      concurrency: 5,
    });
    await h.run();
  }

  // Measure harness runs
  const iterations = 2000;
  const harnessTimings: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const h = new EvalHarness({
      dataset,
      scorers: [exactMatchScorer()],
      provider,
      concurrency: 5,
    });
    const start = performance.now();
    await h.run();
    harnessTimings.push(performance.now() - start);
  }

  // Measure raw provider calls
  const rawTimings: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    for (const c of dataset) {
      await provider(c.input);
    }
    rawTimings.push(performance.now() - start);
  }

  const harnessStats = stats(harnessTimings);
  const rawStats = stats(rawTimings);

  console.log("| Metric | Harness | Raw Provider | Overhead |");
  console.log("|--------|---------|-------------|----------|");
  console.log(
    `| p50 | ${harnessStats.p50.toFixed(2)}ms | ${rawStats.p50.toFixed(2)}ms | ${(harnessStats.p50 - rawStats.p50).toFixed(2)}ms |`
  );
  console.log(
    `| p95 | ${harnessStats.p95.toFixed(2)}ms | ${rawStats.p95.toFixed(2)}ms | ${(harnessStats.p95 - rawStats.p95).toFixed(2)}ms |`
  );
  console.log(
    `| p99 | ${harnessStats.p99.toFixed(2)}ms | ${rawStats.p99.toFixed(2)}ms | ${(harnessStats.p99 - rawStats.p99).toFixed(2)}ms |`
  );
  console.log(
    `| mean | ${harnessStats.mean.toFixed(2)}ms | ${rawStats.mean.toFixed(2)}ms | ${(harnessStats.mean - rawStats.mean).toFixed(2)}ms |`
  );

  return { harnessStats, rawStats };
}

// --- Scenario 2: Multi-scorer overhead scaling ---

async function scenario2() {
  console.log("\n## Scenario 2: Multi-scorer overhead scaling\n");

  const dataset = makeDataset(10);
  const outputMap = new Map(dataset.map((c) => [c.input, c.expected!]));
  const provider = createMockProvider({
    outputMap,
    latencyMs: 1,
    latencyJitterMs: 0,
  });

  const scorerCounts = [1, 3, 5, 10];
  const iterations = 500;

  console.log("| Scorers | p50 (ms) | p95 (ms) | mean (ms) | ms/scorer |");
  console.log("|---------|----------|----------|-----------|-----------|");

  for (const count of scorerCounts) {
    const scorers = makeSimpleScorers(count);

    // Warmup
    for (let i = 0; i < 50; i++) {
      const h = new EvalHarness({ dataset, scorers, provider, concurrency: 10 });
      await h.run();
    }

    const timings: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const h = new EvalHarness({ dataset, scorers, provider, concurrency: 10 });
      const start = performance.now();
      await h.run();
      timings.push(performance.now() - start);
    }

    const s = stats(timings);
    const perScorer = s.mean / count;
    console.log(
      `| ${count} | ${s.p50.toFixed(2)} | ${s.p95.toFixed(2)} | ${s.mean.toFixed(2)} | ${perScorer.toFixed(2)} |`
    );
  }
}

// --- Scenario 3: Dataset scale — aggregate computation ---

async function scenario3() {
  console.log("\n## Scenario 3: Dataset scale — aggregate computation\n");

  const sizes = [100, 1000, 5000];
  const iterationsPerSize = [200, 50, 10];

  console.log("| Cases | p50 (ms) | p95 (ms) | mean (ms) | ms/case |");
  console.log("|-------|----------|----------|-----------|---------|");

  for (let si = 0; si < sizes.length; si++) {
    const size = sizes[si];
    const iterations = iterationsPerSize[si];

    const dataset = makeDataset(size, 10);
    const outputMap = new Map(dataset.map((c) => [c.input, c.expected!]));
    const provider = createMockProvider({
      outputMap,
      latencyMs: 0,
      latencyJitterMs: 0,
    });

    // Warmup
    for (let i = 0; i < 3; i++) {
      const h = new EvalHarness({
        dataset,
        scorers: makeSimpleScorers(3),
        provider,
        concurrency: 50,
      });
      await h.run();
    }

    const timings: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const h = new EvalHarness({
        dataset,
        scorers: makeSimpleScorers(3),
        provider,
        concurrency: 50,
      });
      const start = performance.now();
      await h.run();
      timings.push(performance.now() - start);
    }

    const s = stats(timings);
    console.log(
      `| ${size} | ${s.p50.toFixed(2)} | ${s.p95.toFixed(2)} | ${s.mean.toFixed(2)} | ${(s.mean / size).toFixed(4)} |`
    );
  }
}

// --- Scenario 4: Concurrency throughput ---

async function scenario4() {
  console.log("\n## Scenario 4: Concurrency throughput\n");

  const dataset = makeDataset(100);
  const outputMap = new Map(dataset.map((c) => [c.input, c.expected!]));
  const provider = createMockProvider({
    outputMap,
    latencyMs: 10,
    latencyJitterMs: 0,
  });

  const concurrencyLevels = [1, 5, 10, 20];
  const iterations = 50;

  console.log(
    "| Concurrency | p50 (ms) | p95 (ms) | mean (ms) | cases/sec | efficiency |"
  );
  console.log(
    "|-------------|----------|----------|-----------|-----------|------------|"
  );

  let baselineCasesPerSec = 0;

  for (const conc of concurrencyLevels) {
    // Warmup
    for (let i = 0; i < 5; i++) {
      const h = new EvalHarness({
        dataset,
        scorers: [exactMatchScorer()],
        provider,
        concurrency: conc,
      });
      await h.run();
    }

    const timings: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const h = new EvalHarness({
        dataset,
        scorers: [exactMatchScorer()],
        provider,
        concurrency: conc,
      });
      const start = performance.now();
      await h.run();
      timings.push(performance.now() - start);
    }

    const s = stats(timings);
    const casesPerSec = (100 / s.mean) * 1000;
    if (conc === 1) baselineCasesPerSec = casesPerSec;
    const efficiency = casesPerSec / (baselineCasesPerSec * conc);

    console.log(
      `| ${conc} | ${s.p50.toFixed(1)} | ${s.p95.toFixed(1)} | ${s.mean.toFixed(1)} | ${casesPerSec.toFixed(0)} | ${(efficiency * 100).toFixed(0)}% |`
    );
  }
}

// --- Scenario 5: Provider error path overhead ---

async function scenario5() {
  console.log("\n## Scenario 5: Provider error path overhead\n");

  const dataset = makeDataset(50);
  const errorRates = [0, 0.25, 0.5, 1.0];
  const iterations = 200;

  console.log("| Error Rate | p50 (ms) | p95 (ms) | mean (ms) | vs 0% |");
  console.log("|------------|----------|----------|-----------|-------|");

  let baseMean = 0;

  for (const rate of errorRates) {
    const outputMap = new Map(dataset.map((c) => [c.input, c.expected!]));
    const provider = createMockProvider({
      outputMap,
      latencyMs: 1,
      latencyJitterMs: 0,
      errorRate: rate,
    });

    // Warmup
    for (let i = 0; i < 20; i++) {
      const h = new EvalHarness({
        dataset,
        scorers: [exactMatchScorer()],
        provider,
        concurrency: 10,
      });
      await h.run();
    }

    const timings: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const h = new EvalHarness({
        dataset,
        scorers: [exactMatchScorer()],
        provider,
        concurrency: 10,
      });
      const start = performance.now();
      await h.run();
      timings.push(performance.now() - start);
    }

    const s = stats(timings);
    if (rate === 0) baseMean = s.mean;
    const ratio = baseMean > 0 ? ((s.mean / baseMean) * 100).toFixed(0) : "—";

    console.log(
      `| ${(rate * 100).toFixed(0)}% | ${s.p50.toFixed(2)} | ${s.p95.toFixed(2)} | ${s.mean.toFixed(2)} | ${ratio}% |`
    );
  }
}

// --- Scenario 6: Comparison with many tags ---

async function scenario6() {
  console.log("\n## Scenario 6: Comparison with many tags\n");

  const tagCounts = [5, 50, 500];
  const iterations = 2000;
  const scorerCount = 3;

  console.log("| Tags | p50 (ms) | p95 (ms) | mean (ms) | mean (µs) |");
  console.log("|------|----------|----------|-----------|-----------|");

  for (const tagCount of tagCounts) {
    const dataset = makeDataset(Math.max(tagCount * 2, 100), tagCount);
    const outputMap = new Map(dataset.map((c) => [c.input, c.expected!]));
    const provider = createMockProvider({
      outputMap,
      latencyMs: 0,
      latencyJitterMs: 0,
    });

    const scorers = makeSimpleScorers(scorerCount);

    // Generate two runs to compare
    const h = new EvalHarness({ dataset, scorers, provider, concurrency: 100 });
    const baseline = await h.run();
    const current = await h.run();

    // Warmup comparison
    for (let i = 0; i < 100; i++) {
      h.compare(baseline, current);
    }

    const timings: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      h.compare(baseline, current);
      timings.push(performance.now() - start);
    }

    const s = stats(timings);
    console.log(
      `| ${tagCount} | ${s.p50.toFixed(4)} | ${s.p95.toFixed(4)} | ${s.mean.toFixed(4)} | ${(s.mean * 1000).toFixed(1)} |`
    );
  }
}

// --- Main ---

async function main() {
  console.log("# Benchmark Results: Eval Harness\n");
  console.log(
    `> Environment: Node ${process.version}, ${new Date().toISOString()}`
  );
  console.log("> All scenarios use mock provider. No real API calls.\n");

  await scenario1();
  await scenario2();
  await scenario3();
  await scenario4();
  await scenario5();
  await scenario6();

  console.log("\n---\nBenchmarks complete.");
}

main().catch(console.error);

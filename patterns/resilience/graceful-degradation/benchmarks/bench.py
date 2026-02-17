"""
Graceful Degradation — Tier 1 Overhead Benchmark (Python)

Measures the latency overhead of the DegradationChain vs. direct provider calls.
Uses the mock provider — no API keys needed.

Run: python benchmarks/bench.py  (from the pattern directory)
"""

import asyncio
import json
import platform
import sys
import time
from datetime import date
from pathlib import Path

# Add src/ to path so we can import the package
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import re

from py import DegradationChain
from py.mock_provider import (
    MockProvider,
    create_cache_handler,
    create_rule_based_handler,
    create_static_handler,
)
from py.types import DegradationTier, LLMRequest

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

WARMUP_ITERATIONS = 1_000
BENCHMARK_ITERATIONS = 10_000
MOCK_LATENCY_MS = 0  # Zero simulated latency to isolate pattern overhead

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

request = LLMRequest(prompt="Benchmark test prompt")

direct_provider = MockProvider(latency_ms=MOCK_LATENCY_MS, model_name="direct")

primary_provider = MockProvider(latency_ms=MOCK_LATENCY_MS, model_name="primary")
fallback_provider = MockProvider(latency_ms=MOCK_LATENCY_MS, model_name="fallback")

cache = create_cache_handler()
cache.populate("Benchmark test prompt", "Cached response")

tiers = [
    DegradationTier(
        name="primary",
        handler=primary_provider.call,
        quality_score=1.0,
        timeout_ms=1000,
        is_healthy=lambda: True,
    ),
    DegradationTier(
        name="fallback",
        handler=fallback_provider.call,
        quality_score=0.7,
        timeout_ms=1000,
    ),
    DegradationTier(
        name="cache",
        handler=cache.handler,
        quality_score=0.5,
        timeout_ms=500,
    ),
    DegradationTier(
        name="rule-based",
        handler=create_rule_based_handler([
            (re.compile(r"benchmark", re.IGNORECASE), "Rule response"),
        ]),
        quality_score=0.3,
        timeout_ms=100,
    ),
    DegradationTier(
        name="static",
        handler=create_static_handler("Static response"),
        quality_score=0.1,
        timeout_ms=100,
    ),
]

chain = DegradationChain(tiers=tiers, global_timeout_ms=5000)


# ---------------------------------------------------------------------------
# Benchmark utilities
# ---------------------------------------------------------------------------


def percentile(sorted_values: list[float], p: float) -> float:
    idx = max(0, int((p / 100) * len(sorted_values)) - 1)
    return sorted_values[idx]


async def benchmark(label: str, fn, iterations: int) -> dict:
    latencies: list[float] = []

    total_start = time.perf_counter()
    for _ in range(iterations):
        start = time.perf_counter()
        await fn()
        latencies.append((time.perf_counter() - start) * 1000)  # ms
    total_s = time.perf_counter() - total_start

    latencies.sort()

    result = {
        "p50": percentile(latencies, 50),
        "p95": percentile(latencies, 95),
        "p99": percentile(latencies, 99),
        "throughput": round(iterations / total_s),
    }

    print(f"\n{label}:")
    print(f"  p50:        {result['p50']:.4f}ms")
    print(f"  p95:        {result['p95']:.4f}ms")
    print(f"  p99:        {result['p99']:.4f}ms")
    print(f"  Throughput: {result['throughput']:,} req/s")

    return result


# ---------------------------------------------------------------------------
# Memory measurement
# ---------------------------------------------------------------------------

def measure_memory() -> dict:
    try:
        import resource
        rusage = resource.getrusage(resource.RUSAGE_SELF)
        rss_mb = rusage.ru_maxrss / (1024 * 1024)  # macOS reports in bytes
        return {"rss_mb": round(rss_mb, 2)}
    except ImportError:
        return {"rss_mb": 0}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main():
    print("=== Graceful Degradation — Tier 1 Overhead Benchmark (Python) ===")
    print(f"Warm-up: {WARMUP_ITERATIONS:,} iterations")
    print(f"Benchmark: {BENCHMARK_ITERATIONS:,} iterations")
    print(f"Mock provider latency: {MOCK_LATENCY_MS}ms")

    # Warm-up
    print("\nWarming up...")
    for _ in range(WARMUP_ITERATIONS):
        await direct_provider.call(request)
        await chain.execute(request)

    mem_init = measure_memory()

    # Benchmark: without pattern
    without = await benchmark(
        "Without Pattern (direct provider)",
        lambda: direct_provider.call(request),
        BENCHMARK_ITERATIONS,
    )

    # Benchmark: with pattern
    with_pattern = await benchmark(
        "With Pattern (5-tier chain, primary succeeds)",
        lambda: chain.execute(request),
        BENCHMARK_ITERATIONS,
    )

    mem_after = measure_memory()

    # Delta
    print("\n--- Delta ---")
    print(f"  p50:        +{with_pattern['p50'] - without['p50']:.4f}ms")
    print(f"  p95:        +{with_pattern['p95'] - without['p95']:.4f}ms")
    print(f"  p99:        +{with_pattern['p99'] - without['p99']:.4f}ms")
    throughput_delta = (
        (with_pattern["throughput"] - without["throughput"])
        / without["throughput"]
        * 100
    )
    print(f"  Throughput: {throughput_delta:.1f}%")

    # Memory
    print("\n--- Memory ---")
    print(f"  RSS at init:     {mem_init['rss_mb']} MB")
    print(f"  RSS after bench: {mem_after['rss_mb']} MB")

    # Environment
    print("\n--- Environment ---")
    print(f"  Python: {sys.version.split()[0]}")
    print(f"  Platform: {sys.platform} {platform.machine()}")
    print(f"  Date: {date.today().isoformat()}")

    # Machine-readable output
    print("\n--- JSON ---")
    print(json.dumps({
        "without": without,
        "withPattern": with_pattern,
        "delta": {
            "p50": round(with_pattern["p50"] - without["p50"], 4),
            "p95": round(with_pattern["p95"] - without["p95"], 4),
            "p99": round(with_pattern["p99"] - without["p99"], 4),
            "throughputPercent": round(throughput_delta, 1),
        },
        "memory": {
            "initMB": mem_init["rss_mb"],
            "afterMB": mem_after["rss_mb"],
        },
        "environment": {
            "python": sys.version.split()[0],
            "platform": f"{sys.platform} {platform.machine()}",
            "date": date.today().isoformat(),
        },
    }, indent=2))


if __name__ == "__main__":
    asyncio.run(main())

# Index Maintenance

> **Part of [Production LLM Patterns](../../../README.md).** Each pattern covers a specific production concern with architecture, dual implementations (TypeScript + Python), failure modes, cost analysis, and operational guidance. [How to read a pattern →](../../../README.md#if-you-landed-on-a-specific-pattern)

## The Problem

Vector indexes accumulate garbage. Every document deletion leaves a tombstone — a soft-delete marker that still occupies memory and pollutes the graph structure. Every bulk ingestion spawns dozens of small segments that each add per-lookup overhead. Every HNSW index that's never been compacted gradually loses its "small world" properties as the graph drifts from its optimal structure.

The failure mode is silent. Query latency creeps up a few milliseconds a week — in one workload, roughly 5ms. Recall@10 can drop from 0.82 to 0.67 over three months in a collection with moderate churn. No alert fires. Customers just get worse answers and you don't know why until someone digs into it. By the time you notice, the index has months of accumulated cruft and a rebuild takes hours.

In [HNSW](https://arxiv.org/abs/1603.09320) specifically, deletions create ["unreachable points"](https://arxiv.org/abs/2407.07871) — nodes disconnected from the navigable graph. The graph's small-world properties degrade. Search still returns results, but it's routing around gaps, missing better matches that exist but can't be reached. [Qdrant's vacuum optimizer](https://qdrant.tech/documentation/concepts/optimizer/) triggers cleanup at 20% deleted vectors (its `deleted_threshold` default), but if your deletion rate is lower or you've never configured it, that threshold is never hit and the dead weight just accumulates.

## What I Would Not Do

The instinct most teams have is to either ignore maintenance entirely ("the vector DB handles it") or to schedule full index rebuilds on a cron job. Both approaches have sharp edges.

Ignoring maintenance assumes your vector DB's automatic background processes are sufficient for your workload. For static or low-churn collections, that might be true. For collections with active document management — content that gets updated, removed, or refreshed — background processes have configurable thresholds designed for average-case workloads. A collection that sees 500 document updates per day but has a 200K-vector floor will hit the 20% deletion threshold differently than one with 10K vectors. The defaults aren't calibrated to your specific churn rate.

Full rebuilds fix the problem, but at the wrong granularity. A complete index rebuild at 500K vectors takes 20–60 minutes on a mid-range cloud instance (4–8 vCPU, 16–32 GB RAM), blocks or degrades reads during reconstruction, and consumes significant CPU and memory. Doing this daily to handle a 0.5% document churn rate is like rebooting a server to clear a temporary file. The specific failure: scheduled rebuilds tend to run at off-peak hours, but the index degrades throughout the day as churn accumulates. At 100K req/day with a 2% daily document turnover, you're accumulating ~2,000 tombstones between rebuilds — not enough to trigger a visible recall drop, but enough to add 10–20ms to p95 latency after six months.

## When You Need This

- Your vector collection has active document churn — anything updated, deleted, or replaced rather than append-only
- You've been running your vector store for 3+ months without explicit maintenance configuration
- Query p95 latency is increasing without corresponding load increases (tombstone accumulation, not query volume)
- Retrieval recall is degrading — the documents exist, embeddings are fresh, but they're not surfacing in top-k results
- Bulk ingestion operations leave behind dozens of small segments (startup time and memory usage creeping up)
- The collection was seeded with a large initial batch and has seen significant deletion since

**Priority by system type** (from the [Navigation Matrix](../../../README.md#navigation-matrix)):

- **RAG → Required.** The entire value proposition of RAG depends on retrieval quality. I wouldn't want to operate a RAG system with mutable documents without explicit index maintenance — a 15% recall drop is invisible at first and devastating at month three.
- **Batch → Recommended.** Batch systems often do heavy document turnover during processing cycles. Index fragmentation adds latency to retrieval steps in each batch run. Worth addressing once batch jobs start taking longer than expected.
- **Agents → Optional.** Agents typically query a managed knowledge base that's append-heavy. If the agent's vector store sees low document churn, the default background maintenance in most vector DBs is probably adequate.
- **Streaming → N/A.** Streaming patterns don't interact with vector search indexes in the same way; real-time token delivery doesn't depend on index health.

## The Pattern

### Architecture

```
   Scheduler tick (or manual trigger)
              │
              ▼
   ┌──────────────────────┐
1. │    Health Checker    │  ← queries collection stats API
   └──────────┬───────────┘
              │ {tombstone_ratio, segment_count,
              │  avg_segment_size, payload_coverage}
              ▼
   ┌──────────────────────┐
2. │ Threshold Evaluator  │
   └──────────┬───────────┘
              │
       ┌──────┴──────┐
       │             │
   all OK?        thresholds exceeded?
       │             │
       ▼             ▼
   [skip]   ┌──────────────────────┐
         3. │  Maintenance Planner │
            └──────────┬───────────┘
                       │ ordered operation list
                       ▼
            ┌──────────────────────┐
         4. │  Operation Executor  │
            └──────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
       vacuum     compact      optimize_
                  segments     payload_idx

Metrics emitted: run_duration_ms, ops_executed,
tombstone_ratio_before/after, segment_count_before/after
```

> Threshold defaults (tombstone_ratio: 0.15, max_segments: 20) are illustrative starting points. The right values depend on your collection size, churn rate, and query SLA.

### Core Abstraction

The `IndexMaintenanceScheduler` coordinates three responsibilities: measuring index health, deciding what operations are needed, and executing them without disrupting reads.

```typescript
interface IndexHealthMetrics {
  tombstoneRatio: number; // deleted vectors / total vectors
  segmentCount: number; // active segments (fragmentation proxy)
  avgSegmentSize: number; // vectors per segment
  payloadIndexCoverage: number; // fraction of filter fields with indexes
  lastMaintenanceMs: number; // time since last maintenance run
}

type MaintenanceOperation =
  | { type: "vacuum"; reason: string }
  | { type: "compact_segments"; reason: string }
  | { type: "optimize_payload_index"; fields: string[]; reason: string }
  | { type: "rebuild"; reason: string };

interface IndexMaintenanceScheduler {
  checkHealth(collectionName: string): Promise<IndexHealthMetrics>;
  planMaintenance(metrics: IndexHealthMetrics): MaintenanceOperation[];
  runMaintenance(collectionName: string): Promise<MaintenanceResult>;
}
```

### TypeScript Implementation

See [`src/ts/`](src/ts/) for the full implementation.

### Python Implementation

See [`src/py/`](src/py/) for the full implementation.

## Failure Modes

| Failure Mode                                                                                                                                                                        | Detection Signal                                                                                    | Mitigation                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Maintenance during high traffic** — running compaction or vacuum during peak load degrades query latency as the optimizer competes for I/O                                        | p95 latency spike during maintenance window; CPU > 80% during scheduled run                         | Schedule maintenance during low-traffic windows; implement a traffic gate that delays maintenance if request rate exceeds threshold                    |
| **Vacuum loop** — maintenance triggers, tombstone ratio drops below threshold, document churn creates new tombstones faster than cleanup, maintenance triggers again within minutes | Maintenance run frequency metric shows runs < 10 min apart; CPU consistently elevated               | Add a minimum interval between maintenance runs (cooldown period); alert if maintenance frequency exceeds 1 run/hour                                   |
| **Rebuild blocking reads** — full index rebuild on large collections (500K+ vectors) takes 20–60 min; if the operation blocks reads, users see timeout errors                       | Query error rate spike during rebuild; p99 latency > 10× normal                                     | Use shadow index pattern: build new index on a copy, then atomically swap; never rebuild in place on live traffic                                      |
| **Payload index drift** — new filter fields added to queries but not indexed; queries fall back to full scans silently                                                              | Queries with new filter fields take 10–100× longer than indexed equivalents; no error, just latency | Track filter field usage in query logs; compare against indexed fields; alert when unindexed filter fields appear in production queries                |
| **Silent recall degradation** — tombstones accumulate below the vacuum threshold for months; recall drops 10–20% before maintenance triggers                                        | Recall@10 in offline eval drifts downward over weeks; no operational alert fires                    | Run scheduled offline recall evaluation against a held-out query set; alert on 5% week-over-week recall drop; don't rely solely on operational metrics |
| **Segment explosion from bulk ingest** — batch loading creates dozens of small segments; each adds per-lookup overhead; startup time and memory grow                                | Segment count metric > 50; memory usage per query increases; startup time > 2× baseline             | Trigger segment compaction after bulk ingest completes; configure ingest batch sizes to target fewer, larger segments                                  |

## Observability & Operations

### Key Metrics

| Metric                        | Collection Method                               | Normal Range                              | Meaning                                                      |
| ----------------------------- | ----------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| `tombstone_ratio`             | Vector DB API (collection stats)                | < 0.10                                    | Fraction of vectors marked deleted but not yet cleaned       |
| `segment_count`               | Vector DB API or internal metrics               | < 20                                      | Fragmentation proxy; high count increases per-query overhead |
| `maintenance_run_duration_ms` | Instrumented in scheduler                       | < 60s (vacuum), < 5min (compact)          | Tracks whether maintenance is keeping up with churn          |
| `recall_at_10_offline`        | Scheduled eval harness against held-out queries | > 0.80 (varies by use case)               | The only metric that catches silent graph degradation        |
| `query_p95_latency_ms`        | APM / trace spans                               | Establish baseline; alert on 20% increase | Early signal for fragmentation or tombstone accumulation     |
| `maintenance_frequency`       | Counter per run type                            | < 1 vacuum/hour                           | Detects vacuum loops                                         |

### Alerting

| Alert                          | Threshold              | Severity | First Check                                                                             |
| ------------------------------ | ---------------------- | -------- | --------------------------------------------------------------------------------------- |
| Tombstone ratio high           | > 0.20 for 30 min      | Warning  | Run manual vacuum; check if churn rate has increased                                    |
| Tombstone ratio critical       | > 0.40                 | Critical | Vacuum immediately; investigate whether document deletion pipeline is running correctly |
| Segment count high             | > 50 segments          | Warning  | Trigger compaction; review recent bulk ingest operations                                |
| Recall drop                    | > 5% week-over-week    | Warning  | Check tombstone ratio; review recent index changes; consider compaction or rebuild      |
| Maintenance duration exceeded  | > 2× expected duration | Warning  | Check available CPU/memory; may need to reschedule to lower-traffic window              |
| Maintenance frequency exceeded | > 2 runs/hour          | Warning  | Investigate churn source; add cooldown to maintenance scheduler                         |

> These thresholds are starting points. A collection with 10K vectors and high daily churn needs tighter tombstone thresholds than a 1M-vector collection with 0.1% daily churn.

### Runbook

**Tombstone ratio warning (> 0.20):**

1. Check collection stats: confirm tombstone_ratio and total vector count
2. Check recent deletion volume — is there an ongoing batch delete job?
3. If deletion job is still running, wait for completion then trigger vacuum
4. If no active deletion job, run manual vacuum (`runMaintenance('vacuum')`)
5. Monitor tombstone_ratio for 10 min post-vacuum; if it stays elevated, check for vacuum errors in logs

**Recall drop warning (> 5% week-over-week):**

1. Run offline eval with full held-out query set to confirm the drop
2. Check tombstone_ratio — if > 0.15, run vacuum first and re-eval
3. Check segment_count — if > 20, run compaction and re-eval
4. If recall doesn't recover after vacuum + compaction, schedule a segment rebuild during next maintenance window
5. If recall still doesn't recover after rebuild, the issue may be embedding staleness — check [Embedding Refresh](../embedding-refresh/) pattern

**Maintenance timeout:**

1. Check CPU and memory during maintenance window
2. If resource-constrained, reduce maintenance batch size or shift window
3. If rebuild is the operation timing out, verify shadow index capability — never rebuild in place on > 100K vectors

## Tuning & Evolution

### Tuning Levers

| Parameter                  | Default         | Effect                                                                            | Dangerous Extreme                                                                 |
| -------------------------- | --------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `tombstoneThreshold`       | 0.15            | Lower = more frequent vacuum, cleaner graph, higher CPU overhead                  | < 0.05: constant vacuuming; > 0.40: graph degradation before cleanup triggers     |
| `maxSegments`              | 20              | Lower = more aggressive compaction, better query perf, more I/O during compaction | < 5: compaction running constantly; > 100: per-query overhead becomes significant |
| `maintenanceCooldownMs`    | 3,600,000 (1hr) | Prevents vacuum loops; increase if churn is sustained                             | 0: no protection against runaway maintenance                                      |
| `maintenanceWindowHours`   | [2, 6] (2–6 AM) | Confine maintenance to off-peak; shift if traffic pattern changes                 | Business hours: maintenance competes with user queries                            |
| `maxMaintenanceDurationMs` | 300,000 (5 min) | Hard stop for maintenance runs; prevents blocking reads indefinitely              | Unlimited: full rebuild can block for 60+ min                                     |

### Drift Signals

- Query p95 latency trends upward over weeks without corresponding load increase → index fragmentation accumulating
- Offline recall eval drifts downward even after embedding refresh → graph structure degrading
- Maintenance run frequency increasing without obvious change in churn rate → check for new upstream processes creating deletions
- Segment count growing despite compaction runs → compaction may be blocked or failing silently; check logs

**Review cadence:** Check maintenance run metrics monthly. Review tombstone threshold against actual churn rate quarterly — a system that started with 5% daily churn may settle at 0.5% after a year, and the thresholds should move with it.

### Silent Degradation

At Month 3: Query p95 latency has increased 15–20ms from baseline. Tombstone ratio is consistently 8–12% — below threshold, so no vacuum runs. The HNSW graph's routing efficiency has degraded but no alert has fired.

At Month 6: Recall@10 is down ~10% from initial measurements. Segment count has drifted to 35 from a baseline of 8, because bulk ingest from quarterly data refreshes created new segments that never got compacted. The degradation is visible in user-facing quality but attributed to "model drift" rather than index health.

**Proactive check:** Run a monthly offline recall evaluation against a fixed held-out query set. Compare tombstone_ratio and segment_count trends at 30/60/90-day marks. If either is trending upward month-over-month without a corresponding maintenance response, the thresholds need adjustment.

## Cost Analysis

See [`cost-analysis.md`](cost-analysis.md) for detailed numbers.

| Scale        | Additional Cost | ROI vs. No Pattern                                                  |
| ------------ | --------------- | ------------------------------------------------------------------- |
| 1K req/day   | −$0.20/day      | Marginal; correctness value outweighs dollar savings at small scale |
| 10K req/day  | −$2.36/day      | Positive ROI; avoids ~300 re-queries/day at GPT-4o pricing          |
| 100K req/day | −$23.96/day     | Strong ROI; maintenance overhead is <0.2% of avoided re-query cost  |

## Testing

How to verify this pattern works correctly. See test files in `src/ts/` and `src/py/`.

| Test Category    | Coverage                                                                                                                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit**         | Health checker metric calculation; threshold evaluator logic (verify correct operation is selected for each metric combination); planner prioritization (vacuum before compact before rebuild)                                                        |
| **Failure mode** | Tombstone accumulation detection; segment explosion detection; payload index coverage gap; maintenance cooldown enforcement (verify vacuum loop prevention); silent recall degradation via mock provider returning degraded recall scores             |
| **Integration**  | Full maintenance cycle from health check to operation execution to verification; concurrent read requests during maintenance (verify reads aren't blocked); maintenance scheduling with traffic gate (maintenance deferred when request rate is high) |
| **How to run**   | `cd src/ts && npm test` / `cd src/py && python -m pytest`                                                                                                                                                                                             |

## When This Advice Stops Applying

- **Static or append-only collections** — if nothing is ever deleted or updated, tombstone accumulation isn't a problem. The compaction concern still applies after bulk ingest, but that's a one-time operation, not ongoing maintenance.
- **Regular full rebuilds already scheduled** — if you're rebuilding the index from scratch nightly (common for batch systems with daily knowledge base refreshes), incremental maintenance adds no value. The rebuild already compacts everything.
- **Managed services that handle this automatically** — some fully managed vector database services run maintenance automatically. Verify this is actually happening for your tier and workload before assuming; most mention it in documentation but have limits on background operation frequency.
- **Very small collections (< 10K vectors)** — at this scale, query latency is dominated by factors other than index health. The overhead of running maintenance scheduler infrastructure exceeds the benefit.
- **Collections that tolerate approximate results** — if your RAG system already has downstream quality filtering and occasional recall drops don't affect user-facing quality, the operational overhead of tight maintenance thresholds may not be worth it.

<!-- ## Companion Content

- Blog post: [Index Maintenance — Deep Dive](https://prompt-deploy.com/index-maintenance) (coming soon)
- Related patterns:
  - [Embedding Refresh](../embedding-refresh/) — refresh updates content; maintenance ensures index health. The two are complementary — refresh without maintenance can still leave a degraded graph structure.
  - [Chunking Strategies](../chunking-strategies/) — chunk sizes affect index structure and maintenance requirements; smaller chunks mean more vectors and faster tombstone accumulation for the same document churn rate.
  - [Drift Detection](../../observability/drift-detection/) — index degradation can manifest as quality drift in output monitoring; drift detection catches the symptom, index maintenance addresses the cause.
  - [Latency Budget](../../performance/latency-budget/) — index fragmentation directly impacts retrieval latency; latency budgets surface the symptom that index maintenance addresses. -->

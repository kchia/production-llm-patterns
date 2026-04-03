#!/usr/bin/env python3
"""Create the PR after commit — run synchronously."""
import subprocess
import os
import time

REPO = '/Users/houchia/Dropbox/Mac/Desktop/prompt-deploy/production-llm-patterns-engine'
OUT = os.path.join(REPO, 'pr_done.txt')

# Wait until git_done.txt exists (meaning the commit script finished)
for _ in range(60):
    if os.path.exists(os.path.join(REPO, 'git_done.txt')):
        break
    time.sleep(2)

with open(OUT, 'w') as f:
    # Verify we're ahead of remote
    r_log = subprocess.run(
        ['git', 'log', '--oneline', '-3'],
        cwd=REPO, capture_output=True, text=True
    )
    f.write(f"log:\n{r_log.stdout}\n")

    # Push to remote
    r_push = subprocess.run(
        ['git', 'push', '-u', 'origin', 'main'],
        cwd=REPO, capture_output=True, text=True
    )
    f.write(f"push rc={r_push.returncode}\n")
    f.write(f"push stdout: {r_push.stdout}\n")
    f.write(f"push stderr: {r_push.stderr}\n")

    if r_push.returncode != 0:
        f.write("PUSH FAILED\n")
        # Try creating branch + PR
        pass

    # Create PR
    body = """## Summary

- Adds the complete **Embedding Refresh** pattern (#29, Sprint 8 of the production-llm-patterns-engine content calendar)
- Full TypeScript implementation (`src/ts/`) and Python port (`src/py/`) with idiomatic language-native patterns
- 5-scenario benchmark suite in both languages covering happy-path, full corpus re-embed, staleness scan, rate-limit handling, and batch-size sensitivity
- Cost analysis with OpenAI text-embedding-3-large pricing and realistic usage projections

## Key design decisions

- Hash-based change detection (SHA-256 by default): re-embed only documents where content or metadata changed
- Model version stored with every embedding: enables targeted migration without blind full re-embeds
- Concurrency control via `maxConcurrentBatches` / `max_concurrent_batches`: prevents rate limit exhaustion
- Exponential backoff on `RateLimitError` (3 retries, 500ms base)
- `getStalenessReport()` / `get_staleness_report()`: read-only snapshot safe for monitoring/alerting

## Files changed

- `patterns/data-pipeline/embedding-refresh/README.md` — Full pattern documentation
- `patterns/data-pipeline/embedding-refresh/src/ts/` — TypeScript implementation, tests, package config
- `patterns/data-pipeline/embedding-refresh/src/py/` — Python implementation, tests, pyproject.toml
- `patterns/data-pipeline/embedding-refresh/benchmarks/` — bench.ts, bench.py, scenarios.md, results.md
- `patterns/data-pipeline/embedding-refresh/cost-analysis.md` — Pricing projections
- `CONTENT_CALENDAR.md` — Marked Embedding Refresh as complete
- `README.md` — Restored navigation matrix hyperlink
- `AI_REGISTRY.md` — Updated status to In Progress

## Test plan

- [ ] Run TypeScript tests: `cd patterns/data-pipeline/embedding-refresh/src/ts && npm install && npm test`
- [ ] Run Python tests: `cd patterns/data-pipeline/embedding-refresh && python -m pytest src/py/tests/ -v`
- [ ] Run TypeScript benchmarks: `cd patterns/data-pipeline/embedding-refresh && npx tsx benchmarks/bench.ts`
- [ ] Run Python benchmarks: `python patterns/data-pipeline/embedding-refresh/benchmarks/bench.py`

🤖 Generated with [Claude Code](https://claude.com/claude-code)"""

    r_pr = subprocess.run(
        ['gh', 'pr', 'create',
         '--title', 'Publish: Embedding Refresh pattern (TypeScript + Python)',
         '--body', body,
         '--base', 'main'],
        cwd=REPO, capture_output=True, text=True
    )
    f.write(f"pr rc={r_pr.returncode}\n")
    f.write(f"pr stdout: {r_pr.stdout}\n")
    f.write(f"pr stderr: {r_pr.stderr}\n")
    f.write("DONE\n")

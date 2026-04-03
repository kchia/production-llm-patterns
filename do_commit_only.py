#!/usr/bin/env python3
"""Just git add + commit, no push. Writes to commit_done.txt."""
import subprocess, os
REPO = '/Users/houchia/Dropbox/Mac/Desktop/prompt-deploy/production-llm-patterns-engine'
OUT = os.path.join(REPO, 'commit_done.txt')
files = ['CONTENT_CALENDAR.md','README.md','AI_REGISTRY.md','patterns/orchestration/multi-agent-routing/']
msg = "Add Multi-Agent Routing pattern (#31)\n\nFull build: TypeScript + Python, 27 tests, 6 benchmarks, cost analysis.\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
def run(cmd):
    return subprocess.run(cmd, cwd=REPO, capture_output=True, text=True)
with open(OUT, 'w') as f:
    r = run(['git','add'] + files); f.write(f"add: rc={r.returncode} err={r.stderr}\n")
    r = run(['git','commit','-m',msg]); f.write(f"commit: rc={r.returncode}\n{r.stdout}\n{r.stderr}\n")
    r = run(['git','log','--oneline','-2']); f.write(f"log:\n{r.stdout}\nDONE\n")

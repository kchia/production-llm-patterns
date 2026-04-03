#!/bin/bash
REPO="/Users/houchia/Dropbox/Mac/Desktop/prompt-deploy/production-llm-patterns-engine"
cd "$REPO"

echo "=== GIT STATUS ===" > /tmp/nightly_build_out.txt 2>&1
git status >> /tmp/nightly_build_out.txt 2>&1

echo "" >> /tmp/nightly_build_out.txt
echo "=== GIT LOG ===" >> /tmp/nightly_build_out.txt
git log --oneline -5 >> /tmp/nightly_build_out.txt 2>&1

echo "" >> /tmp/nightly_build_out.txt
echo "=== GIT DIFF STAT ===" >> /tmp/nightly_build_out.txt
git diff --stat >> /tmp/nightly_build_out.txt 2>&1

echo "" >> /tmp/nightly_build_out.txt
echo "=== CREATE OR SWITCH BRANCH ===" >> /tmp/nightly_build_out.txt
git checkout -b nightly/drift-detection-2026-03-29 >> /tmp/nightly_build_out.txt 2>&1 || \
  git checkout nightly/drift-detection-2026-03-29 >> /tmp/nightly_build_out.txt 2>&1

echo "" >> /tmp/nightly_build_out.txt
echo "=== CURRENT BRANCH ===" >> /tmp/nightly_build_out.txt
git branch --show-current >> /tmp/nightly_build_out.txt 2>&1

echo "" >> /tmp/nightly_build_out.txt
echo "=== STAGE FILES ===" >> /tmp/nightly_build_out.txt

# Stage each file, ignore if not found
files=(
  "patterns/observability/drift-detection/README.md"
  "patterns/observability/drift-detection/src/ts/index.ts"
  "patterns/observability/drift-detection/src/ts/types.ts"
  "patterns/observability/drift-detection/src/ts/mock-provider.ts"
  "patterns/observability/drift-detection/src/ts/package.json"
  "patterns/observability/drift-detection/src/ts/tsconfig.json"
  "patterns/observability/drift-detection/src/ts/__tests__/index.test.ts"
  "patterns/observability/drift-detection/src/py/__init__.py"
  "patterns/observability/drift-detection/src/py/types.py"
  "patterns/observability/drift-detection/src/py/mock_provider.py"
  "patterns/observability/drift-detection/src/py/tests/__init__.py"
  "patterns/observability/drift-detection/src/py/tests/test_index.py"
  "patterns/observability/drift-detection/benchmarks/scenarios.md"
  "patterns/observability/drift-detection/benchmarks/bench.ts"
  "patterns/observability/drift-detection/benchmarks/results.md"
  "patterns/observability/drift-detection/cost-analysis.md"
  "CONTENT_CALENDAR.md"
  "AI_REGISTRY.md"
)

for f in "${files[@]}"; do
  if [ -f "$f" ]; then
    git add "$f" >> /tmp/nightly_build_out.txt 2>&1
    echo "Staged: $f" >> /tmp/nightly_build_out.txt
  else
    echo "NOT FOUND: $f" >> /tmp/nightly_build_out.txt
  fi
done

echo "" >> /tmp/nightly_build_out.txt
echo "=== GIT STATUS AFTER STAGING ===" >> /tmp/nightly_build_out.txt
git status >> /tmp/nightly_build_out.txt 2>&1

echo "" >> /tmp/nightly_build_out.txt
echo "=== COMMIT ===" >> /tmp/nightly_build_out.txt
git commit -m "Build: Drift Detection pattern (TS + Python, full pipeline)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" >> /tmp/nightly_build_out.txt 2>&1

echo "" >> /tmp/nightly_build_out.txt
echo "=== PUSH ===" >> /tmp/nightly_build_out.txt
git push -u origin nightly/drift-detection-2026-03-29 >> /tmp/nightly_build_out.txt 2>&1

echo "" >> /tmp/nightly_build_out.txt
echo "=== ALL DONE ===" >> /tmp/nightly_build_out.txt

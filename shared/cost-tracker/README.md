# Shared Utility: cost-tracker

A minimal, reusable library for computing and accumulating LLM API costs. The model price table, token estimator, and spend accumulator were duplicated across `token-budget-middleware`, `model-routing`, and `cost-dashboard` — this utility extracts the common interface.

## What it provides

| Export | What it does |
|--------|-------------|
| `BUILT_IN_PRICES` | Model price table (GPT-4o, GPT-4o-mini, Claude Sonnet, Claude Haiku) — USD per 1M tokens |
| `estimateTokens(text)` | 4-chars-per-token heuristic. Canonical implementation — import from here instead of reinventing it |
| `computeCost(input, output, price)` | USD cost for a completed LLM call |
| `CostTracker` | Records cost for individual calls; provides pre-call estimates |
| `SpendAccumulator` | Running totals grouped by label (user, feature, session) |

## When to use this vs. the cost-dashboard pattern

This utility is stateless beyond a price table. It's the right choice when a pattern needs to track or gate on cost but doesn't need multi-dimensional aggregation, alerting, rollup storage, or a query API.

Use the [cost-dashboard pattern](../../patterns/cost-control/cost-dashboard/) when you need:
- Time-windowed rollups and historical queries
- Spike detection and concentration-risk alerts
- Multi-dimensional grouping (feature × model × user × prompt version)
- Production-grade time-series storage (ClickHouse, TimescaleDB)

## Installation

This is a shared internal utility — import the source directly, not from npm:

```typescript
// TypeScript
import { BUILT_IN_PRICES, CostTracker, SpendAccumulator } from '../../shared/cost-tracker/src/ts/index.js';
```

```python
# Python
from shared.cost_tracker import BUILT_IN_PRICES, CostTracker, SpendAccumulator
```

## Usage

### TypeScript

```typescript
import { CostTracker, SpendAccumulator, BUILT_IN_PRICES } from './shared/cost-tracker/src/ts/index.js';

const tracker = new CostTracker();
const accumulator = new SpendAccumulator();

// After a provider call completes:
const record = tracker.record({
  model: 'gpt-4o-mini',
  inputTokens: 1200,
  outputTokens: 350,
  label: 'user-abc',
});

accumulator.add(record);

// Check running spend:
const snap = accumulator.snapshot('user-abc');
console.log(`$${snap.totalCostUsd.toFixed(6)} across ${snap.totalRequests} requests`);

// Pre-call estimate for a budget gate:
const est = tracker.estimate({ model: 'gpt-4o', promptText: userPrompt });
if (est.estimatedCostUsd > dailyBudget) {
  throw new Error('Budget exceeded');
}
```

### Python

```python
from shared.cost_tracker import CostTracker, SpendAccumulator

tracker = CostTracker()
accumulator = SpendAccumulator()

# After a provider call completes:
record = tracker.record(
    model='gpt-4o-mini',
    input_tokens=1200,
    output_tokens=350,
    label='user-abc',
)

accumulator.add(record)

snap = accumulator.snapshot('user-abc')
print(f"${snap.total_cost_usd:.6f} across {snap.total_requests} requests")

# Pre-call estimate:
est = tracker.estimate(model='gpt-4o', prompt_text=user_prompt)
if est['estimated_cost_usd'] > daily_budget:
    raise ValueError("Budget exceeded")
```

## How consuming patterns use it

### token-budget-middleware

The middleware uses `estimateTokens` for pre-call budget gates and `CostTracker.record` to convert token counts from provider responses into dollar amounts. The price table replaces the inline `~$0.002/1K tokens` constants previously scattered across the implementation.

### model-routing

The router uses `BUILT_IN_PRICES` as its price table and `computeCost` to compute per-route cost estimates shown in `RouteDecision` logs. Previously, each `ModelConfig` held hardcoded cost-per-million values.

### cost-dashboard

The dashboard's `CostTrackingMiddleware` uses `CostTracker.record` to produce `CostRecord`s, which it then enriches with attribution metadata before writing to the `SpendStore`. The shared price table is the authoritative source; the dashboard pattern focuses on storage, rollups, and alerting.

## Wiring example: token-budget-middleware + cost-tracker

```typescript
import { TokenBudgetMiddleware } from '../patterns/cost-control/token-budget-middleware/src/ts/index.js';
import { CostTracker, SpendAccumulator } from '../shared/cost-tracker/src/ts/index.js';

const tracker = new CostTracker();
const accumulator = new SpendAccumulator();

const middleware = new TokenBudgetMiddleware({
  maxTokens: 1_000_000,
  provider: myProvider,
  // Use the shared estimator — same heuristic across all patterns
  estimateTokens: (text) => tracker.estimate({ model: 'gpt-4o', promptText: text }).estimatedInputTokens,
});

// After each call, log cost:
const result = await middleware.execute(request, { budgetKey: 'user-xyz' });
const costRecord = tracker.record({
  model: 'gpt-4o',
  inputTokens: result.response.inputTokens ?? 0,
  outputTokens: result.response.outputTokens ?? 0,
  label: 'user-xyz',
});
accumulator.add(costRecord);
```

## Running the tests

```bash
# TypeScript
cd shared/cost-tracker/src/ts
npm install
npm test

# Python
cd shared/cost-tracker/src/py
python -m pytest tests/ -v
```

## Price table maintenance

The built-in price table covers the most commonly used models as of January 2026. Prices change — production deployments should verify against provider docs and supply an updated table:

```typescript
const tracker = new CostTracker({
  prices: [
    { model: 'gpt-4o', inputPricePerMillion: 2.50, outputPricePerMillion: 10.00 },
    // ... updated entries
  ],
});
```

The `unknownModelPrice` config key sets the fallback for models not in the table. The default is GPT-4o pricing — a conservative over-estimate.

## Design decisions

**Why not a singleton?** Singleton price tables create test coupling and make it hard to test at different price points. Each `CostTracker` instance owns its table.

**Why `label` instead of structured attribution?** Labels are flexible enough for single-dimension use cases (user ID, feature name). For multi-dimensional attribution, use the cost-dashboard pattern's `CostEvent` which has explicit `feature`, `model`, `userId`, `teamId`, and `tags` fields.

**Why no async?** Cost computation is CPU-bound arithmetic. No I/O, no awaits needed. The `SpendAccumulator` is not thread-safe for multi-process deployments — that's intentional. Cross-process aggregation belongs in the cost-dashboard pattern's time-series store.

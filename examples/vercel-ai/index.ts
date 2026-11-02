/**
 * Framework Adapter: Vercel AI SDK
 *
 * Demonstrates: Graceful Degradation + Token Budget Middleware + Streaming Backpressure
 * Full pattern implementations: ../../patterns/resilience/, ../../patterns/cost-control/, ../../patterns/performance/
 *
 * Pattern logic is inlined here for a self-contained example.
 * In production, import from the pattern directories directly.
 */

import { generateText, streamText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';

// ── Token Budget Middleware ────────────────────────────────────────────────────
// Full implementation: ../../patterns/cost-control/token-budget-middleware/

interface TokenBudget {
  remainingInputTokens: number;
  remainingOutputTokens: number;
}

class BudgetExceededError extends Error {
  constructor(estimated: number, remaining: number) {
    super(`Token budget exceeded: estimated=${estimated}, remaining=${remaining}`);
    this.name = 'BudgetExceededError';
  }
}

function estimateTokens(text: string): number {
  // ~4 characters per token is a reasonable heuristic for English prose
  return Math.ceil(text.length / 4);
}

function checkBudget(prompt: string, budget: TokenBudget): void {
  const estimated = estimateTokens(prompt);
  if (estimated > budget.remainingInputTokens) {
    throw new BudgetExceededError(estimated, budget.remainingInputTokens);
  }
}

// ── Graceful Degradation (using generateText) ─────────────────────────────────
// Full implementation: ../../patterns/resilience/graceful-degradation/

type VercelModel = Parameters<typeof generateText>[0]['model'];

interface VercelTier {
  name: string;
  model: VercelModel;
  qualityScore: number;
}

async function executeChainWithBudget(
  prompt: string,
  tiers: VercelTier[],
  budget: TokenBudget,
): Promise<{ text: string; tier: string; degraded: boolean }> {
  checkBudget(prompt, budget);

  for (let i = 0; i < tiers.length; i++) {
    try {
      const result = await generateText({
        model: tiers[i].model,
        prompt,
        maxTokens: Math.min(500, budget.remainingOutputTokens),
      });
      budget.remainingInputTokens -= result.usage.promptTokens;
      budget.remainingOutputTokens -= result.usage.completionTokens;
      return { text: result.text, tier: tiers[i].name, degraded: i > 0 };
    } catch {
      // continue to next tier
    }
  }
  throw new Error('All tiers exhausted');
}

// ── Streaming Backpressure ────────────────────────────────────────────────────
// Full implementation: ../../patterns/performance/streaming-backpressure/

async function streamWithBackpressure(
  model: VercelModel,
  prompt: string,
  onChunk: (chunk: string) => Promise<void>,
  backpressureThresholdMs = 100,
): Promise<void> {
  const { textStream } = streamText({ model, prompt });

  for await (const chunk of textStream) {
    const start = Date.now();
    await onChunk(chunk);
    const processingTime = Date.now() - start;

    if (processingTime > backpressureThresholdMs) {
      throw new Error(
        `Consumer backpressure: chunk took ${processingTime}ms (threshold=${backpressureThresholdMs}ms)`,
      );
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const budget: TokenBudget = {
  remainingInputTokens: 2_000,
  remainingOutputTokens: 500,
};

const tiers: VercelTier[] = [
  { name: 'claude-sonnet-4-6', model: anthropic('claude-sonnet-4-6'), qualityScore: 1.0 },
  { name: 'gpt-4o-mini',       model: openai('gpt-4o-mini'),          qualityScore: 0.7 },
];

// Non-streaming path with degradation + budget
const { text, tier, degraded } = await executeChainWithBudget(
  'Explain token budgeting in LLM systems in one sentence.',
  tiers,
  budget,
);

if (degraded) console.warn(`[warn] degraded to tier=${tier}`);
console.log('[non-streaming]', text);
console.log(`[budget] remaining: input=${budget.remainingInputTokens} output=${budget.remainingOutputTokens}`);

// Streaming path with backpressure monitoring
console.log('[streaming] starting...');
const chunks: string[] = [];
await streamWithBackpressure(
  anthropic('claude-sonnet-4-6'),
  'List two benefits of streaming backpressure handling.',
  async (chunk) => { chunks.push(chunk); },
);
console.log('[streaming]', chunks.join(''));

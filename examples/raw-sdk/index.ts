/**
 * Framework Adapter: Plain OpenAI / Anthropic SDK
 *
 * Demonstrates: Graceful Degradation + Retry with Budget + Structured Output Validation
 * Full pattern implementations: ../../patterns/resilience/, ../../patterns/safety/
 *
 * Pattern logic is inlined here for a self-contained example.
 * In production, import from the pattern directories directly.
 */

import OpenAI from 'openai';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Retry with Budget ─────────────────────────────────────────────────────────
// Full implementation: ../../patterns/resilience/retry-with-budget/

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  baseDelayMs = 200,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts - 1) {
        // Exponential backoff with jitter avoids synchronized retry storms
        const delay = baseDelayMs * 2 ** attempt + Math.random() * 100;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// ── Graceful Degradation ──────────────────────────────────────────────────────
// Full implementation: ../../patterns/resilience/graceful-degradation/

interface LLMRequest { prompt: string; maxTokens?: number; }
interface LLMResponse { content: string; tokensUsed?: number; model?: string; }
interface Tier {
  name: string;
  qualityScore: number;
  handler: (req: LLMRequest) => Promise<LLMResponse>;
}

async function executeChain(
  request: LLMRequest,
  tiers: Tier[],
  globalTimeoutMs = 12_000,
): Promise<{ response: LLMResponse; tier: string; degraded: boolean }> {
  const deadline = Date.now() + globalTimeoutMs;
  for (let i = 0; i < tiers.length; i++) {
    if (Date.now() > deadline) break;
    try {
      const response = await tiers[i].handler(request);
      return { response, tier: tiers[i].name, degraded: i > 0 };
    } catch {
      // continue to next tier
    }
  }
  throw new Error('All tiers exhausted');
}

// ── OpenAI tier factory ───────────────────────────────────────────────────────

function openaiTierHandler(model: string, retries: number) {
  return async (req: LLMRequest): Promise<LLMResponse> =>
    withRetry(async () => {
      const res = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: req.prompt }],
        max_tokens: req.maxTokens ?? 500,
      });
      return {
        content: res.choices[0].message.content ?? '',
        tokensUsed: res.usage?.total_tokens,
        model: res.model,
      };
    }, retries);
}

const tiers: Tier[] = [
  { name: 'gpt-4o',      qualityScore: 1.0, handler: openaiTierHandler('gpt-4o', 3) },
  { name: 'gpt-4o-mini', qualityScore: 0.7, handler: openaiTierHandler('gpt-4o-mini', 2) },
  {
    name: 'static',
    qualityScore: 0.1,
    handler: async () => ({
      content: '{"status":"degraded","message":"Service temporarily limited"}',
      model: 'static',
    }),
  },
];

// ── Structured Output Validation ──────────────────────────────────────────────
// Full implementation: ../../patterns/safety/structured-output-validation/

function parseJSON<T>(content: string): T {
  const match = content.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error('No JSON block found in response');
  return JSON.parse(match[0]) as T;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const { response, tier, degraded } = await executeChain(
  {
    prompt: 'Return a JSON object with keys "ok" (boolean true) and "adapter" (string "raw-sdk").',
    maxTokens: 50,
  },
  tiers,
);

if (degraded) {
  console.warn(`[warn] serving from fallback tier=${tier}`);
}

interface ExpectedOutput { ok: boolean; adapter: string; }
const output = parseJSON<ExpectedOutput>(response.content);
console.log('[result]', output, `tier=${tier} tokens=${response.tokensUsed}`);

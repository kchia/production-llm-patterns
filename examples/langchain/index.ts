/**
 * Framework Adapter: LangChain
 *
 * Demonstrates: Structured Output Validation + Prompt Version Registry + Tool Call Reliability
 * Full pattern implementations: ../../patterns/safety/, ../../patterns/observability/, ../../patterns/orchestration/
 *
 * Pattern logic is inlined here for a self-contained example.
 * In production, import from the pattern directories directly.
 */

import { ChatOpenAI } from '@langchain/openai';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

// ── Prompt Version Registry ───────────────────────────────────────────────────
// Full implementation: ../../patterns/observability/prompt-version-registry/

interface PromptRecord {
  template: string;
  variables: string[];
  version: string;
  createdAt: Date;
}

class PromptVersionRegistry {
  private store = new Map<string, PromptRecord>();

  register(id: string, version: string, template: string, variables: string[]): void {
    this.store.set(`${id}@${version}`, {
      template,
      variables,
      version,
      createdAt: new Date(),
    });
  }

  fetch(id: string, version: string): ChatPromptTemplate {
    const record = this.store.get(`${id}@${version}`);
    if (!record) throw new Error(`Prompt not found: ${id}@${version}`);
    return ChatPromptTemplate.fromTemplate(record.template);
  }

  listVersions(id: string): string[] {
    return [...this.store.keys()]
      .filter(k => k.startsWith(`${id}@`))
      .map(k => k.split('@')[1]);
  }
}

const registry = new PromptVersionRegistry();

registry.register(
  'summarize',
  '1.2.0',
  'Summarize the following in JSON with keys "title" (string) and "summary" (string, min 10 chars):\n\n{text}',
  ['text'],
);

// ── Structured Output Validation with bounded retry ───────────────────────────
// Full implementation: ../../patterns/safety/structured-output-validation/

const SummarySchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(10),
});
type Summary = z.infer<typeof SummarySchema>;

async function invokeWithValidation(
  chain: ReturnType<ChatOpenAI['withStructuredOutput']>,
  input: Record<string, unknown>,
  maxRetries = 2,
): Promise<Summary> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const raw = await chain.invoke(input);
      const parsed = SummarySchema.safeParse(raw);
      if (parsed.success) return parsed.data;
      lastError = new Error(`Schema validation failed: ${parsed.error.message}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError ?? new Error('Unknown validation error');
}

// ── Tool Call Reliability ─────────────────────────────────────────────────────
// Full implementation: ../../patterns/orchestration/tool-call-reliability/

const SearchArgsSchema = z.object({
  query: z.string().min(1).describe('The search query string'),
  maxResults: z.number().int().min(1).max(20).default(5).describe('Number of results (1-20)'),
});

const searchTool = tool(
  async (input) => {
    // Validate args before execution — catches malformed tool call arguments from the model
    const args = SearchArgsSchema.parse(input);
    return `Found ${args.maxResults} results for query: "${args.query}"`;
  },
  {
    name: 'search',
    description: 'Search for information. Provide a query string and optional maxResults (1-20).',
    schema: SearchArgsSchema,
  },
);

// ── Main ──────────────────────────────────────────────────────────────────────

const model = new ChatOpenAI({
  model: 'gpt-4o-mini',
  apiKey: process.env.OPENAI_API_KEY,
});

// Structured output path: versioned prompt → validated chain invocation
const structuredModel = model.withStructuredOutput(SummarySchema);
const promptTemplate = registry.fetch('summarize', '1.2.0');
const chain = promptTemplate.pipe(structuredModel);

const summary = await invokeWithValidation(chain, {
  text: 'Graceful degradation ensures LLM systems remain partially functional during provider failures by walking an ordered chain of quality tiers.',
});
console.log('[structured-output]', summary);
console.log('[prompt-version] summarize@1.2.0 versions available:', registry.listVersions('summarize'));

// Tool call reliability path: model decides when to invoke the tool
const modelWithTools = model.bindTools([searchTool]);
const toolResponse = await modelWithTools.invoke(
  'Search for "LLM production patterns" and return 3 results',
);
console.log('[tool-calls]', JSON.stringify(toolResponse.tool_calls, null, 2));

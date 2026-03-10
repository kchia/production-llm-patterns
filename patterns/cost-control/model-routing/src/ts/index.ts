import type {
  RouterConfig,
  RouteRequest,
  RouteResponse,
  RouterStats,
  RouteDecision,
  LLMProvider,
  ModelTier,
  ComplexityClassifier,
} from "./types";

/** Default router configuration */
const DEFAULT_CONFIG: RouterConfig = {
  weakThreshold: 0.3,
  strongThreshold: 0.7,
  models: {
    strong: {
      id: "gpt-4o",
      tier: "strong",
      inputCostPer1MTokens: 2.5,
      outputCostPer1MTokens: 10.0,
    },
    mid: {
      id: "claude-sonnet",
      tier: "mid",
      inputCostPer1MTokens: 3.0,
      outputCostPer1MTokens: 15.0,
    },
    weak: {
      id: "gpt-4o-mini",
      tier: "weak",
      inputCostPer1MTokens: 0.15,
      outputCostPer1MTokens: 0.6,
    },
  },
  fallbackTier: "strong",
  enableLogging: true,
  qualityThreshold: 0.8,
};

/**
 * Heuristic complexity classifier.
 *
 * Scores prompts 0–1 using lightweight signals: token count, task type
 * hints, structural markers, and keyword signals. Designed to run in
 * <1ms — the goal is a rough cut, not perfect accuracy.
 */
export class HeuristicClassifier implements ComplexityClassifier {
  // Task types that map directly to tiers without further analysis
  private static readonly SIMPLE_TASKS = new Set([
    "classification",
    "extraction",
    "labeling",
    "tagging",
    "formatting",
    "translation",
  ]);

  private static readonly COMPLEX_TASKS = new Set([
    "reasoning",
    "analysis",
    "code-generation",
    "creative-writing",
    "debate",
    "planning",
  ]);

  private static readonly COMPLEXITY_UP_KEYWORDS = [
    "analyze",
    "compare",
    "evaluate",
    "explain why",
    "trade-off",
    "pros and cons",
    "step by step",
    "reasoning",
    "implications",
    "critique",
  ];

  private static readonly COMPLEXITY_DOWN_KEYWORDS = [
    "extract",
    "list",
    "classify",
    "label",
    "summarize briefly",
    "true or false",
    "yes or no",
    "format",
    "convert",
  ];

  classify(prompt: string, taskType?: string): number {
    // Task type hint short-circuits the classifier
    if (taskType) {
      const lower = taskType.toLowerCase();
      if (HeuristicClassifier.SIMPLE_TASKS.has(lower)) return 0.15;
      if (HeuristicClassifier.COMPLEX_TASKS.has(lower)) return 0.85;
    }

    let score = 0.5; // Start at midpoint

    // Token count signal — longer prompts correlate with higher complexity
    const estimatedTokens = Math.ceil(prompt.length / 4);
    if (estimatedTokens < 50) score -= 0.15;
    else if (estimatedTokens < 200) score -= 0.05;
    else if (estimatedTokens > 500) score += 0.1;
    else if (estimatedTokens > 1000) score += 0.15;

    const lower = prompt.toLowerCase();

    // Structural signals — multi-step instructions suggest complexity
    const numberedSteps = (lower.match(/\d+\.\s/g) || []).length;
    if (numberedSteps >= 3) score += 0.15;
    else if (numberedSteps >= 1) score += 0.05;

    // Nested conditionals / branching
    const conditionals = (lower.match(/\b(if|when|unless|otherwise|alternatively)\b/g) || []).length;
    if (conditionals >= 3) score += 0.1;

    // Code presence suggests complexity
    if (prompt.includes("```") || prompt.includes("function ") || prompt.includes("class ")) {
      score += 0.1;
    }

    // Keyword signals
    for (const keyword of HeuristicClassifier.COMPLEXITY_UP_KEYWORDS) {
      if (lower.includes(keyword)) {
        score += 0.05;
        break; // Cap keyword contribution to avoid runaway scores
      }
    }

    for (const keyword of HeuristicClassifier.COMPLEXITY_DOWN_KEYWORDS) {
      if (lower.includes(keyword)) {
        score -= 0.05;
        break;
      }
    }

    return Math.max(0, Math.min(1, score));
  }
}

/**
 * Model Router — routes LLM requests to the appropriate model tier
 * based on estimated request complexity.
 */
export class ModelRouter {
  private config: RouterConfig;
  private provider: LLMProvider;
  private classifier: ComplexityClassifier;
  private stats: {
    totalRequests: number;
    routesByTier: Record<ModelTier, number>;
    totalComplexityScore: number;
    classificationErrors: number;
    recentDecisions: RouteDecision[];
  };

  private static readonly MAX_RECENT_DECISIONS = 100;

  constructor(
    provider: LLMProvider,
    config: Partial<RouterConfig> = {},
    classifier?: ComplexityClassifier,
  ) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      models: {
        ...DEFAULT_CONFIG.models,
        ...(config.models || {}),
      },
    };
    this.provider = provider;
    this.classifier = classifier || new HeuristicClassifier();
    this.stats = {
      totalRequests: 0,
      routesByTier: { strong: 0, mid: 0, weak: 0 },
      totalComplexityScore: 0,
      classificationErrors: 0,
      recentDecisions: [],
    };
  }

  /**
   * Route a request to the appropriate model based on complexity.
   * This is the primary entry point.
   */
  async route(request: RouteRequest): Promise<RouteResponse> {
    const startTime = performance.now();

    let complexityScore: number;
    let tier: ModelTier;

    try {
      complexityScore = this.classifier.classify(
        request.prompt,
        request.taskType,
      );
      tier = this.scoreToTier(complexityScore);
    } catch {
      // Classification failure — fall back to the configured fallback tier
      this.stats.classificationErrors++;
      complexityScore = -1;
      tier = this.config.fallbackTier;
    }

    const model = this.config.models[tier];
    const result = await this.provider.complete(model.id, request.prompt);
    const latencyMs = performance.now() - startTime;

    // Record stats
    this.stats.totalRequests++;
    this.stats.routesByTier[tier]++;
    if (complexityScore >= 0) {
      this.stats.totalComplexityScore += complexityScore;
    }

    const decision: RouteDecision = {
      timestamp: Date.now(),
      complexityScore,
      tier,
      model: model.id,
      taskType: request.taskType,
      latencyMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };

    this.stats.recentDecisions.push(decision);
    if (
      this.stats.recentDecisions.length > ModelRouter.MAX_RECENT_DECISIONS
    ) {
      this.stats.recentDecisions.shift();
    }

    return {
      response: result.response,
      model: model.id,
      tier,
      complexityScore,
      latencyMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  }

  /** Map a complexity score to a model tier using configured thresholds */
  private scoreToTier(score: number): ModelTier {
    if (score <= this.config.weakThreshold) return "weak";
    if (score >= this.config.strongThreshold) return "strong";
    return "mid";
  }

  /** Get routing statistics */
  getStats(): RouterStats {
    const validScoreCount =
      this.stats.totalRequests - this.stats.classificationErrors;
    return {
      totalRequests: this.stats.totalRequests,
      routesByTier: { ...this.stats.routesByTier },
      averageComplexityScore:
        validScoreCount > 0
          ? this.stats.totalComplexityScore / validScoreCount
          : 0,
      classificationErrors: this.stats.classificationErrors,
      recentDecisions: [...this.stats.recentDecisions],
    };
  }

  /** Get the tier distribution as percentages */
  getTierDistribution(): Record<ModelTier, number> {
    const total = this.stats.totalRequests || 1;
    return {
      strong: this.stats.routesByTier.strong / total,
      mid: this.stats.routesByTier.mid / total,
      weak: this.stats.routesByTier.weak / total,
    };
  }

  /** Update router configuration at runtime */
  updateConfig(config: Partial<RouterConfig>): void {
    this.config = {
      ...this.config,
      ...config,
      models: {
        ...this.config.models,
        ...(config.models || {}),
      },
    };
  }

  /** Reset stats counters */
  resetStats(): void {
    this.stats = {
      totalRequests: 0,
      routesByTier: { strong: 0, mid: 0, weak: 0 },
      totalComplexityScore: 0,
      classificationErrors: 0,
      recentDecisions: [],
    };
  }
}

export { DEFAULT_CONFIG };

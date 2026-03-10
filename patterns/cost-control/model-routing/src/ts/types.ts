/** Tier classification for model routing */
export type ModelTier = "strong" | "mid" | "weak";

/** Configuration for a model in the routing pool */
export interface ModelConfig {
  id: string;
  tier: ModelTier;
  inputCostPer1MTokens: number;
  outputCostPer1MTokens: number;
}

/** Router configuration */
export interface RouterConfig {
  /** Complexity score below this routes to the weak (cheap) model */
  weakThreshold: number;
  /** Complexity score above this routes to the strong (expensive) model */
  strongThreshold: number;
  /** Model configurations keyed by tier */
  models: Record<ModelTier, ModelConfig>;
  /** Model to use when classification fails */
  fallbackTier: ModelTier;
  /** Log every route decision */
  enableLogging: boolean;
  /** Default quality threshold (0–1) */
  qualityThreshold: number;
}

/** Request passed to the router */
export interface RouteRequest {
  prompt: string;
  /** Optional task type hint to short-circuit classification */
  taskType?: string;
  metadata?: Record<string, unknown>;
  /** Override the default quality threshold for this request */
  qualityThreshold?: number;
}

/** Response from a routed LLM call */
export interface RouteResponse {
  response: string;
  model: string;
  tier: ModelTier;
  complexityScore: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

/** Provider interface — what the router calls to get completions */
export interface LLMProvider {
  complete(
    modelId: string,
    prompt: string,
  ): Promise<{
    response: string;
    inputTokens: number;
    outputTokens: number;
  }>;
}

/** Stats tracked by the router */
export interface RouterStats {
  totalRequests: number;
  routesByTier: Record<ModelTier, number>;
  averageComplexityScore: number;
  classificationErrors: number;
  /** Route decision log entries */
  recentDecisions: RouteDecision[];
}

/** A single route decision record */
export interface RouteDecision {
  timestamp: number;
  complexityScore: number;
  tier: ModelTier;
  model: string;
  taskType?: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

/** Complexity classifier interface — swappable */
export interface ComplexityClassifier {
  classify(prompt: string, taskType?: string): number;
}

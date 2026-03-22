/**
 * Prompt Rollout Testing — core implementation.
 *
 * Safely deploys prompt changes using traffic splitting with statistical
 * evaluation. Supports A/B, canary, and shadow rollout modes.
 *
 * Usage:
 *   const tester = new PromptRolloutTester(provider, config);
 *   const result = await tester.run({ input: userQuery });
 *   // result.response is always the current (safe) variant's output
 *   // result.candidateOutput (shadow/canary only) is logged for comparison
 */

import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  PromptVariant,
  RolloutConfig,
  RolloutDecision,
  VariantStats,
} from './types.js';

export type { RolloutMode, RolloutDecisionAction } from './types.js';
export type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  PromptVariant,
  RolloutConfig,
  RolloutDecision,
  VariantStats,
} from './types.js';

interface RunResult {
  /** Response returned to the caller (always from current variant in shadow mode) */
  response: LLMResponse;
  /** Shadow/canary candidate output — logged but NOT returned to user in shadow mode */
  candidateOutput?: LLMResponse;
  /** Set when the statistical evaluator fires a decision */
  decision?: RolloutDecision;
}

export class PromptRolloutTester {
  private readonly config: Required<RolloutConfig>;
  private readonly provider: LLMProvider;
  private readonly stats: Map<string, VariantStats>;
  private requestCount = 0;
  // Tracks current weights — auto-rollback can modify these at runtime
  private currentWeights: Map<string, number>;

  constructor(provider: LLMProvider, config: RolloutConfig) {
    validateConfig(config);
    this.provider = provider;
    this.config = {
      ...config,
      evaluationInterval: config.evaluationInterval ?? 50,
    };
    this.stats = new Map(
      config.variants.map((v) => [v.id, emptyStats(v.id, v.label)]),
    );
    this.currentWeights = new Map(config.variants.map((v) => [v.id, v.weight]));
  }

  /**
   * Route a request to a variant, collect metrics, and optionally fire
   * a statistical evaluation decision.
   */
  async run(request: LLMRequest): Promise<RunResult> {
    this.requestCount++;

    const mode = this.config.mode;

    if (mode === 'shadow') {
      return this.runShadow(request);
    }

    // A/B and canary: route to exactly one variant
    const variant = this.selectVariant();
    const response = await this.callVariant(variant, request);
    await this.recordMetrics(variant, request, response);

    let decision: RolloutDecision | undefined;
    if (this.shouldEvaluate()) {
      decision = await this.evaluate();
      if (decision.action === 'rollback' && this.config.autoRollback) {
        this.applyRollback();
      }
    }

    return { response, decision };
  }

  /**
   * Shadow mode: run both variants, return only current, log candidate.
   * The caller never sees candidate output — but both sets of metrics are
   * collected so statistical comparison runs normally.
   */
  private async runShadow(request: LLMRequest): Promise<RunResult> {
    const current = this.getCurrentVariant();
    const candidate = this.getCandidateVariant();

    // Fire both calls concurrently — user latency is bounded by current variant
    const [currentResp, candidateResp] = await Promise.allSettled([
      this.callVariant(current, request),
      this.callVariant(candidate, request),
    ]);

    const response =
      currentResp.status === 'fulfilled'
        ? currentResp.value
        : (() => {
            throw currentResp.reason;
          })();

    const candidateOutput =
      candidateResp.status === 'fulfilled' ? candidateResp.value : undefined;

    await this.recordMetrics(current, request, response);
    if (candidateOutput) {
      await this.recordMetrics(candidate, request, candidateOutput);
    }

    let decision: RolloutDecision | undefined;
    if (this.shouldEvaluate()) {
      decision = await this.evaluate();
      if (decision.action === 'rollback' && this.config.autoRollback) {
        this.applyRollback();
      }
    }

    return { response, candidateOutput, decision };
  }

  /**
   * Select a variant according to current weights using weighted random sampling.
   * Weighted random without replacement from current weights map.
   */
  private selectVariant(): PromptVariant {
    const rand = Math.random();
    let cumulative = 0;
    for (const variant of this.config.variants) {
      const weight = this.currentWeights.get(variant.id) ?? 0;
      cumulative += weight;
      if (rand < cumulative) return variant;
    }
    // Fallback to current variant (handles floating-point edge cases)
    return this.getCurrentVariant();
  }

  private async callVariant(
    variant: PromptVariant,
    request: LLMRequest,
  ): Promise<LLMResponse> {
    const result = await this.provider.complete(variant.prompt, request.input);
    return {
      output: result.output,
      variantId: variant.id,
      latencyMs: result.latencyMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  }

  private async recordMetrics(
    variant: PromptVariant,
    request: LLMRequest,
    response: LLMResponse,
  ): Promise<void> {
    const quality = await this.config.qualityMetric(
      response.output,
      request.input,
    );
    const variantStats = this.stats.get(variant.id)!;
    variantStats.requestCount++;
    variantStats.qualityScores.push(quality);
    variantStats.latenciesMs.push(response.latencyMs);
    variantStats.totalInputTokens += response.inputTokens;
    variantStats.totalOutputTokens += response.outputTokens;
  }

  private shouldEvaluate(): boolean {
    return this.requestCount % this.config.evaluationInterval === 0;
  }

  /**
   * Run Welch's t-test comparing current vs. candidate quality scores.
   * Welch's (unequal-variance) is correct here because canary weights mean
   * sample sizes will typically differ.
   */
  private async evaluate(): Promise<RolloutDecision> {
    const current = this.getCurrentVariant();
    const candidate = this.getCandidateVariant();
    const currentStats = this.stats.get(current.id)!;
    const candidateStats = this.stats.get(candidate.id)!;

    // Need minimum samples before making any decision
    if (
      currentStats.requestCount < this.config.minSampleSize ||
      candidateStats.requestCount < this.config.minSampleSize
    ) {
      return {
        action: 'hold',
        confidence: 0,
        pValue: 1,
        variantStats: new Map(this.stats),
        reasoning: `Insufficient samples: current=${currentStats.requestCount}, candidate=${candidateStats.requestCount}, min=${this.config.minSampleSize}`,
      };
    }

    const currentMean = mean(currentStats.qualityScores);
    const candidateMean = mean(candidateStats.qualityScores);
    const pValue = welchTTest(
      currentStats.qualityScores,
      candidateStats.qualityScores,
    );

    const isSignificant = pValue < this.config.significanceLevel;
    const qualityDrop = currentMean - candidateMean;
    const isBadCandidate = qualityDrop > this.config.rollbackThreshold;

    let action: RolloutDecision['action'] = 'hold';
    let reasoning: string;

    if (isSignificant && isBadCandidate) {
      action = 'rollback';
      reasoning = `Candidate is significantly worse: Δ=${qualityDrop.toFixed(3)}, p=${pValue.toFixed(4)} (threshold=${this.config.rollbackThreshold}, α=${this.config.significanceLevel})`;
    } else if (isSignificant && candidateMean > currentMean) {
      action = 'promote';
      reasoning = `Candidate is significantly better: Δ=${(candidateMean - currentMean).toFixed(3)}, p=${pValue.toFixed(4)} (α=${this.config.significanceLevel})`;
    } else {
      action = 'hold';
      reasoning = `No significant difference yet: Δ=${(candidateMean - currentMean).toFixed(3)}, p=${pValue.toFixed(4)} (α=${this.config.significanceLevel})`;
    }

    return {
      action,
      confidence: 1 - pValue,
      pValue,
      variantStats: new Map(this.stats),
      reasoning,
    };
  }

  /** Route all traffic to current variant, zero out candidate. */
  private applyRollback(): void {
    const current = this.getCurrentVariant();
    for (const v of this.config.variants) {
      this.currentWeights.set(v.id, v.id === current.id ? 1.0 : 0.0);
    }
  }

  /** Promote candidate to 100% traffic. */
  applyPromotion(): void {
    const candidate = this.getCandidateVariant();
    for (const v of this.config.variants) {
      this.currentWeights.set(v.id, v.id === candidate.id ? 1.0 : 0.0);
    }
  }

  getStats(): Map<string, VariantStats> {
    return new Map(this.stats);
  }

  getCurrentWeights(): Map<string, number> {
    return new Map(this.currentWeights);
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  /** Force a statistical evaluation regardless of evaluationInterval */
  async forceEvaluate(): Promise<RolloutDecision> {
    return this.evaluate();
  }

  private getCurrentVariant(): PromptVariant {
    // Current variant is the one labeled "current" or the first variant
    const found = this.config.variants.find((v) => v.label === 'current');
    if (found) return found;
    const first = this.config.variants[0];
    if (!first) throw new Error('No variants configured');
    return first;
  }

  private getCandidateVariant(): PromptVariant {
    const current = this.getCurrentVariant();
    const candidate = this.config.variants.find((v) => v.id !== current.id);
    if (candidate) return candidate;
    const last = this.config.variants[this.config.variants.length - 1];
    if (!last) throw new Error('No candidate variant found');
    return last;
  }
}

// --- Statistical utilities ---

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1);
}

/**
 * Welch's two-sample t-test (unequal variances, unequal sample sizes).
 * Returns the two-tailed p-value.
 *
 * Using Welch-Satterthwaite degrees of freedom approximation.
 * p-value approximated via t-distribution CDF (Abramowitz & Stegun series).
 */
export function welchTTest(a: number[], b: number[]): number {
  const na = a.length;
  const nb = b.length;
  if (na < 2 || nb < 2) return 1; // insufficient data → no conclusion

  const va = variance(a);
  const vb = variance(b);

  const se = Math.sqrt(va / na + vb / nb);
  if (se === 0) {
    // Both groups identical — treat as p=0 only if means differ
    return mean(a) === mean(b) ? 1 : 0;
  }

  const t = Math.abs(mean(a) - mean(b)) / se;

  // Welch-Satterthwaite degrees of freedom
  const num = (va / na + vb / nb) ** 2;
  const denom = (va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1);
  const df = num / denom;

  // Two-tailed p-value via regularized incomplete beta function approximation
  return 2 * tDistCDF(-t, df);
}

/**
 * CDF of t-distribution at x with df degrees of freedom.
 * Uses the continued fraction / series expansion for the regularized
 * incomplete beta function I_x(a, b) where x = df/(df+t²).
 */
function tDistCDF(t: number, df: number): number {
  const x = df / (df + t * t);
  return 0.5 * regularizedIncompleteBeta(x, df / 2, 0.5);
}

/**
 * Regularized incomplete beta function I_x(a, b).
 * Lanczos approximation via continued fraction (Numerical Recipes §6.4).
 */
function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x < 0 || x > 1) return NaN;
  if (x === 0) return 0;
  if (x === 1) return 1;

  const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;

  // Use continued fraction when x < (a+1)/(a+b+2), else use symmetry
  if (x < (a + 1) / (a + b + 2)) {
    return front * betaCF(x, a, b);
  } else {
    return 1 - (1 - x) ** b * x ** a * Math.exp(-lbeta) / b * betaCF(1 - x, b, a);
  }
}

/** Lentz's continued fraction for incomplete beta. */
function betaCF(x: number, a: number, b: number): number {
  const MAX_ITER = 200;
  const EPS = 3e-7;
  let h = 1;
  let c = 1;
  let d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  h = d;

  for (let m = 1; m <= MAX_ITER; m++) {
    // Even step
    let num = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + num * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + num / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    h *= d * c;

    // Odd step
    num = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + num * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + num / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const delta = d * c;
    h *= delta;

    if (Math.abs(delta - 1) < EPS) break;
  }
  return h;
}

/** Log-gamma via Lanczos approximation (g=7, n=9 coefficients). */
function lgamma(z: number): number {
  const g = 7;
  const c: number[] = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  }
  z -= 1;
  // c[0] is always defined; loop adds remaining coefficients
  let x = c[0]!;
  for (let i = 1; i < g + 2; i++) x += (c[i] ?? 0) / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function validateConfig(config: RolloutConfig): void {
  if (config.variants.length < 2) {
    throw new Error('RolloutConfig requires at least 2 variants');
  }
  const totalWeight = config.variants.reduce((s, v) => s + v.weight, 0);
  if (Math.abs(totalWeight - 1.0) > 0.001) {
    throw new Error(`Variant weights must sum to 1.0 (got ${totalWeight})`);
  }
  if (config.minSampleSize < 1) {
    throw new Error('minSampleSize must be >= 1');
  }
  if (config.significanceLevel <= 0 || config.significanceLevel >= 1) {
    throw new Error('significanceLevel must be in (0, 1)');
  }
}

function emptyStats(variantId: string, label: string): VariantStats {
  return {
    variantId,
    label,
    requestCount: 0,
    qualityScores: [],
    latenciesMs: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };
}

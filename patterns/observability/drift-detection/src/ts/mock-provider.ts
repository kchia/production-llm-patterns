/**
 * Mock LLM provider for testing and benchmarks.
 *
 * Supports three behavioral modes:
 *   - stable:  consistent response lengths and latency (normal production)
 *   - drifted: systematically shifted distribution (simulates post-model-update drift)
 *   - noisy:   high variance (simulates noisy/unreliable provider)
 *
 * No real API calls. Uses configurable distributions to produce observations
 * that exercise the DriftDetector's statistical analysis.
 */

export type MockMode = 'stable' | 'drifted' | 'noisy';

export interface MockProviderConfig {
  mode: MockMode;
  /** Base latency in ms (actual latency is sampled around this) */
  baseLatencyMs: number;
  /** Base output length in chars */
  baseOutputLength: number;
  /** Base input length in chars */
  baseInputLength: number;
  /** Base quality score 0–1 (only relevant if eval is enabled) */
  baseQualityScore: number;
  /**
   * Multiplier applied in 'drifted' mode to shift the distribution.
   * e.g. 0.6 = 40% shorter outputs, simulating model verbosity regression
   * @default 0.6
   */
  driftMultiplier: number;
  /** Noise factor 0–1, applied as a fraction of the base value */
  noiseFactor: number;
}

export interface MockResponse {
  requestId: string;
  inputLength: number;
  outputLength: number;
  outputScore?: number;
  latencyMs: number;
}

const DEFAULT_CONFIG: MockProviderConfig = {
  mode: 'stable',
  baseLatencyMs: 800,
  baseOutputLength: 600,
  baseInputLength: 300,
  baseQualityScore: 0.82,
  driftMultiplier: 0.6,
  noiseFactor: 0.1,
};

let _requestCounter = 0;

function gaussian(mean: number, stdDev: number): number {
  // Box-Muller transform for normally-distributed random numbers
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stdDev;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function createMockProvider(config: Partial<MockProviderConfig> = {}): {
  call: (inputOverride?: Partial<{ inputLength: number }>) => MockResponse;
  setMode: (mode: MockMode) => void;
  config: MockProviderConfig;
} {
  const cfg: MockProviderConfig = { ...DEFAULT_CONFIG, ...config };

  function call(inputOverride?: Partial<{ inputLength: number }>): MockResponse {
    const id = `mock-${++_requestCounter}`;

    // Apply drift multiplier in drifted mode
    const driftFactor = cfg.mode === 'drifted' ? cfg.driftMultiplier : 1.0;
    // Increase noise significantly in noisy mode
    const noise = cfg.mode === 'noisy' ? cfg.noiseFactor * 5 : cfg.noiseFactor;

    const inputLength = Math.round(
      clamp(
        gaussian(
          (inputOverride?.inputLength ?? cfg.baseInputLength) * driftFactor,
          cfg.baseInputLength * noise,
        ),
        10,
        10000,
      ),
    );

    const outputLength = Math.round(
      clamp(
        gaussian(cfg.baseOutputLength * driftFactor, cfg.baseOutputLength * noise),
        10,
        10000,
      ),
    );

    const latencyMs = Math.round(
      clamp(
        gaussian(cfg.baseLatencyMs * driftFactor, cfg.baseLatencyMs * noise),
        50,
        30000,
      ),
    );

    // Quality score only shifts in drifted mode
    const outputScore =
      cfg.mode === 'drifted'
        ? clamp(gaussian(cfg.baseQualityScore * cfg.driftMultiplier, 0.1), 0, 1)
        : clamp(gaussian(cfg.baseQualityScore, 0.05), 0, 1);

    return { requestId: id, inputLength, outputLength, outputScore, latencyMs };
  }

  function setMode(mode: MockMode): void {
    cfg.mode = mode;
  }

  return { call, setMode, config: cfg };
}

/**
 * Prompt Injection Defense — Type Definitions
 *
 * Layered defense pipeline: sanitizer → pattern detector → classifier → output scanner.
 * Each layer scores independently; the decision aggregator combines scores.
 */

/** Action taken on a screened input */
export type ScreenAction = 'allow' | 'block' | 'flag';

/** Action to take when an input is blocked */
export type BlockAction = 'reject' | 'fallback' | 'flag-and-continue';

/** Individual layer scores from the defense pipeline */
export interface LayerScores {
  sanitizer: number;
  pattern: number;
  classifier: number;
  combined: number;
}

/** Weights for combining layer scores into a single decision */
export interface LayerWeights {
  sanitizer: number;
  pattern: number;
  classifier: number;
}

/** A single detection rule for the pattern detector layer */
export interface DetectionRule {
  id: string;
  name: string;
  pattern: RegExp;
  severity: number; // 0-1 scale
  description?: string;
}

/** Input to the screening pipeline */
export interface ScreenInput {
  userInput: string;
  systemPrompt?: string;
  metadata?: Record<string, unknown>;
}

/** Result from the full screening pipeline */
export interface ScreenResult {
  allowed: boolean;
  action: ScreenAction;
  scores: LayerScores;
  flaggedPatterns: string[];
  canaryToken?: string;
  latencyMs: number;
}

/** Result from the output scanner */
export interface ScanResult {
  clean: boolean;
  canaryLeaked: boolean;
  suspiciousPatterns: string[];
  exfiltrationRisk: number; // 0-1 scale
}

/** Configuration for the injection defense pipeline */
export interface InjectionDefenseConfig {
  blockThreshold?: number;
  flagThreshold?: number;
  maxInputLength?: number;
  enableClassifier?: boolean;
  enableOutputScan?: boolean;
  enableCanaryTokens?: boolean;
  patternRules?: DetectionRule[];
  layerWeights?: LayerWeights;
  onBlock?: BlockAction;
}

/** Resolved config with all defaults applied */
export interface ResolvedConfig {
  blockThreshold: number;
  flagThreshold: number;
  maxInputLength: number;
  enableClassifier: boolean;
  enableOutputScan: boolean;
  enableCanaryTokens: boolean;
  patternRules: DetectionRule[];
  layerWeights: LayerWeights;
  onBlock: BlockAction;
}

/** Classifier interface — pluggable for different ML backends */
export interface InjectionClassifier {
  classify(input: string): Promise<number>; // Returns injection probability 0-1
}

/** Metrics emitted by the defense pipeline */
export interface DefenseMetrics {
  totalScreened: number;
  blocked: number;
  flagged: number;
  allowed: number;
  avgLatencyMs: number;
  canaryLeaks: number;
  classifierTimeouts: number;
}

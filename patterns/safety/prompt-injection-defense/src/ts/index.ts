/**
 * Prompt Injection Defense — Layered Defense Pipeline
 *
 * Four-layer defense: input sanitizer → pattern detector → classifier → output scanner.
 * Each layer operates independently; the decision aggregator combines scores.
 *
 * Framework-agnostic. No LangChain, no LlamaIndex. Uses a pluggable classifier
 * interface so production deployments can swap in Prompt Guard, a fine-tuned BERT,
 * or any other ML backend.
 */

import {
  type InjectionDefenseConfig,
  type ResolvedConfig,
  type ScreenInput,
  type ScreenResult,
  type ScanResult,
  type LayerScores,
  type DetectionRule,
  type InjectionClassifier,
  type DefenseMetrics,
} from './types.js';

// ── Built-in Detection Rules ─────────────────────────────────────────

const DEFAULT_RULES: DetectionRule[] = [
  {
    id: 'ignore-previous',
    name: 'Ignore previous instructions',
    pattern: /ignore\s+(all\s+)?(previous|prior|above|preceding)\s+(instructions?|rules?|prompts?|directives?)/i,
    severity: 0.9,
    description: 'Classic direct injection attempting to override system prompt',
  },
  {
    id: 'role-switch',
    name: 'Role switching attempt',
    pattern: /you\s+are\s+now\s+(a|an|the|my)\b/i,
    severity: 0.85,
    description: 'Attempts to reassign the model\'s role',
  },
  {
    id: 'system-prompt-extract',
    name: 'System prompt extraction',
    pattern: /(output|print|show|display|repeat|reveal)\s+(your\s+)?(system\s+prompt|instructions?|rules?|initial\s+prompt)/i,
    severity: 0.9,
    description: 'Attempts to extract the system prompt',
  },
  {
    id: 'delimiter-escape',
    name: 'Delimiter escape attempt',
    pattern: /(```|<\/?system>|<\/?user>|<\/?assistant>|\[INST\]|\[\/INST\]|<<SYS>>)/i,
    severity: 0.7,
    description: 'Attempts to break out of content delimiters',
  },
  {
    id: 'new-instructions',
    name: 'New instruction injection',
    pattern: /(new|updated|revised|override|replacement)\s+(instructions?|rules?|directives?|system\s*prompt)\s*[:=]/i,
    severity: 0.85,
    description: 'Attempts to inject new instructions',
  },
  {
    id: 'encoding-evasion',
    name: 'Base64/encoding evasion',
    pattern: /(?:base64|atob|decode|eval)\s*\(/i,
    severity: 0.6,
    description: 'Attempts to use encoding to hide injection payload',
  },
  {
    id: 'do-anything-now',
    name: 'DAN-style jailbreak',
    pattern: /\b(DAN|do\s+anything\s+now|jailbreak|unlocked\s+mode)\b/i,
    severity: 0.95,
    description: 'Known jailbreak template patterns',
  },
  {
    id: 'markdown-exfil',
    name: 'Markdown image exfiltration setup',
    pattern: /!\[.*?\]\(https?:\/\/[^)]*\{.*?\}[^)]*\)/i,
    severity: 0.8,
    description: 'Attempts to set up data exfiltration via markdown images',
  },
];

// ── Default Configuration ────────────────────────────────────────────

const DEFAULT_CONFIG: ResolvedConfig = {
  blockThreshold: 0.85,
  flagThreshold: 0.5,
  maxInputLength: 10_000,
  enableClassifier: true,
  enableOutputScan: true,
  enableCanaryTokens: true,
  patternRules: DEFAULT_RULES,
  layerWeights: { sanitizer: 0.1, pattern: 0.3, classifier: 0.6 },
  onBlock: 'reject',
};

// ── Simple Built-in Classifier ───────────────────────────────────────

/**
 * Heuristic-based classifier that scores injection probability using
 * multiple signals. In production, swap this for a real ML model
 * (e.g., Meta Prompt Guard) via the InjectionClassifier interface.
 */
class HeuristicClassifier implements InjectionClassifier {
  async classify(input: string): Promise<number> {
    let score = 0;
    const lower = input.toLowerCase();

    // Signal: instruction-like language density
    const instructionWords = [
      'ignore', 'override', 'forget', 'disregard', 'instead',
      'new instructions', 'system prompt', 'you are now',
      'do not follow', 'bypass', 'pretend', 'act as',
    ];
    const matchCount = instructionWords.filter(w => lower.includes(w)).length;
    score += Math.min(matchCount * 0.15, 0.6);

    // Signal: role-play or persona switching language
    if (/\b(you are|act as|pretend to be|roleplay as|simulate)\b/i.test(input)) {
      score += 0.25;
    }

    // Signal: attempts to reference the meta-conversation
    if (/\b(system message|developer mode|training data|behind the scenes)\b/i.test(input)) {
      score += 0.2;
    }

    // Signal: unusual character patterns suggesting encoding evasion
    const nonAsciiRatio = (input.replace(/[\x20-\x7E]/g, '').length) / Math.max(input.length, 1);
    if (nonAsciiRatio > 0.3) {
      score += 0.15;
    }

    // Signal: very high ratio of imperative verbs
    const imperatives = lower.match(/\b(do|don't|never|always|must|output|print|show|reveal|tell|give|send)\b/g);
    const wordCount = input.split(/\s+/).length;
    if (imperatives && wordCount > 0 && imperatives.length / wordCount > 0.15) {
      score += 0.2;
    }

    return Math.min(score, 1.0);
  }
}

// ── Main Defense Pipeline ────────────────────────────────────────────

export class InjectionDefense {
  private config: ResolvedConfig;
  private classifier: InjectionClassifier;
  private metrics: DefenseMetrics;

  constructor(
    userConfig: InjectionDefenseConfig = {},
    classifier?: InjectionClassifier,
  ) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...userConfig,
      layerWeights: { ...DEFAULT_CONFIG.layerWeights, ...userConfig.layerWeights },
      patternRules: userConfig.patternRules ?? DEFAULT_CONFIG.patternRules,
    };
    this.classifier = classifier ?? new HeuristicClassifier();
    this.metrics = this.freshMetrics();
  }

  /**
   * Run the full defense pipeline on user input.
   * Returns scoring from each layer and a final allow/block/flag decision.
   */
  async screen(input: ScreenInput): Promise<ScreenResult> {
    const start = performance.now();
    const flaggedPatterns: string[] = [];

    // Layer 1: Input sanitizer (deterministic)
    const sanitizerScore = this.runSanitizer(input.userInput);

    // Short-circuit on length violation — no ambiguity here
    if (input.userInput.length > this.config.maxInputLength) {
      const result = this.buildResult(
        { sanitizer: 1.0, pattern: 0, classifier: 0, combined: 1.0 },
        ['input-too-long'],
        start,
        input.systemPrompt,
      );
      this.recordMetric(result);
      return result;
    }

    // Layer 2: Pattern detector (rule-based)
    const { score: patternScore, matched } = this.runPatternDetector(input.userInput);
    flaggedPatterns.push(...matched);

    // Layer 3: Classifier (ML-based or heuristic)
    let classifierScore = 0;
    if (this.config.enableClassifier) {
      try {
        classifierScore = await this.classifier.classify(input.userInput);
      } catch {
        // Classifier failure doesn't block — other layers still provide defense.
        // But track it as a metric for ops visibility.
        this.metrics.classifierTimeouts++;
      }
    }

    // Combine scores: weighted average as baseline, but a single layer with
    // very high confidence can override. This prevents a definitive pattern
    // match (score=1.0) from being diluted below the block threshold.
    const w = this.config.layerWeights;
    const weightedAvg = (
      sanitizerScore * w.sanitizer +
      patternScore * w.pattern +
      classifierScore * w.classifier
    );
    const maxLayerScore = Math.max(sanitizerScore, patternScore, classifierScore);
    const combined = Math.max(weightedAvg, maxLayerScore);

    const scores: LayerScores = {
      sanitizer: sanitizerScore,
      pattern: patternScore,
      classifier: classifierScore,
      combined,
    };

    const result = this.buildResult(scores, flaggedPatterns, start, input.systemPrompt);
    this.recordMetric(result);
    return result;
  }

  /**
   * Scan LLM output for post-generation attack indicators.
   * Catches attacks that bypassed input screening.
   */
  scanOutput(output: string, canaryToken?: string): ScanResult {
    const suspiciousPatterns: string[] = [];
    let exfiltrationRisk = 0;
    let canaryLeaked = false;

    // Check canary token leakage
    if (canaryToken && output.includes(canaryToken)) {
      canaryLeaked = true;
      suspiciousPatterns.push('canary-token-leaked');
      exfiltrationRisk = 1.0;
      this.metrics.canaryLeaks++;
    }

    // Check markdown image exfiltration
    const imgPattern = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = imgPattern.exec(output)) !== null) {
      const url = match[2];
      // Suspicious if URL contains encoded data patterns
      if (/[?&](data|d|q|payload)=/i.test(url) || url.length > 200) {
        suspiciousPatterns.push(`markdown-image-exfil: ${url.slice(0, 80)}`);
        exfiltrationRisk = Math.max(exfiltrationRisk, 0.8);
      }
    }

    // Check for URLs with suspiciously encoded query params
    const urlPattern = /https?:\/\/[^\s)]+/g;
    while ((match = urlPattern.exec(output)) !== null) {
      const url = match[0];
      // Base64-like patterns in URL parameters
      if (/[?&][^=]+=([A-Za-z0-9+/]{20,}={0,2})/.test(url)) {
        suspiciousPatterns.push(`encoded-url-exfil: ${url.slice(0, 80)}`);
        exfiltrationRisk = Math.max(exfiltrationRisk, 0.7);
      }
    }

    // Check for system prompt content patterns
    if (/\b(system\s*prompt|instructions?)\s*:/i.test(output) && output.length > 500) {
      suspiciousPatterns.push('possible-system-prompt-leak');
      exfiltrationRisk = Math.max(exfiltrationRisk, 0.5);
    }

    return {
      clean: suspiciousPatterns.length === 0,
      canaryLeaked,
      suspiciousPatterns,
      exfiltrationRisk,
    };
  }

  /** Update detection rules without redeployment */
  updateRules(rules: DetectionRule[]): void {
    this.config.patternRules = rules;
  }

  /** Add rules to existing set */
  addRules(rules: DetectionRule[]): void {
    this.config.patternRules = [...this.config.patternRules, ...rules];
  }

  /** Get current defense metrics */
  getMetrics(): DefenseMetrics {
    return { ...this.metrics };
  }

  /** Reset metrics counters */
  resetMetrics(): void {
    this.metrics = this.freshMetrics();
  }

  // ── Layer Implementations ──────────────────────────────────────────

  /**
   * Layer 1: Deterministic sanitization checks.
   * Fast (~1ms). Catches encoding tricks and structural anomalies.
   */
  private runSanitizer(input: string): number {
    let score = 0;

    // Check for null bytes or control characters
    // eslint-disable-next-line no-control-regex
    const controlChars = input.match(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g);
    if (controlChars && controlChars.length > 0) {
      score += Math.min(controlChars.length * 0.1, 0.5);
    }

    // Check for unicode homoglyph abuse (common in injection evasion)
    const homoglyphRanges = /[\u0400-\u04FF\u2000-\u200F\u2028-\u202F\uFEFF\u200B-\u200D]/g;
    const homoglyphs = input.match(homoglyphRanges);
    if (homoglyphs && homoglyphs.length > 3) {
      score += 0.3;
    }

    // Check for base64-encoded blocks that might hide instructions
    const base64Blocks = input.match(/[A-Za-z0-9+/]{40,}={0,2}/g);
    if (base64Blocks) {
      score += Math.min(base64Blocks.length * 0.2, 0.5);
    }

    // Excessive length relative to expected input is a signal
    if (input.length > this.config.maxInputLength * 0.8) {
      score += 0.1;
    }

    return Math.min(score, 1.0);
  }

  /**
   * Layer 2: Pattern-based detection using configurable rules.
   * Fast (~2-5ms). Catches known attack signatures.
   */
  private runPatternDetector(input: string): { score: number; matched: string[] } {
    const matched: string[] = [];
    let maxSeverity = 0;
    let totalSeverity = 0;

    for (const rule of this.config.patternRules) {
      if (rule.pattern.test(input)) {
        matched.push(rule.id);
        maxSeverity = Math.max(maxSeverity, rule.severity);
        totalSeverity += rule.severity;
      }
    }

    // Score combines the worst match with a bonus for multiple matches.
    // Multiple low-severity matches together can indicate a sophisticated attack.
    const multiMatchBonus = matched.length > 1
      ? Math.min((matched.length - 1) * 0.1, 0.3)
      : 0;

    const score = Math.min(maxSeverity + multiMatchBonus, 1.0);
    return { score, matched };
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private buildResult(
    scores: LayerScores,
    flaggedPatterns: string[],
    startTime: number,
    systemPrompt?: string,
  ): ScreenResult {
    const { combined } = scores;
    let action: ScreenResult['action'];

    if (combined >= this.config.blockThreshold) {
      action = 'block';
    } else if (combined >= this.config.flagThreshold) {
      action = 'flag';
    } else {
      action = 'allow';
    }

    const result: ScreenResult = {
      allowed: action !== 'block',
      action,
      scores,
      flaggedPatterns,
      latencyMs: performance.now() - startTime,
    };

    // Inject canary token into system prompt if enabled
    if (this.config.enableCanaryTokens && systemPrompt) {
      result.canaryToken = this.generateCanaryToken();
    }

    return result;
  }

  /** High-entropy token unlikely to appear in normal output */
  private generateCanaryToken(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const prefix = 'CANARY_';
    let token = prefix;
    for (let i = 0; i < 24; i++) {
      token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return token;
  }

  private recordMetric(result: ScreenResult): void {
    this.metrics.totalScreened++;
    if (result.action === 'block') this.metrics.blocked++;
    else if (result.action === 'flag') this.metrics.flagged++;
    else this.metrics.allowed++;

    // Rolling average latency
    this.metrics.avgLatencyMs =
      this.metrics.avgLatencyMs +
      (result.latencyMs - this.metrics.avgLatencyMs) / this.metrics.totalScreened;
  }

  private freshMetrics(): DefenseMetrics {
    return {
      totalScreened: 0,
      blocked: 0,
      flagged: 0,
      allowed: 0,
      avgLatencyMs: 0,
      canaryLeaks: 0,
      classifierTimeouts: 0,
    };
  }
}

// Re-export types for convenience
export type {
  InjectionDefenseConfig,
  ScreenInput,
  ScreenResult,
  ScanResult,
  LayerScores,
  DetectionRule,
  InjectionClassifier,
  DefenseMetrics,
} from './types.js';

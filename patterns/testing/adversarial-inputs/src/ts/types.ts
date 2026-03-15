/**
 * Adversarial Inputs — Type definitions
 *
 * Defines the interfaces for attack categories, generators, judges,
 * and test reporting used by the AdversarialHarness.
 */

export type AttackCategory =
  | 'prompt-injection'
  | 'unicode-smuggling'
  | 'input-overflow'
  | 'encoding-bypass'
  | 'multilingual'
  | 'output-manipulation';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type TestVerdict = 'pass' | 'fail';

export interface TestCase {
  id: string;
  category: AttackCategory;
  name: string;
  input: string;
  // What a vulnerable response would look like (for judge context)
  expectedVulnerablePattern?: string;
  metadata?: Record<string, unknown>;
}

export interface TestResult {
  testCase: TestCase;
  response: string;
  verdict: TestVerdict;
  severity: Severity;
  reason: string;
  durationMs: number;
  error?: string;
}

export interface CategoryResult {
  category: AttackCategory;
  total: number;
  passed: number;
  failed: number;
  // Attack Success Rate — percentage of tests where the system was vulnerable
  attackSuccessRate: number;
  results: TestResult[];
  durationMs: number;
}

export interface TestReport {
  timestamp: string;
  categories: CategoryResult[];
  summary: ReportSummary;
  config: RunConfig;
}

export interface ReportSummary {
  totalTests: number;
  totalPassed: number;
  totalFailed: number;
  overallASR: number;
  criticalFailures: number;
  highFailures: number;
  // Whether the run should be considered a failure based on failOnSeverity
  shouldFail: boolean;
  regressions: RegressionDiff[];
}

export interface RegressionDiff {
  testCaseId: string;
  category: AttackCategory;
  previousVerdict: TestVerdict;
  currentVerdict: TestVerdict;
  description: string;
}

export interface RunConfig {
  categories: AttackCategory[];
  casesPerCategory: number;
  maxConcurrency: number;
  timeoutMs: number;
  severityThreshold: Severity;
  failOnSeverity: Severity;
  includePassingCases: boolean;
  baselineResults?: TestReport;
}

export const DEFAULT_CONFIG: RunConfig = {
  categories: [
    'prompt-injection',
    'unicode-smuggling',
    'input-overflow',
    'encoding-bypass',
    'multilingual',
    'output-manipulation',
  ],
  casesPerCategory: 50,
  maxConcurrency: 10,
  timeoutMs: 30_000,
  severityThreshold: 'low',
  failOnSeverity: 'high',
  includePassingCases: false,
};

/**
 * A function that takes user input and returns the LLM system's response.
 * This is the "target" being tested — it can be a raw model call,
 * a full RAG pipeline, or an agent with tool access.
 */
export type TargetFunction = (input: string) => Promise<string>;

/**
 * Generates adversarial test cases for a specific attack category.
 */
export interface InputGenerator {
  category: AttackCategory;
  generate(count: number): TestCase[];
}

/**
 * Evaluates whether a response indicates a vulnerability.
 */
export interface ResponseJudge {
  judge(testCase: TestCase, response: string): { verdict: TestVerdict; severity: Severity; reason: string };
}

// Severity ordering for comparison
const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function severityAtLeast(severity: Severity, threshold: Severity): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[threshold];
}

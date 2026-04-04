export interface AgentAction {
  /** Unique identifier for this action instance (for idempotency) */
  id: string;
  /** Action type name, used to look up compliance categories */
  type: string;
  /** Arbitrary action payload */
  payload: unknown;
  /** Agent's self-reported confidence in [0, 1] */
  confidence: number;
  /** Estimated number of records/users affected */
  affectedCount: number;
  /** Whether this action can be undone after execution */
  irreversible: boolean;
  /** Regulatory/compliance categories for this action */
  complianceFlags: string[];
  /** Agent's reasoning for reviewer context */
  reasoningTrace: string;
}

export type ReviewTier = 'auto' | 'team' | 'escalate';

export interface RoutingDecision {
  tier: ReviewTier;
  /** Factors that drove this routing decision */
  reasons: string[];
}

export type ReviewOutcome = 'approved' | 'modified' | 'rejected';

export interface ReviewDecision {
  reviewId: string;
  actionId: string;
  outcome: ReviewOutcome;
  /** Reviewer-modified payload (only when outcome === 'modified') */
  modifiedPayload?: unknown;
  rationale?: string;
  reviewedAt: Date;
  reviewerId?: string;
}

export interface CheckpointedAction {
  reviewId: string;
  action: AgentAction;
  tier: ReviewTier;
  enqueuedAt: Date;
  slaDeadline: Date;
  decision?: ReviewDecision;
  status: 'pending' | 'decided' | 'timed_out' | 'escalated';
}

export interface ActionOutcome {
  actionId: string;
  reviewId: string;
  executionSuccess: boolean;
  errorMessage?: string;
  executedAt: Date;
}

export interface CalibrationRecord {
  confidence: number;
  correct: boolean;
  actionType: string;
  recordedAt: Date;
}

export interface HumanInTheLoopConfig {
  /** Confidence at or above this proceeds without review. Default: 0.85 */
  autoApproveThreshold: number;
  /** Confidence below this goes to escalation tier. Default: 0.60 */
  escalateThreshold: number;
  /** Team review SLA in milliseconds. Default: 4h */
  teamReviewSlaMs: number;
  /** Escalation SLA in milliseconds. Default: 1h */
  escalationSlaMs: number;
  /** Actions affecting more records than this go to review regardless of confidence. Default: 100 */
  blastRadiusThreshold: number;
  /**
   * Compliance categories that always bypass the confidence check and go to escalation.
   * Default: ['financial', 'medical', 'legal']
   */
  mandatoryEscalationCategories: string[];
  /**
   * Action types not in this set are treated as unregistered and sent to escalation.
   * If null, all action types are allowed (no whitelist enforcement).
   */
  registeredActionTypes: Set<string> | null;
}

export const DEFAULT_CONFIG: HumanInTheLoopConfig = {
  autoApproveThreshold: 0.85,
  escalateThreshold: 0.60,
  teamReviewSlaMs: 4 * 60 * 60 * 1000,   // 4h
  escalationSlaMs: 1 * 60 * 60 * 1000,    // 1h
  blastRadiusThreshold: 100,
  mandatoryEscalationCategories: ['financial', 'medical', 'legal'],
  registeredActionTypes: null,
};

import { ReviewDecision, CheckpointedAction, ReviewOutcome } from './types.js';

export interface MockReviewerConfig {
  /** Simulated decision latency in ms. Default: 100 */
  decisionLatencyMs: number;
  /**
   * Per-action-type forced outcomes. Falls back to defaultApprovalRate.
   * e.g. { 'delete_record': 'rejected', 'send_email': 'approved' }
   */
  actionTypeOutcomes?: Record<string, ReviewOutcome>;
  /** Fraction of items approved when no forced outcome. Default: 0.9 */
  defaultApprovalRate: number;
  /**
   * If true, reviewer takes longer than the SLA deadline.
   * Used to test timeout escalation behavior.
   */
  simulateSlaBreach?: boolean;
  /** Reviewer ID to stamp on decisions */
  reviewerId?: string;
}

const DEFAULT_REVIEWER_CONFIG: MockReviewerConfig = {
  decisionLatencyMs: 100,
  defaultApprovalRate: 0.9,
  simulateSlaBreach: false,
  reviewerId: 'mock-reviewer-1',
};

/**
 * In-memory state store simulating a durable checkpoint backend.
 * Real systems would use PostgreSQL or Redis here.
 */
export class MockStateStore {
  private store = new Map<string, CheckpointedAction>();

  save(checkpoint: CheckpointedAction): void {
    this.store.set(checkpoint.reviewId, { ...checkpoint });
  }

  load(reviewId: string): CheckpointedAction | undefined {
    const record = this.store.get(reviewId);
    return record ? { ...record } : undefined;
  }

  update(reviewId: string, updates: Partial<CheckpointedAction>): void {
    const existing = this.store.get(reviewId);
    if (!existing) throw new Error(`Review ${reviewId} not found in state store`);
    this.store.set(reviewId, { ...existing, ...updates });
  }

  all(): CheckpointedAction[] {
    return Array.from(this.store.values()).map(r => ({ ...r }));
  }

  size(): number {
    return this.store.size;
  }
}

/**
 * Mock reviewer that simulates human review decisions.
 * Supports configurable latency, forced outcomes, and SLA breach simulation.
 */
export class MockReviewer {
  private config: MockReviewerConfig;
  private callCount = 0;

  constructor(config: Partial<MockReviewerConfig> = {}) {
    this.config = { ...DEFAULT_REVIEWER_CONFIG, ...config };
  }

  async decide(checkpoint: CheckpointedAction): Promise<ReviewDecision> {
    this.callCount++;

    if (this.config.simulateSlaBreach) {
      // Simulate reviewer not responding in time; caller must handle timeout
      await new Promise(resolve => setTimeout(resolve, checkpoint.slaDeadline.getTime() + 1000 - Date.now()));
    } else {
      await new Promise(resolve => setTimeout(resolve, this.config.decisionLatencyMs));
    }

    const outcome = this.resolveOutcome(checkpoint.action.type);

    return {
      reviewId: checkpoint.reviewId,
      actionId: checkpoint.action.id,
      outcome,
      rationale: `Mock reviewer: ${outcome}`,
      reviewedAt: new Date(),
      reviewerId: this.config.reviewerId,
    };
  }

  private resolveOutcome(actionType: string): ReviewOutcome {
    if (this.config.actionTypeOutcomes?.[actionType]) {
      return this.config.actionTypeOutcomes[actionType];
    }
    return Math.random() < this.config.defaultApprovalRate ? 'approved' : 'rejected';
  }

  getCallCount(): number {
    return this.callCount;
  }

  reset(): void {
    this.callCount = 0;
  }
}

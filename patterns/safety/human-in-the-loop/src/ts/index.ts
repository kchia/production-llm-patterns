import { randomUUID } from 'crypto';
import {
  AgentAction,
  ActionOutcome,
  CalibrationRecord,
  CheckpointedAction,
  DEFAULT_CONFIG,
  HumanInTheLoopConfig,
  ReviewDecision,
  ReviewTier,
  RoutingDecision,
} from './types.js';
import { MockStateStore } from './mock-provider.js';

export class TimeoutError extends Error {
  constructor(public readonly reviewId: string, public readonly tier: ReviewTier) {
    super(`Review ${reviewId} (tier: ${tier}) exceeded SLA`);
    this.name = 'TimeoutError';
  }
}

export class UnregisteredActionTypeError extends Error {
  constructor(public readonly actionType: string) {
    super(`Action type "${actionType}" is not registered in the compliance registry`);
    this.name = 'UnregisteredActionTypeError';
  }
}

type ReviewerFn = (checkpoint: CheckpointedAction) => Promise<ReviewDecision>;

/**
 * Human-in-the-Loop gate.
 *
 * Classify actions by risk, route to the appropriate review tier,
 * persist state for durability, and record outcomes for calibration.
 */
export class HumanInTheLoopGate {
  private config: HumanInTheLoopConfig;
  private stateStore: MockStateStore;
  private reviewerFn: ReviewerFn | null;
  private calibrationLog: CalibrationRecord[] = [];
  private outcomeLog: ActionOutcome[] = [];

  constructor(
    config: Partial<HumanInTheLoopConfig> = {},
    stateStore: MockStateStore = new MockStateStore(),
    reviewerFn: ReviewerFn | null = null,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.stateStore = stateStore;
    this.reviewerFn = reviewerFn;
  }

  /**
   * Evaluate an action and return a routing decision.
   *
   * Throws UnregisteredActionTypeError if registeredActionTypes is set
   * and the action type isn't in the set.
   */
  evaluate(action: AgentAction): RoutingDecision {
    const reasons: string[] = [];

    // Unregistered action types always escalate — unknown compliance risk
    if (
      this.config.registeredActionTypes !== null &&
      !this.config.registeredActionTypes.has(action.type)
    ) {
      throw new UnregisteredActionTypeError(action.type);
    }

    // Compliance flags override confidence entirely
    const hasComplianceFlag = action.complianceFlags.some(flag =>
      this.config.mandatoryEscalationCategories.includes(flag),
    );
    if (hasComplianceFlag) {
      reasons.push(`compliance flag: ${action.complianceFlags.join(', ')}`);
      return { tier: 'escalate', reasons };
    }

    // High blast radius overrides confidence — bulk operations warrant review
    if (action.affectedCount > this.config.blastRadiusThreshold) {
      reasons.push(`blast radius ${action.affectedCount} > threshold ${this.config.blastRadiusThreshold}`);
      // Don't auto-escalate on blast radius alone; route to team review
      return { tier: 'team', reasons };
    }

    // Route by confidence score
    if (action.confidence < this.config.escalateThreshold) {
      reasons.push(`confidence ${action.confidence.toFixed(2)} < escalate threshold ${this.config.escalateThreshold}`);
      return { tier: 'escalate', reasons };
    }

    if (action.confidence < this.config.autoApproveThreshold) {
      reasons.push(`confidence ${action.confidence.toFixed(2)} < auto-approve threshold ${this.config.autoApproveThreshold}`);
      // Irreversible actions in the middle band go to escalation for safety
      if (action.irreversible) {
        reasons.push('irreversible action in confidence band → escalating');
        return { tier: 'escalate', reasons };
      }
      return { tier: 'team', reasons };
    }

    // High confidence + reversible + no flags → auto-approve
    reasons.push(`confidence ${action.confidence.toFixed(2)} >= auto-approve threshold`);
    return { tier: 'auto', reasons };
  }

  /**
   * Checkpoint the action and enqueue it for review.
   * Checkpointing happens before the pause — state survives process restart.
   */
  enqueue(action: AgentAction, tier: ReviewTier): string {
    const reviewId = randomUUID();
    const now = new Date();
    const slaMs = tier === 'escalate' ? this.config.escalationSlaMs : this.config.teamReviewSlaMs;

    const checkpoint: CheckpointedAction = {
      reviewId,
      action,
      tier,
      enqueuedAt: now,
      slaDeadline: new Date(now.getTime() + slaMs),
      status: 'pending',
    };

    // Checkpoint before returning to caller — durability guarantee
    this.stateStore.save(checkpoint);
    return reviewId;
  }

  /**
   * Wait for a reviewer decision.
   *
   * In production, this polls the state store or subscribes to a notification channel.
   * This implementation polls the provided reviewerFn to simulate async review.
   *
   * Throws TimeoutError if the SLA is exceeded.
   */
  async awaitDecision(
    reviewId: string,
    reviewerFn?: ReviewerFn,
  ): Promise<ReviewDecision> {
    const checkpoint = this.stateStore.load(reviewId);
    if (!checkpoint) throw new Error(`Review ${reviewId} not found`);

    const fn = reviewerFn ?? this.reviewerFn;
    if (!fn) throw new Error('No reviewer function provided');

    const timeoutMs = checkpoint.slaDeadline.getTime() - Date.now();
    if (timeoutMs <= 0) {
      this.stateStore.update(reviewId, { status: 'timed_out' });
      throw new TimeoutError(reviewId, checkpoint.tier);
    }

    // Race the reviewer against the SLA deadline
    const decisionPromise = fn(checkpoint);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => {
        this.stateStore.update(reviewId, { status: 'timed_out' });
        reject(new TimeoutError(reviewId, checkpoint.tier));
      }, timeoutMs),
    );

    const decision = await Promise.race([decisionPromise, timeoutPromise]);
    this.stateStore.update(reviewId, { decision, status: 'decided' });
    return decision;
  }

  /**
   * Record action execution outcome for calibration.
   * Pairs with the original confidence score to compute ECE over time.
   */
  recordOutcome(reviewId: string, outcome: ActionOutcome): void {
    this.outcomeLog.push(outcome);

    const checkpoint = this.stateStore.load(reviewId);
    if (!checkpoint) return;

    // Record (confidence, correct) pair for ECE calibration
    this.calibrationLog.push({
      confidence: checkpoint.action.confidence,
      correct: outcome.executionSuccess,
      actionType: checkpoint.action.type,
      recordedAt: new Date(),
    });
  }

  /**
   * Full gate flow: evaluate → enqueue (if needed) → await decision → return.
   *
   * Returns the resolved payload to execute (original or reviewer-modified),
   * or null if rejected.
   */
  async process(
    action: AgentAction,
    reviewerFn?: ReviewerFn,
  ): Promise<{ payload: unknown; reviewId: string | null; tier: ReviewTier } | null> {
    const routing = this.evaluate(action);

    if (routing.tier === 'auto') {
      return { payload: action.payload, reviewId: null, tier: 'auto' };
    }

    const reviewId = this.enqueue(action, routing.tier);
    let decision: ReviewDecision;

    try {
      decision = await this.awaitDecision(reviewId, reviewerFn);
    } catch (err) {
      if (err instanceof TimeoutError) {
        // Timeout policy: irreversible actions default-reject; others escalate
        if (action.irreversible) {
          return null; // rejected by timeout
        }
        // For reversible actions in team queue, escalate to next tier
        if (routing.tier === 'team') {
          const escalationId = this.enqueue(action, 'escalate');
          decision = await this.awaitDecision(escalationId, reviewerFn);
        } else {
          return null; // escalation also timed out → reject
        }
      } else {
        throw err;
      }
    }

    if (decision.outcome === 'rejected') return null;

    const resolvedPayload =
      decision.outcome === 'modified' && decision.modifiedPayload !== undefined
        ? decision.modifiedPayload
        : action.payload;

    return { payload: resolvedPayload, reviewId, tier: routing.tier };
  }

  // --- Calibration & Metrics ---

  /**
   * Compute Expected Calibration Error (ECE) over recorded calibration pairs.
   *
   * ECE = avg |confidence - accuracy| across equal-frequency bins.
   * A score of 0.10 means items labeled "90% confident" are accurate only 80% of the time.
   */
  computeECE(bins = 10): number {
    if (this.calibrationLog.length === 0) return 0;

    const binSize = 1 / bins;
    let weightedError = 0;
    let totalCount = 0;

    for (let b = 0; b < bins; b++) {
      const lo = b * binSize;
      const hi = lo + binSize;
      const inBin = this.calibrationLog.filter(r => r.confidence >= lo && r.confidence < hi);
      if (inBin.length === 0) continue;

      const avgConfidence = inBin.reduce((s, r) => s + r.confidence, 0) / inBin.length;
      const accuracy = inBin.filter(r => r.correct).length / inBin.length;
      weightedError += inBin.length * Math.abs(avgConfidence - accuracy);
      totalCount += inBin.length;
    }

    return totalCount === 0 ? 0 : weightedError / totalCount;
  }

  getCalibrationLog(): CalibrationRecord[] {
    return [...this.calibrationLog];
  }

  getOutcomeLog(): ActionOutcome[] {
    return [...this.outcomeLog];
  }

  getQueueSnapshot(): CheckpointedAction[] {
    return this.stateStore.all();
  }

  getQueueDepthByTier(): Record<ReviewTier, number> {
    const pending = this.stateStore.all().filter(c => c.status === 'pending');
    return {
      auto: 0,
      team: pending.filter(c => c.tier === 'team').length,
      escalate: pending.filter(c => c.tier === 'escalate').length,
    };
  }
}

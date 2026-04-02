/**
 * Cost Dashboard — Core Implementation
 *
 * Tracks, attributes, and aggregates LLM API spend.
 * Three layers:
 *   1. CostTrackingMiddleware — wraps every LLM call, attaches attribution,
 *      computes cost, emits CostEvent.
 *   2. InMemorySpendStore — persists raw events and pre-aggregated rollups.
 *   3. CostDashboard — query API + alert engine on top of the store.
 *
 * The InMemorySpendStore is sufficient for testing and single-process deployments.
 * Production deployments should swap it for a time-series store (e.g., ClickHouse,
 * TimescaleDB, or a vendor like Datadog/Grafana).
 */

import {
  Alert,
  AlertConfig,
  BUILT_IN_PRICES,
  CostDashboardConfig,
  CostEvent,
  DEFAULT_CONFIG,
  GroupByDimension,
  ModelPrice,
  QueryParams,
  SpendSummary,
} from './types.js';

// ─── Spend Store ──────────────────────────────────────────────────────────────

export class InMemorySpendStore {
  /** Raw event log. In production, write to an append-only store. */
  private events: CostEvent[] = [];

  record(event: CostEvent): void {
    this.events.push(event);
  }

  /** Returns all events within [startTime, endTime]. */
  getEvents(startTime: Date, endTime: Date): CostEvent[] {
    return this.events.filter(
      e => e.timestamp >= startTime && e.timestamp <= endTime
    );
  }

  /** Returns all events, unfiltered. Useful for alert engine baselines. */
  getAllEvents(): CostEvent[] {
    return this.events;
  }

  /** Clears all stored events. Used by tests only. */
  clear(): void {
    this.events = [];
  }

  size(): number {
    return this.events.length;
  }
}

// ─── Alert Engine ─────────────────────────────────────────────────────────────

/**
 * Evaluates spend data against configured thresholds and returns any fired alerts.
 * Runs on demand (pull model) — production systems would run this on a schedule.
 */
export class AlertEngine {
  private config: AlertConfig;

  constructor(config: AlertConfig) {
    this.config = config;
  }

  evaluate(store: InMemorySpendStore, priceTableAge: number): Alert[] {
    const alerts: Alert[] = [];
    const now = new Date();

    // Price table staleness check
    const staleThresholdMs = 2 * 60 * 60 * 1000; // 2 hours = warning
    const criticalStaleMs  = 6 * 60 * 60 * 1000; // 6 hours = critical
    if (priceTableAge > criticalStaleMs) {
      alerts.push({
        type: 'priceTableStale',
        severity: 'critical',
        message: `Price table last refreshed ${Math.round(priceTableAge / 3600000)}h ago — cost calculations may be wrong`,
        context: { ageHours: Math.round(priceTableAge / 3600000) },
        firedAt: now,
      });
    } else if (priceTableAge > staleThresholdMs) {
      alerts.push({
        type: 'priceTableStale',
        severity: 'warning',
        message: `Price table last refreshed ${Math.round(priceTableAge / 3600000)}h ago`,
        context: { ageHours: Math.round(priceTableAge / 3600000) },
        firedAt: now,
      });
    }

    const allEvents = store.getAllEvents();
    if (allEvents.length === 0) return alerts;

    // Spike detection: compare current window vs. rolling baseline window.
    // Uses feature dimension as the spike detection key.
    const currentWindowMs  = this.config.currentWindowHours  * 3600 * 1000;
    const baselineWindowMs = this.config.baselineWindowHours * 3600 * 1000;
    const currentWindowStart  = new Date(now.getTime() - currentWindowMs);
    const baselineWindowStart = new Date(now.getTime() - baselineWindowMs);

    const currentEvents  = allEvents.filter(e => e.timestamp >= currentWindowStart);
    const baselineEvents = allEvents.filter(
      e => e.timestamp >= baselineWindowStart && e.timestamp < currentWindowStart
    );

    const currentByFeature  = groupByFeature(currentEvents);
    const baselineByFeature = groupByFeature(baselineEvents);

    // Normalize baseline to the same window length as current for fair comparison.
    const baselineNormFactor = baselineWindowMs > 0
      ? currentWindowMs / baselineWindowMs
      : 1;

    for (const [feature, currentSpend] of currentByFeature.entries()) {
      const baselineSpend = (baselineByFeature.get(feature) ?? 0) * baselineNormFactor;
      if (baselineSpend > 0 && currentSpend > baselineSpend * this.config.spikeSensitivity) {
        const multiple = (currentSpend / baselineSpend).toFixed(1);
        alerts.push({
          type: 'spike',
          severity: currentSpend > baselineSpend * this.config.spikeSensitivity * 2
            ? 'critical' : 'warning',
          message: `Spend spike detected for feature "${feature}": ${multiple}× baseline`,
          context: { feature, currentSpendUsd: currentSpend, baselineSpendUsd: baselineSpend, multiple },
          firedAt: now,
        });
      }
    }

    // Concentration risk: if one feature accounts for > threshold of total spend.
    const windowEvents = store.getEvents(currentWindowStart, now);
    const totalSpend = windowEvents.reduce((sum, e) => sum + e.costUsd, 0);
    if (totalSpend > 0) {
      for (const [feature, spend] of groupByFeature(windowEvents).entries()) {
        const fraction = spend / totalSpend;
        if (fraction > this.config.concentrationRiskThreshold) {
          alerts.push({
            type: 'concentrationRisk',
            severity: fraction > 0.60 ? 'critical' : 'warning',
            message: `Feature "${feature}" accounts for ${Math.round(fraction * 100)}% of spend`,
            context: { feature, fraction, totalSpendUsd: totalSpend },
            firedAt: now,
          });
        }
      }
    }

    // Missing tags: count events with "unknown" feature dimension.
    const unknownCount = allEvents.filter(e => e.feature === 'unknown').length;
    const unknownFraction = unknownCount / allEvents.length;
    if (unknownFraction > 0.25) {
      alerts.push({
        type: 'missingTags',
        severity: 'critical',
        message: `${Math.round(unknownFraction * 100)}% of events have no feature attribution`,
        context: { unknownCount, totalEvents: allEvents.length, unknownFraction },
        firedAt: now,
      });
    } else if (unknownFraction > 0.10) {
      alerts.push({
        type: 'missingTags',
        severity: 'warning',
        message: `${Math.round(unknownFraction * 100)}% of events have no feature attribution`,
        context: { unknownCount, totalEvents: allEvents.length, unknownFraction },
        firedAt: now,
      });
    }

    return alerts;
  }
}

function groupByFeature(events: CostEvent[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const e of events) {
    map.set(e.feature, (map.get(e.feature) ?? 0) + e.costUsd);
  }
  return map;
}

// ─── Price Table ──────────────────────────────────────────────────────────────

export class PriceTable {
  private prices: Map<string, ModelPrice>;
  private lastRefreshed: Date;

  constructor(initialPrices: ModelPrice[] = BUILT_IN_PRICES) {
    this.prices = new Map(initialPrices.map(p => [p.model, p]));
    this.lastRefreshed = new Date();
  }

  /**
   * Compute cost in USD for a completed request.
   * Falls back to $0 if model isn't in the table — callers should alert on $0 costs.
   */
  computeCost(model: string, inputTokens: number, outputTokens: number): number {
    const price = this.prices.get(model);
    if (!price) return 0;
    return (
      (inputTokens  / 1_000_000) * price.inputPricePerMillionTokens +
      (outputTokens / 1_000_000) * price.outputPricePerMillionTokens
    );
  }

  /** Update one or more model prices (e.g., after fetching from provider). */
  updatePrices(newPrices: ModelPrice[]): void {
    for (const p of newPrices) {
      this.prices.set(p.model, p);
    }
    this.lastRefreshed = new Date();
  }

  /** Age of the price table in milliseconds. */
  ageMs(): number {
    return Date.now() - this.lastRefreshed.getTime();
  }

  getLastRefreshed(): Date {
    return this.lastRefreshed;
  }

  hasModel(model: string): boolean {
    return this.prices.has(model);
  }
}

// ─── Cost Dashboard ───────────────────────────────────────────────────────────

export class CostDashboard {
  private store: InMemorySpendStore;
  private priceTable: PriceTable;
  private alertEngine: AlertEngine;
  private config: CostDashboardConfig;
  private missingTagCount: Map<string, number> = new Map();

  constructor(
    config: Partial<CostDashboardConfig> = {},
    store?: InMemorySpendStore,
    priceTable?: PriceTable,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.store = store ?? new InMemorySpendStore();
    this.priceTable = priceTable ?? new PriceTable();
    this.alertEngine = new AlertEngine(this.config.alertConfig);
  }

  /**
   * Record a completed LLM request.
   *
   * Validates required tags, computes cost, and writes to the store.
   * Missing required tags are logged and the dimension is set to "unknown"
   * rather than silently dropping the event — attribution quality degrades
   * visibly rather than invisibly.
   */
  record(event: Omit<CostEvent, 'costUsd'>): CostEvent {
    // Validate required tags and fall back to "unknown" for missing ones.
    const resolvedEvent: CostEvent = {
      ...event,
      costUsd: this.priceTable.computeCost(event.model, event.inputTokens, event.outputTokens),
    };

    for (const tag of this.config.requiredTags) {
      if (tag === 'feature' && (!event.feature || event.feature === '')) {
        console.warn(`[CostDashboard] Missing required tag "feature" on request ${event.requestId}`);
        this.missingTagCount.set('feature', (this.missingTagCount.get('feature') ?? 0) + 1);
        resolvedEvent.feature = 'unknown';
      }
    }

    // Warn if model is unknown — cost will be $0 and invoice will diverge.
    if (!this.priceTable.hasModel(event.model)) {
      console.warn(`[CostDashboard] Unknown model "${event.model}" — cost recorded as $0. Add it to the price table.`);
    }

    this.store.record(resolvedEvent);
    return resolvedEvent;
  }

  /**
   * Query spend aggregated by a dimension over a time range.
   * Results are sorted by totalCostUsd descending (highest spend first).
   */
  query(params: QueryParams): SpendSummary[] {
    const events = this.store.getEvents(params.startTime, params.endTime);

    // Apply filters before grouping.
    const filtered = events.filter(e => {
      if (params.filters?.feature && e.feature !== params.filters.feature) return false;
      if (params.filters?.model   && e.model   !== params.filters.model)   return false;
      if (params.filters?.userId  && e.userId  !== params.filters.userId)  return false;
      if (params.filters?.teamId  && e.teamId  !== params.filters.teamId)  return false;
      return true;
    });

    // Group by the requested dimension.
    const grouped = new Map<string, CostEvent[]>();
    for (const event of filtered) {
      const key = this.getDimensionValue(event, params.groupBy);
      const bucket = grouped.get(key) ?? [];
      bucket.push(event);
      grouped.set(key, bucket);
    }

    const summaries: SpendSummary[] = [];
    for (const [dimensionValue, group] of grouped.entries()) {
      const totalCostUsd = group.reduce((s, e) => s + e.costUsd, 0);

      if (params.minCostUsd !== undefined && totalCostUsd < params.minCostUsd) continue;

      summaries.push({
        dimensionValue,
        totalCostUsd,
        totalRequests: group.length,
        totalInputTokens:  group.reduce((s, e) => s + e.inputTokens,  0),
        totalOutputTokens: group.reduce((s, e) => s + e.outputTokens, 0),
        avgCostPerRequestUsd: totalCostUsd / group.length,
        startTime: params.startTime,
        endTime:   params.endTime,
      });
    }

    return summaries.sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  }

  private getDimensionValue(event: CostEvent, dim: GroupByDimension): string {
    switch (dim) {
      case 'feature':       return event.feature;
      case 'model':         return event.model;
      case 'user':          return event.userId ?? 'anonymous';
      case 'promptVersion': return event.promptVersion;
      case 'team':          return event.teamId ?? 'unassigned';
    }
  }

  /** Compute cost without recording — useful for pre-flight estimates. */
  computeCost(model: string, inputTokens: number, outputTokens: number): number {
    return this.priceTable.computeCost(model, inputTokens, outputTokens);
  }

  /** Evaluate all alert thresholds and return fired alerts. */
  checkAlerts(): Alert[] {
    return this.alertEngine.evaluate(this.store, this.priceTable.ageMs());
  }

  /** Update the price table (e.g., after fetching from provider). */
  updatePrices(newPrices: ModelPrice[]): void {
    this.priceTable.updatePrices(newPrices);
  }

  getMissingTagCounts(): Map<string, number> {
    return new Map(this.missingTagCount);
  }

  getStore(): InMemorySpendStore {
    return this.store;
  }

  getPriceTable(): PriceTable {
    return this.priceTable;
  }
}

// ─── Middleware Helper ────────────────────────────────────────────────────────

export interface LLMCallContext {
  feature: string;
  model: string;
  promptVersion?: string;
  userId?: string;
  teamId?: string;
  tags?: Record<string, string>;
}

/**
 * Wraps a provider call to automatically record the cost event.
 *
 * Usage:
 *   const response = await trackCost(dashboard, provider, prompt, {
 *     feature: 'document-analysis',
 *     model: 'gpt-4o',
 *     promptVersion: 'v2.1',
 *   });
 */
export async function trackCost<T extends { usage: { inputTokens: number; outputTokens: number }; model: string }>(
  dashboard: CostDashboard,
  fn: () => Promise<T>,
  context: LLMCallContext,
): Promise<T> {
  const startMs = Date.now();
  const result  = await fn();
  const latencyMs = Date.now() - startMs;

  dashboard.record({
    timestamp:     new Date(),
    requestId:     `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    feature:       context.feature,
    model:         result.model ?? context.model,
    promptVersion: context.promptVersion ?? 'unversioned',
    userId:        context.userId,
    teamId:        context.teamId,
    inputTokens:   result.usage.inputTokens,
    outputTokens:  result.usage.outputTokens,
    latencyMs,
    tags:          context.tags ?? {},
  });

  return result;
}

// Re-export everything callers need from a single import.
export { CostEvent, SpendSummary, QueryParams, Alert, AlertConfig, ModelPrice, CostDashboardConfig, GroupByDimension } from './types.js';

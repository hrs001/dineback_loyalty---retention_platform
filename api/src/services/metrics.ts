import { getDb } from "../lib/mongo.js";
import type { OutboxEvent } from "../models/types.js";

/**
 * Slice 5 observability (design doc: "pino structured logging + 2 visible
 * metrics — webhook success rate, event lag"). Deliberately lightweight —
 * an in-memory counter and a Mongo aggregation, not a time-series metrics
 * store. Honest tradeoff for this project's scale, named explicitly in the
 * README's "what I'd do differently at 10x" section: at real scale this
 * moves to a proper metrics backend (Prometheus/CloudWatch), since these
 * in-memory counters reset on every process restart and only cover the API
 * process instance that happens to be running.
 */

let webhookTotal = 0;
let webhookSucceeded = 0;

export function recordWebhookOutcome(success: boolean): void {
  webhookTotal += 1;
  if (success) webhookSucceeded += 1;
}

export interface WebhookStats {
  total: number;
  succeeded: number;
  successRate: number | null;
}

export function getWebhookStats(): WebhookStats {
  return {
    total: webhookTotal,
    succeeded: webhookSucceeded,
    successRate: webhookTotal === 0 ? null : webhookSucceeded / webhookTotal,
  };
}

export interface EventLagStats {
  sampleSize: number;
  avgLagMs: number | null;
}

/**
 * Real, persisted event lag — createdAt (outbox write) to processedAt (the
 * consumer marking it done) — over the most recently processed events for
 * a tenant. Never fabricated: a tenant with nothing processed yet reports
 * `avgLagMs: null`, not a fake zero.
 */
export async function getEventLagStats(tenantId: string, sampleSize = 50): Promise<EventLagStats> {
  const db = getDb();
  const recent = await db
    .collection<OutboxEvent>("outbox_events")
    .find({ tenantId, processed: true, processedAt: { $exists: true } })
    .sort({ processedAt: -1 })
    .limit(sampleSize)
    .toArray();

  if (recent.length === 0) {
    return { sampleSize: 0, avgLagMs: null };
  }

  const totalLagMs = recent.reduce(
    (sum, event) => sum + (new Date(event.processedAt as Date).getTime() - new Date(event.createdAt).getTime()),
    0
  );

  return { sampleSize: recent.length, avgLagMs: Math.round(totalLagMs / recent.length) };
}

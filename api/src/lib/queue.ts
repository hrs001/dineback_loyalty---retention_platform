import { Queue } from "bullmq";
import { env } from "./env.js";

export const RETENTION_QUEUE_NAME = "retention-agent";
export const AUDIT_QUEUE_NAME = "audit-agent";

export interface RetentionJobData {
  tenantId: string;
}

export interface AuditJobData {
  tenantId: string;
  url: string;
}

let retentionQueue: Queue<RetentionJobData> | null = null;
let auditQueue: Queue<AuditJobData> | null = null;

/** Lazily constructed so importing this module never opens a Redis connection by itself. */
export function getRetentionQueue(): Queue<RetentionJobData> {
  retentionQueue ??= new Queue<RetentionJobData>(RETENTION_QUEUE_NAME, {
    connection: { url: env.redisUrl },
  });
  return retentionQueue;
}

/**
 * Slice 4 — same BullMQ infrastructure as the retention queue (design
 * doc's "reuses C's ... job queue" framing for D), a distinct queue so the
 * two agent job types don't share backpressure/concurrency semantics.
 */
export function getAuditQueue(): Queue<AuditJobData> {
  auditQueue ??= new Queue<AuditJobData>(AUDIT_QUEUE_NAME, {
    connection: { url: env.redisUrl },
  });
  return auditQueue;
}

export async function closeRetentionQueue(): Promise<void> {
  await retentionQueue?.close();
  retentionQueue = null;
}

export async function closeAuditQueue(): Promise<void> {
  await auditQueue?.close();
  auditQueue = null;
}

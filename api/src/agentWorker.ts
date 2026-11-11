import { Worker } from "bullmq";
import { connectMongo } from "./lib/mongo.js";
import { logger } from "./lib/logger.js";
import { env, listKnownTenantIds } from "./lib/env.js";
import {
  RETENTION_QUEUE_NAME,
  AUDIT_QUEUE_NAME,
  getRetentionQueue,
  type RetentionJobData,
  type AuditJobData,
} from "./lib/queue.js";
import { runRetentionBatch } from "./services/retentionAgent.js";
import { runAudit } from "./services/auditAgent.js";

/**
 * Entrypoint for the agent-job worker — its own process (see the System
 * Architecture diagram: "[Retention agent worker]" / "[Audit agent
 * worker]"), separate from both the API and the Consumer. Run it with
 * `node dist/agentWorker.js`.
 *
 * Hosts both the retention and audit BullMQ workers in one process rather
 * than two separate deployables — they share identical job-queue,
 * concurrency, and Redis-connection infrastructure (the design doc's
 * "reuses C's plumbing" framing for D), and splitting them into their own
 * scalable worker fleets only pays off past this project's demo scale
 * (see the README's "what I'd do differently at 10x" section).
 */
async function main() {
  await connectMongo();

  const retentionWorker = new Worker<RetentionJobData>(
    RETENTION_QUEUE_NAME,
    async (job) => {
      const result = await runRetentionBatch(job.data.tenantId);
      logger.info({ tenantId: job.data.tenantId, result }, "retention batch complete");
      return result;
    },
    // One tenant-batch job at a time; Locked Contract #6's concurrency cap
    // (5) governs LLM calls *within* a batch, not how many batch jobs run
    // in parallel across tenants.
    { connection: { url: env.redisUrl }, concurrency: 1 }
  );

  retentionWorker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, tenantId: job?.data.tenantId, err }, "retention batch job failed");
  });

  const auditWorker = new Worker<AuditJobData>(
    AUDIT_QUEUE_NAME,
    async (job) => {
      const decision = await runAudit(job.data.tenantId, job.data.url);
      logger.info({ tenantId: job.data.tenantId, url: job.data.url, status: decision.status }, "audit job complete");
      return decision._id?.toString();
    },
    { connection: { url: env.redisUrl }, concurrency: 3 }
  );

  auditWorker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, tenantId: job?.data.tenantId, err }, "audit job failed");
  });

  const queue = getRetentionQueue();
  for (const tenantId of listKnownTenantIds()) {
    // upsertJobScheduler keys on `scheduled-${tenantId}` — re-registering
    // the same schedule on every worker restart updates it in place rather
    // than forking a second recurring job.
    await queue.upsertJobScheduler(
      `scheduled-${tenantId}`,
      { every: env.retentionScheduleIntervalMs },
      { name: "scheduled-sweep", data: { tenantId } }
    );
  }

  logger.info(
    { tenants: listKnownTenantIds(), intervalMs: env.retentionScheduleIntervalMs },
    "agent worker started — retention schedule registered, audit worker ready"
  );
}

main().catch((err) => {
  logger.error({ err }, "fatal agent worker startup error");
  process.exit(1);
});

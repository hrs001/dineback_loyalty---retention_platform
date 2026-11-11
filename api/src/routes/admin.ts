import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { resolveTenantFromAdminKey, UnauthorizedError } from "../services/tenantAuth.js";
import { listUnreplayedDeadLetters, markReplayed } from "../services/dlq.js";
import { processOutboxEvent } from "../services/consumer.js";
import type { OutboxEvent } from "../models/types.js";
import { approveDecision, listPendingApprovals, rejectDecision } from "../services/retentionAgent.js";
import { getAuditDecision } from "../services/auditAgent.js";
import { getRetentionQueue, getAuditQueue } from "../lib/queue.js";
import { createGeminiClient, type LLMClient } from "../services/llm.js";
import { seedHighValueLapsedCustomer, seedStaleOrders } from "../services/demoSeed.js";

const runAuditSchema = z.object({ url: z.string().url() });

/**
 * `llm` defaults to a real Gemini client for production; tests pass a fake
 * so `/admin/replay`'s retention-decision path doesn't depend on network
 * latency or on whether GEMINI_API_KEY happens to be configured locally.
 */
export function registerAdminRoutes(app: FastifyInstance, llm: LLMClient = createGeminiClient()): void {
  /**
   * Reprocesses every unreplayed dead-letter event for the caller's tenant.
   * Locked Contract #3: gated by a per-tenant admin API key.
   */
  app.post("/admin/replay", async (req, reply) => {
    let tenantId: string;
    try {
      tenantId = resolveTenantFromAdminKey(req);
    } catch (err) {
      if (err instanceof UnauthorizedError) return reply.code(401).send({ error: err.message });
      throw err;
    }

    const deadLetters = await listUnreplayedDeadLetters(tenantId);
    const results: { id: string; ok: boolean; error?: string }[] = [];

    for (const dl of deadLetters) {
      const syntheticEvent: OutboxEvent = {
        orderId: dl.payload._id,
        tenantId: dl.tenantId,
        type: "order.completed",
        payload: dl.payload,
        createdAt: dl.failedAt,
        processed: false,
      };
      try {
        await processOutboxEvent(syntheticEvent, llm);
        if (dl._id) await markReplayed(String(dl._id));
        results.push({ id: String(dl._id), ok: true });
      } catch (err) {
        results.push({ id: String(dl._id), ok: false, error: (err as Error).message });
      }
    }

    return reply.send({ replayed: results.length, results });
  });

  /**
   * Slice 3: enqueues a batch sweep (Locked Contract #6) on the retention
   * worker's BullMQ queue instead of running it in the API process — the
   * API only ever orchestrates, per the same separation-of-processes
   * principle as the Consumer.
   */
  app.post("/admin/retention/run", async (req, reply) => {
    let tenantId: string;
    try {
      tenantId = resolveTenantFromAdminKey(req);
    } catch (err) {
      if (err instanceof UnauthorizedError) return reply.code(401).send({ error: err.message });
      throw err;
    }

    const job = await getRetentionQueue().add("manual-sweep", { tenantId });
    return reply.send({ queued: true, jobId: job.id });
  });

  /**
   * Demo-only: seeds a handful of customers with backdated order history
   * (a real win-back gap, not a hardcoded threshold) and immediately
   * enqueues the same batch sweep /admin/retention/run uses, so the
   * dashboard's "seed stale orders" button demonstrates the real retention
   * agent without waiting on its 24h schedule.
   */
  app.post("/admin/retention/seed-stale", async (req, reply) => {
    let tenantId: string;
    try {
      tenantId = resolveTenantFromAdminKey(req);
    } catch (err) {
      if (err instanceof UnauthorizedError) return reply.code(401).send({ error: err.message });
      throw err;
    }

    const seeded = await seedStaleOrders(tenantId);
    const job = await getRetentionQueue().add("manual-sweep", { tenantId });
    return reply.send({ seeded, queued: true, jobId: job.id });
  });

  /**
   * Demo-only: seeds one customer with a long lapse and a history of large
   * orders, biased toward the LLM recommending an offer that trips the
   * approval guardrail — for exercising the dashboard's pending-approval
   * card without waiting for a real customer to happen to need one. Not a
   * guarantee: the LLM still decides the offer itself (Locked Contract #10).
   */
  app.post("/admin/retention/seed-approval", async (req, reply) => {
    let tenantId: string;
    try {
      tenantId = resolveTenantFromAdminKey(req);
    } catch (err) {
      if (err instanceof UnauthorizedError) return reply.code(401).send({ error: err.message });
      throw err;
    }

    const seeded = await seedHighValueLapsedCustomer(tenantId);
    const job = await getRetentionQueue().add("manual-sweep", { tenantId });
    return reply.send({ seeded, queued: true, jobId: job.id });
  });

  /**
   * Retention approval-queue endpoints (Locked Contract #3). Gated by the
   * same per-tenant admin key as /admin/replay.
   */
  app.get("/admin/retention/pending", async (req, reply) => {
    let tenantId: string;
    try {
      tenantId = resolveTenantFromAdminKey(req);
    } catch (err) {
      if (err instanceof UnauthorizedError) return reply.code(401).send({ error: err.message });
      throw err;
    }

    const pending = await listPendingApprovals(tenantId);
    return reply.send({ pending });
  });

  app.post<{ Params: { id: string } }>("/admin/retention/:id/approve", async (req, reply) => {
    let tenantId: string;
    try {
      tenantId = resolveTenantFromAdminKey(req);
    } catch (err) {
      if (err instanceof UnauthorizedError) return reply.code(401).send({ error: err.message });
      throw err;
    }

    const ok = await approveDecision(tenantId, req.params.id);
    if (!ok) return reply.code(404).send({ error: "decision not found or not pending approval" });
    return reply.send({ approved: true });
  });

  app.post<{ Params: { id: string } }>("/admin/retention/:id/reject", async (req, reply) => {
    let tenantId: string;
    try {
      tenantId = resolveTenantFromAdminKey(req);
    } catch (err) {
      if (err instanceof UnauthorizedError) return reply.code(401).send({ error: err.message });
      throw err;
    }

    const ok = await rejectDecision(tenantId, req.params.id);
    if (!ok) return reply.code(404).send({ error: "decision not found or not pending approval" });
    return reply.send({ rejected: true });
  });

  /**
   * Slice 4 (subsystem D) — async crawl job + status endpoint per the
   * brief, reusing the same BullMQ/agent-decision-log/tenant plumbing as C
   * (design doc's platform-coherence framing, not a bounded-autonomy story
   * of its own — D has no approval queue).
   */
  app.post("/admin/audit/run", async (req, reply) => {
    let tenantId: string;
    try {
      tenantId = resolveTenantFromAdminKey(req);
    } catch (err) {
      if (err instanceof UnauthorizedError) return reply.code(401).send({ error: err.message });
      throw err;
    }

    const parsed = runAuditSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: "invalid audit request", details: parsed.error.issues });
    }

    const job = await getAuditQueue().add("crawl", { tenantId, url: parsed.data.url });
    return reply.send({ queued: true, jobId: job.id });
  });

  app.get<{ Params: { jobId: string } }>("/admin/audit/:jobId/status", async (req, reply) => {
    let tenantId: string;
    try {
      tenantId = resolveTenantFromAdminKey(req);
    } catch (err) {
      if (err instanceof UnauthorizedError) return reply.code(401).send({ error: err.message });
      throw err;
    }

    const job = await getAuditQueue().getJob(req.params.jobId);
    if (!job || job.data.tenantId !== tenantId) {
      return reply.code(404).send({ error: "audit job not found" });
    }

    const state = await job.getState();
    if (state !== "completed") {
      return reply.send({ state });
    }

    const decision = await getAuditDecision(tenantId, job.returnvalue as string);
    return reply.send({ state, decision });
  });
}

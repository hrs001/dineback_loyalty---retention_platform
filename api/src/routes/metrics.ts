import type { FastifyInstance } from "fastify";
import { getWebhookStats, getEventLagStats } from "../services/metrics.js";
import { resolveTenantFromAdminKey, UnauthorizedError } from "../services/tenantAuth.js";

/**
 * Slice 5's 2 visible metrics (design doc Observability section): webhook
 * success rate and event lag. Gated by the admin key like the other
 * operational endpoints — not tenant-scoped data exactly, but event lag
 * IS computed per-tenant, so it needs a resolved tenantId the same way
 * /admin/retention/* does.
 */
export function registerMetricsRoutes(app: FastifyInstance): void {
  app.get("/metrics", async (req, reply) => {
    let tenantId: string;
    try {
      tenantId = resolveTenantFromAdminKey(req);
    } catch (err) {
      if (err instanceof UnauthorizedError) return reply.code(401).send({ error: err.message });
      throw err;
    }

    const [webhook, eventLag] = await Promise.all([
      Promise.resolve(getWebhookStats()),
      getEventLagStats(tenantId),
    ]);

    return reply.send({ webhook, eventLag });
  });
}

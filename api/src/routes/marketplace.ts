import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createOrder } from "../services/orderIngestion.js";
import { verifyMarketplaceWebhook, UnauthorizedError } from "../services/tenantAuth.js";

/**
 * Marketplace's own payload shape (à la DoorDash/UberEats) — deliberately
 * different from the storefront channel's shape, per Slice 1's "distinct
 * payload shapes normalized to Order" requirement. Normalization happens
 * once, here, not scattered across the codebase.
 */
const marketplacePayloadSchema = z.object({
  order_id: z.string().min(1),
  customer: z.object({ external_id: z.string().min(1) }),
  line_items: z
    .array(
      z.object({
        title: z.string().min(1),
        unit_price_cents: z.number().int().positive(),
        quantity: z.number().int().positive(),
      })
    )
    .min(1),
});

export function registerMarketplaceRoutes(app: FastifyInstance): void {
  app.post<{ Params: { tenantId: string } }>(
    "/webhooks/marketplace/:tenantId",
    async (req: FastifyRequest<{ Params: { tenantId: string } }>, reply) => {
      const { tenantId } = req.params;
      const rawBody = (req as any).rawBody ?? "";

      try {
        verifyMarketplaceWebhook(tenantId, rawBody, req.headers["x-marketplace-signature"]);
      } catch (err) {
        if (err instanceof UnauthorizedError) return reply.code(401).send({ error: err.message });
        throw err;
      }

      const parsed = marketplacePayloadSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({ error: "invalid marketplace payload", details: parsed.error.issues });
      }

      const order = await createOrder({
        tenantId, // verified above — not merely path-supplied, see tenantAuth.ts
        customerId: parsed.data.customer.external_id,
        channel: "marketplace",
        externalOrderId: parsed.data.order_id,
        items: parsed.data.line_items.map((li) => ({
          name: li.title,
          price: li.unit_price_cents / 100,
          qty: li.quantity,
        })),
      });

      return reply.code(201).send({ order });
    }
  );
}

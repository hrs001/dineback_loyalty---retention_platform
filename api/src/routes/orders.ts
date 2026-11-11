import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createOrder, getOrderById, listOrders } from "../services/orderIngestion.js";
import { getLedgerForOrder, getMaterializedBalance } from "../services/loyaltyLedger.js";
import { getDecisionForOrder, getLatestDecisionForCustomer } from "../services/retentionAgent.js";
import {
  resolveTenantFromStorefrontKey,
  resolveTenantFromStorefrontKeyQuery,
  UnauthorizedError,
} from "../services/tenantAuth.js";
import { getDb } from "../lib/mongo.js";
import { logger } from "../lib/logger.js";

const createOrderSchema = z.object({
  customerId: z.string().min(1),
  items: z
    .array(
      z.object({
        name: z.string().min(1),
        price: z.number().positive(),
        qty: z.number().int().positive(),
      })
    )
    .min(1),
});

interface OrderThreadPayload {
  order: NonNullable<Awaited<ReturnType<typeof getOrderById>>>;
  ledger: Awaited<ReturnType<typeof getLedgerForOrder>>;
  decision: Awaited<ReturnType<typeof getDecisionForOrder>>;
  balance: number;
}

async function buildThread(tenantId: string, orderId: string): Promise<OrderThreadPayload | null> {
  const order = await getOrderById(tenantId, orderId);
  if (!order) return null;

  const [ledger, orderDecision, balance] = await Promise.all([
    getLedgerForOrder(tenantId, order._id),
    getDecisionForOrder(tenantId, order._id),
    getMaterializedBalance(tenantId, order.customerId),
  ]);
  // Falls back to the customer's latest decision only when this order has
  // none of its own — e.g. the scheduled batch sweep (runRetentionBatch)
  // evaluates a customer's whole history, not one triggering order, so its
  // decisions never carry an orderId. Never masks a real per-order decision:
  // once one exists for this order, it always wins over the fallback.
  const decision = orderDecision ?? (await getLatestDecisionForCustomer(tenantId, order.customerId));

  return { order, ledger, decision, balance };
}

export function registerOrderRoutes(app: FastifyInstance): void {
  // Storefront channel only in Slice 0 (Slice 1 adds marketplace/pos).
  app.post("/orders", async (req, reply) => {
    let tenantId: string;
    try {
      tenantId = resolveTenantFromStorefrontKey(req);
    } catch (err) {
      if (err instanceof UnauthorizedError) return reply.code(401).send({ error: err.message });
      throw err;
    }

    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: "invalid order payload", details: parsed.error.issues });
    }

    const order = await createOrder({
      tenantId,
      customerId: parsed.data.customerId,
      channel: "storefront",
      items: parsed.data.items,
    });

    return reply.code(201).send({ order });
  });

  // Orders table (dashboard): every order for this tenant, most recent
  // first. Same auth as everything else here — tenantId server-derived,
  // never trusted from a query param.
  app.get("/orders", async (req, reply) => {
    let tenantId: string;
    try {
      tenantId = resolveTenantFromStorefrontKey(req);
    } catch (err) {
      if (err instanceof UnauthorizedError) return reply.code(401).send({ error: err.message });
      throw err;
    }

    const orders = await listOrders(tenantId);
    return reply.send({ orders });
  });

  /**
   * Live counterpart to GET /orders — pushes the full recent-orders list
   * whenever anything changes for the tenant, same Change-Stream pattern
   * as the per-order thread WS below, just not scoped to one orderId.
   */
  app.get("/orders/feed/ws", { websocket: true }, (socket, req) => {
    let tenantId: string;
    try {
      tenantId = resolveTenantFromStorefrontKeyQuery(req);
    } catch (err) {
      socket.close(4401, err instanceof UnauthorizedError ? err.message : "unauthorized");
      return;
    }

    let closed = false;
    const push = async () => {
      try {
        const orders = await listOrders(tenantId);
        if (!closed) socket.send(JSON.stringify({ orders }));
      } catch (err) {
        logger.error({ err, tenantId }, "ws orders feed push failed");
      }
    };

    const db = getDb();
    const changeStream = db.watch(
      [{ $match: { "fullDocument.tenantId": tenantId, "ns.coll": "orders" } }],
      { fullDocument: "updateLookup" }
    );

    changeStream.on("change", () => void push());
    changeStream.on("error", (err) => logger.error({ err, tenantId }, "ws orders feed change stream error"));

    socket.on("close", () => {
      closed = true;
      void changeStream.close();
    });

    void push(); // initial snapshot
  });

  // Slice 0's "one dashboard view" — still available polled; Slice 2 adds
  // the WS route below as the live-push alternative.
  app.get<{ Params: { id: string } }>("/orders/:id/thread", async (req, reply) => {
    let tenantId: string;
    try {
      tenantId = resolveTenantFromStorefrontKey(req);
    } catch (err) {
      if (err instanceof UnauthorizedError) return reply.code(401).send({ error: err.message });
      throw err;
    }

    const thread = await buildThread(tenantId, req.params.id);
    if (!thread) return reply.code(404).send({ error: "order not found" });

    return reply.send(thread);
  });

  /**
   * Slice 2 live feed (Selective Expansion 1, moved here from Slice 0 per
   * the design doc's outside-voice revision). Pushes a fresh thread
   * snapshot whenever the order/ledger/decision state for this tenant
   * changes, instead of the dashboard polling every second.
   *
   * Auth: the storefront key travels as a `?key=` query param, not the
   * `x-storefront-key` header — browsers can't set custom headers during
   * the WS handshake. The lookup is identical (tenantId is still
   * server-resolved, never client-supplied), only the transport differs.
   */
  app.get<{ Params: { id: string } }>(
    "/orders/:id/thread/ws",
    { websocket: true },
    (socket, req) => {
      let tenantId: string;
      try {
        tenantId = resolveTenantFromStorefrontKeyQuery(req);
      } catch (err) {
        socket.close(4401, err instanceof UnauthorizedError ? err.message : "unauthorized");
        return;
      }

      const orderId = req.params.id;
      let closed = false;

      const push = async () => {
        try {
          const thread = await buildThread(tenantId, orderId);
          if (thread && !closed) socket.send(JSON.stringify(thread));
        } catch (err) {
          logger.error({ err, orderId }, "ws thread push failed");
        }
      };

      const db = getDb();
      const changeStream = db.watch(
        [
          {
            $match: {
              "fullDocument.tenantId": tenantId,
              "ns.coll": { $in: ["orders", "loyalty_ledger", "loyalty_balances", "agent_decisions"] },
            },
          },
        ],
        { fullDocument: "updateLookup" }
      );

      changeStream.on("change", () => void push());
      changeStream.on("error", (err) => logger.error({ err, orderId }, "ws change stream error"));

      socket.on("close", () => {
        closed = true;
        void changeStream.close();
      });

      void push(); // initial snapshot
    }
  );
}

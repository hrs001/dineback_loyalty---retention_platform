import { randomUUID } from "node:crypto";
import { MongoServerError } from "mongodb";
import { getDb, withTransaction } from "../lib/mongo.js";
import { logger } from "../lib/logger.js";
import type { Order, OrderItem, OutboxEvent } from "../models/types.js";

export interface CreateOrderInput {
  tenantId: string; // server-derived only — callers must use tenantAuth.ts
  customerId: string;
  channel: Order["channel"];
  items: OrderItem[];
  externalOrderId?: string; // Slice 1: marketplace/pos idempotency key
}

const DUPLICATE_KEY_ERROR = 11000;

/**
 * Writes the Order and its OutboxEvent in a single Mongo transaction —
 * the outbox pattern (design doc §A). A crash between "order accepted" and
 * "order routed to kitchen" can never silently drop an order: either both
 * documents commit, or neither does.
 *
 * Idempotent for channels that supply externalOrderId (Slice 1): a second
 * delivery of the same webhook hits the {tenantId, channel, externalOrderId}
 * unique index and this function returns the ALREADY-PERSISTED order instead
 * of throwing or creating a duplicate — the caller (route handler) always
 * gets a valid Order back either way.
 */
export async function createOrder(input: CreateOrderInput): Promise<Order> {
  const amount = input.items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const order: Order = {
    _id: randomUUID(),
    tenantId: input.tenantId,
    customerId: input.customerId,
    channel: input.channel,
    items: input.items,
    amount,
    status: "received",
    createdAt: new Date(),
    // Set only when provided — explicitly assigning `undefined` here gets
    // serialized as BSON null, which collides on the sparse
    // {tenantId, channel, externalOrderId} unique index for every second
    // storefront order in the same tenant. Omitting the key entirely keeps
    // the index truly sparse.
    ...(input.externalOrderId ? { externalOrderId: input.externalOrderId } : {}),
  };

  const db = getDb();
  try {
    await withTransaction(async (session) => {
      await db.collection<Order>("orders").insertOne(order, { session });
      const outboxEvent: OutboxEvent = {
        orderId: order._id,
        tenantId: order.tenantId,
        type: "order.completed",
        payload: order,
        createdAt: new Date(),
        processed: false,
      };
      await db.collection<OutboxEvent>("outbox_events").insertOne(outboxEvent, { session });
    });
    logger.info(
      { orderId: order._id, tenantId: order.tenantId, channel: order.channel },
      "outbox-write"
    );
  } catch (err) {
    if (
      input.externalOrderId &&
      err instanceof MongoServerError &&
      err.code === DUPLICATE_KEY_ERROR
    ) {
      const existing = await db.collection<Order>("orders").findOne({
        tenantId: input.tenantId,
        channel: input.channel,
        externalOrderId: input.externalOrderId,
      });
      if (existing) return existing;
    }
    throw err;
  }

  return order;
}

export async function getOrderById(tenantId: string, orderId: string): Promise<Order | null> {
  const db = getDb();
  // Locked Contract #9: tenantId always in the filter, never trusted from
  // the caller beyond what tenantAuth.ts already resolved.
  return db.collection<Order>("orders").findOne({ _id: orderId, tenantId });
}

/** Powers the dashboard's orders table — most recent first, capped so a busy tenant can't return an unbounded page. */
export async function listOrders(tenantId: string, limit = 50): Promise<Order[]> {
  const db = getDb();
  return db
    .collection<Order>("orders")
    .find({ tenantId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

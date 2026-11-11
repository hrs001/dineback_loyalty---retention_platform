import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectMongo, disconnectMongo, getDb } from "../lib/mongo.js";
import { startConsumer } from "../services/consumer.js";
import { appendEarnEntry, getLedgerForOrder, getMaterializedBalance } from "../services/loyaltyLedger.js";
import type { Order, OutboxEvent } from "../models/types.js";
import { fakeLLM } from "./helpers/fakeLLM.js";

const TENANT = "rest_demo";

function fakeOrder(id: string): Order {
  return {
    _id: id,
    tenantId: TENANT,
    customerId: `cust_${id}`,
    channel: "storefront",
    items: [{ name: "Item", price: 12, qty: 1 }],
    amount: 12,
    status: "received",
    createdAt: new Date(Date.now() - 5000), // written well before this "restart"
  };
}

describe("Slice 5: consumer restart recovers already-written, unprocessed events", () => {
  beforeAll(async () => {
    await connectMongo();
  });

  afterAll(async () => {
    await disconnectMongo();
  });

  beforeEach(async () => {
    const db = getDb();
    await db.collection("orders").deleteMany({});
    await db.collection("outbox_events").deleteMany({});
    await db.collection("loyalty_ledger").deleteMany({});
  });

  it("processes a backlog event that was written before the consumer started watching (simulates a crash-then-restart)", async () => {
    const db = getDb();
    const order = fakeOrder("order_backlog_1");
    await db.collection<Order>("orders").insertOne(order);
    const event: OutboxEvent = {
      orderId: order._id,
      tenantId: order.tenantId,
      type: "order.completed",
      payload: order,
      createdAt: order.createdAt,
      processed: false,
    };
    await db.collection<OutboxEvent>("outbox_events").insertOne(event);

    // Real production backlog events are seconds/minutes old by the time a
    // restart happens — this short wait keeps the test honest to that (the
    // document's `createdAt` field is backdated above, but the *actual*
    // Mongo insert just happened; without this gap the live change stream
    // would race the backlog sweep for this same very-recent real insert).
    await new Promise((r) => setTimeout(r, 50));

    // A fresh startConsumer() call is exactly what happens when the
    // process restarts after being kill -9'd mid-processing — a plain
    // change-stream watch (no resume token) would never see this insert
    // again since it happened in the past, before this new watch starts.
    const llm = fakeLLM();
    const spy = vi.spyOn(llm, "generateJSON");
    const changeStream = await startConsumer(llm);
    await changeStream.close();
    expect(spy).toHaveBeenCalledTimes(1);

    const ledger = await getLedgerForOrder(TENANT, order._id);
    expect(ledger).toHaveLength(1);

    const routedOrder = await db.collection<Order>("orders").findOne({ _id: order._id });
    expect(routedOrder?.status).toBe("routed");
  });

  it("does not reprocess an event already marked processed", async () => {
    const db = getDb();
    const order = fakeOrder("order_backlog_2");
    await db.collection<Order>("orders").insertOne({ ...order, status: "routed" });
    const event: OutboxEvent = {
      orderId: order._id,
      tenantId: order.tenantId,
      type: "order.completed",
      payload: order,
      createdAt: order.createdAt,
      processed: true,
      processedAt: new Date(),
    };
    await db.collection<OutboxEvent>("outbox_events").insertOne(event);

    const llm = fakeLLM();
    const spy = vi.spyOn(llm, "generateJSON");
    const changeStream = await startConsumer(llm);
    await changeStream.close();

    expect(spy).not.toHaveBeenCalled();
  });

  it("a kill AFTER the ledger write but BEFORE the LLM call completes does not double the ledger entry on restart (live-verified 2026-09-03: this exact sequence duplicated a real order's points before this fix)", async () => {
    const db = getDb();
    const order = fakeOrder("order_backlog_3");
    await db.collection<Order>("orders").insertOne(order);
    const event: OutboxEvent = {
      orderId: order._id,
      tenantId: order.tenantId,
      type: "order.completed",
      payload: order,
      createdAt: order.createdAt,
      processed: false,
    };
    await db.collection<OutboxEvent>("outbox_events").insertOne(event);

    // Simulates the first attempt getting exactly as far as the ledger
    // write (processOnce's first step) before being kill -9'd — the
    // outbox event is still processed:false, exactly like a real crash
    // mid-way through processOnce.
    await appendEarnEntry(order);

    await new Promise((r) => setTimeout(r, 50));
    const changeStream = await startConsumer(fakeLLM());
    await changeStream.close();

    const ledger = await getLedgerForOrder(TENANT, order._id);
    expect(ledger).toHaveLength(1);
    expect(await getMaterializedBalance(TENANT, order.customerId)).toBe(12);
  });
});

import { afterAll, beforeAll, describe, expect, it, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { connectMongo, disconnectMongo, getDb, withTransaction } from "../lib/mongo.js";
import { createOrder, getOrderById } from "../services/orderIngestion.js";
import type { Order, OutboxEvent } from "../models/types.js";
import { appendEarnEntry, getLedgerForOrder, getBalance } from "../services/loyaltyLedger.js";
import { getLatestDecisionForCustomer } from "../services/retentionAgent.js";
import { processOutboxEvent } from "../services/consumer.js";
import { fakeLLM } from "./helpers/fakeLLM.js";

/**
 * Verifies T6-adjacent Slice 0 requirement: "Order model + outbox write,
 * loyalty transaction log, one proven E2E thread." Requires a real Mongo
 * replica set (transactions need one) — run `docker compose up mongo` or
 * the full stack before `npm run test`.
 */
describe("Slice 0: walking skeleton E2E thread", () => {
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
    await db.collection("agent_decisions").deleteMany({});
  });

  it("writes Order + OutboxEvent in the same transaction", async () => {
    const order = await createOrder({
      tenantId: "rest_demo",
      customerId: "cust_1",
      channel: "storefront",
      items: [{ name: "Burger", price: 12, qty: 1 }],
    });

    expect(order.amount).toBe(12);
    expect(order.status).toBe("received");

    const db = getDb();
    const outboxEvent = await db.collection("outbox_events").findOne({ orderId: order._id });
    expect(outboxEvent).not.toBeNull();
    expect(outboxEvent?.processed).toBe(false);
  });

  it("processing the outbox event appends a ledger entry and a canned decision", async () => {
    const order = await createOrder({
      tenantId: "rest_demo",
      customerId: "cust_2",
      channel: "storefront",
      items: [{ name: "Pizza", price: 20, qty: 1 }],
    });

    const db = getDb();
    const outboxEvent = await db.collection("outbox_events").findOne({ orderId: order._id });
    expect(outboxEvent).not.toBeNull();

    await processOutboxEvent(outboxEvent as unknown as OutboxEvent, fakeLLM());

    const ledger = await getLedgerForOrder(order.tenantId, order._id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].type).toBe("earn");
    expect(ledger[0].points).toBe(20);

    const balance = await getBalance(order.tenantId, order.customerId);
    expect(balance).toBe(20);

    const decision = await getLatestDecisionForCustomer(order.tenantId, order.customerId);
    expect(decision).not.toBeNull();
    expect(decision?.agentType).toBe("retention");

    const routedOrder = await getOrderById(order.tenantId, order._id);
    expect(routedOrder?.status).toBe("routed");
  });

  it("append-only ledger has no update/delete path — balance is always a derived sum", async () => {
    const orderA = await createOrder({
      tenantId: "rest_demo",
      customerId: "cust_3",
      channel: "storefront",
      items: [{ name: "Salad", price: 8, qty: 2 }],
    });
    const orderB = await createOrder({
      tenantId: "rest_demo",
      customerId: "cust_3",
      channel: "storefront",
      items: [{ name: "Soup", price: 6, qty: 1 }],
    });
    await appendEarnEntry(orderA);
    await appendEarnEntry(orderB);

    const balance = await getBalance(orderA.tenantId, orderA.customerId);
    expect(balance).toBe(22); // 16 (orderA) + 6 (orderB) — two distinct orders' earns summed

    // Slice 5 fix: appendEarnEntry is idempotent per order — a retry/
    // restart reprocessing the SAME order's still-unprocessed outbox event
    // must never double it (verified live: this exact sequence used to
    // duplicate a real order's points before the fix).
    await appendEarnEntry(orderA);
    expect(await getBalance(orderA.tenantId, orderA.customerId)).toBe(22);
  });

  it("T6 — outbox transaction atomicity: a failure mid-transaction leaves NEITHER document, never a partial write", async () => {
    const db = getDb();
    const order: Order = {
      _id: randomUUID(),
      tenantId: "rest_demo",
      customerId: "cust_atomicity",
      channel: "storefront",
      items: [{ name: "Suya", price: 10, qty: 1 }],
      amount: 10,
      status: "received",
      createdAt: new Date(),
    };

    // Simulates a crash between "order accepted" and "order routed" (the
    // design doc's own framing) by injecting a failure between the two
    // writes, inside the same transaction the real code path uses.
    await expect(
      withTransaction(async (session) => {
        await db.collection<Order>("orders").insertOne(order, { session });
        throw new Error("simulated crash mid-transaction");
        // eslint-disable-next-line no-unreachable
        await db.collection<OutboxEvent>("outbox_events").insertOne(
          {
            orderId: order._id,
            tenantId: order.tenantId,
            type: "order.completed",
            payload: order,
            createdAt: new Date(),
            processed: false,
          },
          { session }
        );
      })
    ).rejects.toThrow("simulated crash mid-transaction");

    const persistedOrder = await db.collection<Order>("orders").findOne({ _id: order._id });
    const persistedEvent = await db.collection<OutboxEvent>("outbox_events").findOne({
      orderId: order._id,
    });
    expect(persistedOrder).toBeNull();
    expect(persistedEvent).toBeNull();
  });

  it("a second storefront order for the same tenant succeeds (externalOrderId is absent, not null, so the sparse idempotency index doesn't collide)", async () => {
    await createOrder({
      tenantId: "rest_demo",
      customerId: "cust_5",
      channel: "storefront",
      items: [{ name: "Item", price: 1, qty: 1 }],
    });
    const second = await createOrder({
      tenantId: "rest_demo",
      customerId: "cust_6",
      channel: "storefront",
      items: [{ name: "Item", price: 1, qty: 1 }],
    });
    expect(second.status).toBe("received");
  });

  it("tenant isolation: a different tenant cannot read another tenant's order", async () => {
    const order = await createOrder({
      tenantId: "rest_demo",
      customerId: "cust_4",
      channel: "storefront",
      items: [{ name: "Fries", price: 5, qty: 1 }],
    });

    const crossTenantRead = await getOrderById("rest_other", order._id);
    expect(crossTenantRead).toBeNull();
  });
});

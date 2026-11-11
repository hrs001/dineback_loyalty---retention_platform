import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { connectMongo, disconnectMongo, getDb } from "../lib/mongo.js";
import { sendToDeadLetter } from "../services/dlq.js";
import type { Order, OutboxEvent } from "../models/types.js";
import { fakeLLM } from "./helpers/fakeLLM.js";

const TENANT = "rest_demo";
const MARKETPLACE_SECRET = "dev-marketplace-secret"; // matches .env.example default
const ADMIN_KEY = "dev-admin-key"; // matches .env.example default

function signedPayload(body: object): { raw: string; signature: string } {
  const raw = JSON.stringify(body);
  const signature = createHmac("sha256", MARKETPLACE_SECRET).update(raw).digest("hex");
  return { raw, signature };
}

describe("Slice 1: marketplace channel, idempotency, DLQ + replay", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await connectMongo();
    app = await buildServer({ llm: fakeLLM() });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await disconnectMongo();
  });

  beforeEach(async () => {
    const db = getDb();
    await db.collection("orders").deleteMany({});
    await db.collection("outbox_events").deleteMany({});
    await db.collection("dead_letter_events").deleteMany({});
  });

  it("normalizes a marketplace payload into the canonical Order shape", async () => {
    const { raw, signature } = signedPayload({
      order_id: "mp_1001",
      customer: { external_id: "cust_mp_1" },
      line_items: [{ title: "Suya Platter", unit_price_cents: 2500, quantity: 2 }],
    });

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/marketplace/${TENANT}`,
      headers: { "content-type": "application/json", "x-marketplace-signature": signature },
      payload: raw,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.order.channel).toBe("marketplace");
    expect(body.order.customerId).toBe("cust_mp_1");
    expect(body.order.amount).toBe(50); // 2 * $25
    expect(body.order.externalOrderId).toBe("mp_1001");
  });

  it("duplicate webhook delivery (same order_id) is idempotent — no duplicate order", async () => {
    const payloadBody = {
      order_id: "mp_dup_1",
      customer: { external_id: "cust_mp_2" },
      line_items: [{ title: "Jollof", unit_price_cents: 1500, quantity: 1 }],
    };
    const { raw, signature } = signedPayload(payloadBody);

    const first = await app.inject({
      method: "POST",
      url: `/webhooks/marketplace/${TENANT}`,
      headers: { "content-type": "application/json", "x-marketplace-signature": signature },
      payload: raw,
    });
    const second = await app.inject({
      method: "POST",
      url: `/webhooks/marketplace/${TENANT}`,
      headers: { "content-type": "application/json", "x-marketplace-signature": signature },
      payload: raw,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().order._id).toBe(second.json().order._id); // same order, not a duplicate

    const db = getDb();
    const count = await db.collection("orders").countDocuments({ externalOrderId: "mp_dup_1" });
    expect(count).toBe(1);
  });

  it("rejects a webhook with an invalid signature", async () => {
    const { raw } = signedPayload({
      order_id: "mp_bad_sig",
      customer: { external_id: "cust_mp_3" },
      line_items: [{ title: "Item", unit_price_cents: 100, quantity: 1 }],
    });

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/marketplace/${TENANT}`,
      headers: { "content-type": "application/json", "x-marketplace-signature": "0".repeat(64) },
      payload: raw,
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects a webhook with no signature header at all", async () => {
    const { raw } = signedPayload({
      order_id: "mp_no_sig",
      customer: { external_id: "cust_mp_4" },
      line_items: [{ title: "Item", unit_price_cents: 100, quantity: 1 }],
    });

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/marketplace/${TENANT}`,
      headers: { "content-type": "application/json" },
      payload: raw,
    });

    expect(res.statusCode).toBe(401);
  });

  it("/admin/replay reprocesses a dead-lettered event and marks it replayed", async () => {
    const order: Order = {
      _id: "order_dlq_1",
      tenantId: TENANT,
      customerId: "cust_dlq_1",
      channel: "marketplace",
      externalOrderId: "mp_dlq_1",
      items: [{ name: "Item", price: 5, qty: 1 }],
      amount: 5,
      status: "received",
      createdAt: new Date(),
    };
    const event: OutboxEvent = {
      orderId: order._id,
      tenantId: order.tenantId,
      type: "order.completed",
      payload: order,
      createdAt: new Date(),
      processed: false,
    };
    // Order was never actually written to `orders` — simulates a
    // transient downstream failure that landed this event in the DLQ.
    await getDb().collection<Order>("orders").insertOne(order);
    await sendToDeadLetter(event, order, new Error("simulated transient failure"));

    const before = await getDb()
      .collection("dead_letter_events")
      .findOne({ "payload._id": order._id });
    expect(before?.replayed).toBe(false);

    const res = await app.inject({
      method: "POST",
      url: "/admin/replay",
      headers: { "x-admin-key": ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().replayed).toBe(1);
    expect(res.json().results[0].ok).toBe(true);

    const after = await getDb()
      .collection("dead_letter_events")
      .findOne({ "payload._id": order._id });
    expect(after?.replayed).toBe(true);

    const routedOrder = await getDb().collection<Order>("orders").findOne({ _id: order._id });
    expect(routedOrder?.status).toBe("routed");
  });

  it("/admin/replay is rejected without a valid admin key", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/replay" });
    expect(res.statusCode).toBe(401);
  });
});

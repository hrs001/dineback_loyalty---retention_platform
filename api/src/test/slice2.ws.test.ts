import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { connectMongo, disconnectMongo, getDb } from "../lib/mongo.js";
import { createOrder } from "../services/orderIngestion.js";
import { appendEarnEntry } from "../services/loyaltyLedger.js";

const TENANT = "rest_demo";
const STOREFRONT_KEY = "dev-storefront-key";

interface ThreadMessage {
  order: { _id: string };
  ledger: { points: number }[];
}

function nextMessage(ws: WebSocket): Promise<ThreadMessage> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
    ws.once("error", reject);
  });
}

describe("Slice 2: live order-thread WebSocket feed", () => {
  let app: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    await connectMongo();
    app = await buildServer();
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
    await disconnectMongo();
  });

  beforeEach(async () => {
    const db = getDb();
    await db.collection("orders").deleteMany({});
    await db.collection("loyalty_ledger").deleteMany({});
    await db.collection("loyalty_balances").deleteMany({});
    await db.collection("agent_decisions").deleteMany({});
  });

  it("pushes a fresh thread snapshot when the ledger changes, without polling", async () => {
    const order = await createOrder({
      tenantId: TENANT,
      customerId: "cust_ws_1",
      channel: "storefront",
      items: [{ name: "Item", price: 12, qty: 1 }],
    });

    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/orders/${order._id}/thread/ws?key=${STOREFRONT_KEY}`
    );
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    const initial = await nextMessage(ws);
    expect(initial.order._id).toBe(order._id);
    expect(initial.ledger).toHaveLength(0);

    await appendEarnEntry(order);

    const updated = await nextMessage(ws);
    expect(updated.ledger).toHaveLength(1);
    expect(updated.ledger[0].points).toBe(12);

    ws.close();
  });

  it("rejects a WS connection with no valid storefront key", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/orders/some-order/thread/ws`);
    const closeCode = await new Promise<number>((resolve) => {
      ws.once("close", (code) => resolve(code));
      ws.once("error", () => {
        /* some environments fire error before close on abrupt reset */
      });
    });
    expect(closeCode).toBe(4401);
  });
});

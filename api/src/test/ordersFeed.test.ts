import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { connectMongo, disconnectMongo, getDb } from "../lib/mongo.js";
import { createOrder } from "../services/orderIngestion.js";

const TENANT = "rest_demo";
const STOREFRONT_KEY = "dev-storefront-key";

describe("GET /orders — dashboard orders table", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await connectMongo();
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await disconnectMongo();
  });

  beforeEach(async () => {
    await getDb().collection("orders").deleteMany({});
  });

  it("rejects without a valid storefront key", async () => {
    const res = await app.inject({ method: "GET", url: "/orders" });
    expect(res.statusCode).toBe(401);
  });

  it("returns this tenant's orders, most recent first", async () => {
    const older = await createOrder({
      tenantId: TENANT,
      customerId: "cust_a",
      channel: "storefront",
      items: [{ name: "Item", price: 5, qty: 1 }],
    });
    await new Promise((r) => setTimeout(r, 5));
    const newer = await createOrder({
      tenantId: TENANT,
      customerId: "cust_b",
      channel: "storefront",
      items: [{ name: "Item", price: 9, qty: 1 }],
    });
    await createOrder({
      tenantId: "rest_other",
      customerId: "cust_c",
      channel: "storefront",
      items: [{ name: "Item", price: 100, qty: 1 }],
    });

    const res = await app.inject({
      method: "GET",
      url: "/orders",
      headers: { "x-storefront-key": STOREFRONT_KEY },
    });

    expect(res.statusCode).toBe(200);
    const { orders } = res.json();
    expect(orders).toHaveLength(2);
    expect(orders[0]._id).toBe(newer._id);
    expect(orders[1]._id).toBe(older._id);
  });
});

describe("GET /orders/feed/ws — live tenant-wide orders feed", () => {
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
    await getDb().collection("orders").deleteMany({});
  });

  it("pushes an initial snapshot, then a fresh one when a new order is created", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/orders/feed/ws?key=${STOREFRONT_KEY}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    const nextMessage = () =>
      new Promise<{ orders: { _id: string }[] }>((resolve, reject) => {
        ws.once("message", (data) => resolve(JSON.parse(data.toString())));
        ws.once("error", reject);
      });

    const initial = await nextMessage();
    expect(initial.orders).toHaveLength(0);

    const order = await createOrder({
      tenantId: TENANT,
      customerId: "cust_feed",
      channel: "storefront",
      items: [{ name: "Item", price: 7, qty: 1 }],
    });

    const updated = await nextMessage();
    expect(updated.orders.map((o) => o._id)).toContain(order._id);

    ws.close();
  });

  it("rejects a connection with no valid storefront key", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/orders/feed/ws`);
    const closeCode = await new Promise<number>((resolve) => {
      ws.once("close", (code) => resolve(code));
      ws.once("error", () => {
        /* some environments fire error before close on abrupt reset */
      });
    });
    expect(closeCode).toBe(4401);
  });
});

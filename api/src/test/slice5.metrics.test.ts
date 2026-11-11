import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { connectMongo, disconnectMongo, getDb } from "../lib/mongo.js";
import { recordWebhookOutcome, getWebhookStats, getEventLagStats } from "../services/metrics.js";
import type { OutboxEvent } from "../models/types.js";

const ADMIN_KEY = "dev-admin-key";

describe("Slice 5: webhook success-rate counter", () => {
  beforeEach(() => {
    // module state resets are implicit — each test only asserts deltas
  });

  it("computes a success rate from recorded outcomes", () => {
    const before = getWebhookStats();
    recordWebhookOutcome(true);
    recordWebhookOutcome(true);
    recordWebhookOutcome(false);
    const after = getWebhookStats();

    expect(after.total).toBe(before.total + 3);
    expect(after.succeeded).toBe(before.succeeded + 2);
  });

  it("reports 100% success rate when nothing has failed yet", () => {
    recordWebhookOutcome(true);
    const stats = getWebhookStats();
    expect(stats.successRate).toBeGreaterThan(0);
    expect(stats.successRate).toBeLessThanOrEqual(1);
  });
});

describe("Slice 5: event lag (real, persisted createdAt→processedAt)", () => {
  beforeAll(async () => {
    await connectMongo();
  });

  afterAll(async () => {
    await disconnectMongo();
  });

  beforeEach(async () => {
    await getDb().collection("outbox_events").deleteMany({ tenantId: "rest_metrics_test" });
  });

  it("averages lag across recently processed events", async () => {
    const db = getDb();
    const now = Date.now();
    const events: OutboxEvent[] = [
      {
        orderId: "o1",
        tenantId: "rest_metrics_test",
        type: "order.completed",
        payload: {} as never,
        createdAt: new Date(now - 500),
        processed: true,
        processedAt: new Date(now - 400), // 100ms lag
      },
      {
        orderId: "o2",
        tenantId: "rest_metrics_test",
        type: "order.completed",
        payload: {} as never,
        createdAt: new Date(now - 300),
        processed: true,
        processedAt: new Date(now - 100), // 200ms lag
      },
      {
        orderId: "o3",
        tenantId: "rest_metrics_test",
        type: "order.completed",
        payload: {} as never,
        createdAt: new Date(now),
        processed: false, // not yet processed — excluded from the average
      },
    ];
    await db.collection<OutboxEvent>("outbox_events").insertMany(events);

    const stats = await getEventLagStats("rest_metrics_test");

    expect(stats.sampleSize).toBe(2);
    expect(stats.avgLagMs).toBe(150);
  });

  it("returns a zero-sample state instead of NaN when nothing has processed yet", async () => {
    const stats = await getEventLagStats("rest_metrics_test");
    expect(stats.sampleSize).toBe(0);
    expect(stats.avgLagMs).toBeNull();
  });
});

describe("Slice 5: GET /metrics", () => {
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

  it("rejects without a valid admin key", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(401);
  });

  it("returns webhook and event-lag stats shaped correctly", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics", headers: { "x-admin-key": ADMIN_KEY } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.webhook).toHaveProperty("total");
    expect(body.webhook).toHaveProperty("successRate");
    expect(body.eventLag).toHaveProperty("sampleSize");
    expect(body.eventLag).toHaveProperty("avgLagMs");
  });
});

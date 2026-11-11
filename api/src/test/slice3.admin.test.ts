import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { connectMongo, disconnectMongo, getDb } from "../lib/mongo.js";
import { closeRetentionQueue } from "../lib/queue.js";
import type { AgentDecision } from "../models/types.js";

const TENANT = "rest_demo";
const ADMIN_KEY = "dev-admin-key";

describe("Slice 3: admin retention endpoints", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await connectMongo();
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closeRetentionQueue();
    await disconnectMongo();
  });

  beforeEach(async () => {
    await getDb().collection("agent_decisions").deleteMany({});
    await getDb().collection("orders").deleteMany({ tenantId: TENANT, customerId: /^cust_stale_demo_/ });
  });

  it("POST /admin/retention/seed-approval seeds a high-value, long-lapsed customer and rejects without a valid admin key", async () => {
    const unauthorized = await app.inject({ method: "POST", url: "/admin/retention/seed-approval" });
    expect(unauthorized.statusCode).toBe(401);

    const res = await app.inject({
      method: "POST",
      url: "/admin/retention/seed-approval",
      headers: { "x-admin-key": ADMIN_KEY },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.seeded).toBeGreaterThan(0);
    expect(body.queued).toBe(true);
    expect(body.jobId).toBeTruthy();

    const seededOrders = await getDb()
      .collection("orders")
      .find({ tenantId: TENANT, customerId: /^cust_stale_demo_approval_/ })
      .toArray();
    expect(seededOrders.length).toBe(body.seeded);
    // Biased hard toward tripping the guardrail: a long gap + a history of
    // large orders, not a guarantee (the LLM still decides offerType/offerValue itself).
    const totalSpend = seededOrders.reduce((sum, o) => sum + o.amount, 0);
    expect(totalSpend).toBeGreaterThan(300);
    const now = Date.now();
    for (const order of seededOrders) {
      const ageDays = (now - new Date(order.createdAt).getTime()) / (1000 * 60 * 60 * 24);
      expect(ageDays).toBeGreaterThan(100);
    }
  });

  it("POST /admin/retention/seed-stale inserts backdated orders and enqueues a batch job", async () => {
    const unauthorized = await app.inject({ method: "POST", url: "/admin/retention/seed-stale" });
    expect(unauthorized.statusCode).toBe(401);

    const res = await app.inject({
      method: "POST",
      url: "/admin/retention/seed-stale",
      headers: { "x-admin-key": ADMIN_KEY },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.seeded).toBeGreaterThan(0);
    expect(body.queued).toBe(true);
    expect(body.jobId).toBeTruthy();

    const seededOrders = await getDb()
      .collection("orders")
      .find({ tenantId: TENANT, customerId: /^cust_stale_demo_/ })
      .toArray();
    expect(seededOrders.length).toBe(body.seeded);
    const now = Date.now();
    for (const order of seededOrders) {
      const ageDays = (now - new Date(order.createdAt).getTime()) / (1000 * 60 * 60 * 24);
      expect(ageDays).toBeGreaterThan(20); // genuinely stale, not "just placed"
    }
  });

  it("POST /admin/retention/run enqueues a batch job and rejects without a valid admin key", async () => {
    const unauthorized = await app.inject({ method: "POST", url: "/admin/retention/run" });
    expect(unauthorized.statusCode).toBe(401);

    const res = await app.inject({
      method: "POST",
      url: "/admin/retention/run",
      headers: { "x-admin-key": ADMIN_KEY },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().queued).toBe(true);
    expect(res.json().jobId).toBeTruthy();
  });

  it("GET /admin/retention/pending lists only this tenant's pending-approval decisions", async () => {
    const pendingDecision: AgentDecision = {
      tenantId: TENANT,
      agentType: "retention",
      timestamp: new Date(),
      payload: {
        customerId: "cust_pending",
        action: "send",
        tone: "urgency",
        offerType: "percent_off",
        offerValue: 40,
        requiresApproval: true,
      },
      reasoning: "test fixture",
      status: "pending_approval",
    };
    const otherTenantDecision: AgentDecision = { ...pendingDecision, tenantId: "rest_other" };
    await getDb().collection("agent_decisions").insertMany([pendingDecision, otherTenantDecision]);

    const res = await app.inject({
      method: "GET",
      url: "/admin/retention/pending",
      headers: { "x-admin-key": ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const { pending } = res.json();
    expect(pending).toHaveLength(1);
    expect(pending[0].payload.customerId).toBe("cust_pending");
  });

  it("POST /admin/retention/:id/approve flips status to completed", async () => {
    const decision: AgentDecision = {
      tenantId: TENANT,
      agentType: "retention",
      timestamp: new Date(),
      payload: {
        customerId: "cust_approve",
        action: "send",
        tone: "casual",
        offerType: "free_item",
        offerValue: 20,
        requiresApproval: true,
      },
      reasoning: "test fixture",
      status: "pending_approval",
    };
    const { insertedId } = await getDb().collection<AgentDecision>("agent_decisions").insertOne(decision);

    const res = await app.inject({
      method: "POST",
      url: `/admin/retention/${insertedId}/approve`,
      headers: { "x-admin-key": ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().approved).toBe(true);

    const updated = await getDb().collection("agent_decisions").findOne({ _id: insertedId });
    expect(updated?.status).toBe("completed");
  });

  it("approve returns 404 for an unknown decision id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/retention/000000000000000000000000/approve",
      headers: { "x-admin-key": ADMIN_KEY },
    });
    expect(res.statusCode).toBe(404);
  });
});
